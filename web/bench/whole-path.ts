/**
 * The instrument of the whole-path benchmark.
 *
 * `bench/instrument.ts` measures the browser alone, against the stub server of
 * `tests/stub-server.ts`. `bench/altscreen.spec.ts` and `bench/latency.spec.ts`
 * use it. Nothing there holds a real pirate process, so nothing there can hold
 * the whole path.
 *
 * This module joins the two halves. It starts a real pirate process through
 * `e2e/server.ts`, opens a real Chromium on it, and stamps five points of one
 * screen event on one clock, the clock of the page:
 *
 *   1. the send of the input frame on the WebSocket,
 *   2. the arrival of each server frame on the same socket,
 *   3. the parse of each frame inside `term.write`,
 *   4. the paint that follows the parse,
 *   5. every `resize` event of the window.
 *
 * Points 1 and 2 need a wrapper around `WebSocket` itself, and `src/main.ts`
 * keeps its socket in a closure. The wrapper therefore goes in with
 * `context.addInitScript`, before the page loads. That is the reason this
 * module opens its own browser context and does not call `newSession` of
 * `e2e/browser.ts`.
 *
 * The clock of the page cannot separate the child process from the server and
 * from the wire: the page sees one arrival, not three events.
 * `crates/pirate-bench/src/bin/bench_child.rs` measures the child on a bare
 * PTY, and `wireFloor` below measures the wire with a child that answers at
 * once. The two together split point 1 to point 2.
 */

import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from "playwright";
import { login, waitFor, viewportText } from "../e2e/browser";
import { startPirate, type Pirate } from "../e2e/server";

/** The directory that holds the child programs of the benchmark. */
const CHILDREN = path.resolve(import.meta.dir, "../../crates/pirate-bench/children");

/** The size of the window of every run. */
const VIEWPORT = { width: 1000, height: 600 };

/**
 * The Chromium flag that gives a software WebGL2 context.
 *
 * `tests/harness.ts` and `e2e/browser.ts` both hold this list, and each header
 * gives the reason. CAUTION: Do not add `--use-angle=swiftshader` or
 * `--use-gl=angle`. The paint then arrives after the read.
 */
const WEBGL_ARGS = ["--enable-unsafe-swiftshader"];

/**
 * The environment variable that selects the real GPU of the machine.
 *
 * With the variable unset, the launch options hold `WEBGL_ARGS` and nothing
 * else, and the browser is headless. That is the path of CI.
 *
 * With `PIRATE_GPU` set to `1`, the browser starts headed and without
 * `WEBGL_ARGS`. Only the exact value `1` selects that path. Every other value
 * keeps the default, so `PIRATE_GPU=0` gives the software rasterizer. A headed
 * Chromium takes the hardware graphics stack of the machine. Headless Chromium
 * reaches no GPU, so `WEBGL_ARGS` is the only way to a WebGL2 context there.
 *
 * The GPU path answers one question of this benchmark: how much of
 * `child + wire` is the software rasterizer. Read `child + wire` and the total.
 * Measured on an idle machine: 51.4 ms against 9.0 ms, and a total of 108.5 ms
 * against 66.8 ms.
 *
 * The `long task` row answers nothing here. It counts main thread time above a
 * 50 ms threshold, and the software rasterizer runs on the raster and
 * compositor threads. The row reads 0.0 ms on both paths on an idle machine.
 *
 * `main stall` supports the comparison and does not stand alone. `widestGap`
 * puts the window edges in its list of beats, so `main stall` is never larger
 * than `child + wire`.
 *
 * Use `renderer` below to read which stack ran.
 *
 * ```text
 * cd web && PIRATE_E2E=1 PIRATE_GPU=1 bun test ./bench/whole-path.e2e.ts --timeout 600000
 * ```
 *
 * `web/tests/harness.ts` and `web/e2e/browser.ts` hold a copy of this switch,
 * under the same name.
 */
const GPU_ENV = "PIRATE_GPU";

/** The launch options of the browser. `PIRATE_GPU` selects the GPU path. */
function launchOptions(): LaunchOptions {
  if (process.env[GPU_ENV] !== "1") {
    return { args: WEBGL_ARGS };
  }
  // `ignoreDefaultArgs` removes the copy of the flag that Playwright adds on
  // macOS. Without that removal, a machine with no usable GPU falls back to
  // SwiftShader and the run reports software numbers as GPU numbers.
  return {
    args: [],
    headless: false,
    ignoreDefaultArgs: WEBGL_ARGS,
  };
}

/**
 * The unmasked renderer string of the WebGL2 context of the page.
 *
 * The reader of a report needs this string. A run with `PIRATE_GPU` set that
 * gives a SwiftShader string ran on the software rasterizer, and its numbers
 * are software numbers.
 */
export async function renderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (gl === null) {
      return "no webgl2 context";
    }
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info === null) {
      return gl.getParameter(gl.RENDERER) as string;
    }
    return gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
  });
}

/** The three full-screen children of `crates/pirate-bench/children`. */
export type Child = "editor" | "pager" | "minimal";

/** The path of one full-screen child program. */
export function childPath(child: Child): string {
  return path.join(CHILDREN, `altscreen-${child}.sh`);
}

/** The path of the child that asks the terminal questions. */
export function queryChildPath(): string {
  return path.join(CHILDREN, "queries.sh");
}

/** Wait `ms` milliseconds. The absence of an answer has no event to wait for. */
export function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One frame on the socket, as the page saw it. */
interface Frame {
  /** `performance.now` of the page, in milliseconds. */
  t: number;
  /** The tag byte of the frame, or -1 when the frame is empty. */
  tag: number;
  /** The length of the frame, with the tag byte. */
  bytes: number;
  /** The first bytes of the frame, as hexadecimal pairs. */
  head: string;
  /** The last bytes of the frame, as hexadecimal pairs. */
  tail: string;
}

/** One call, as the instrument recorded it. */
interface Span {
  start: number;
  end: number;
}

/** Everything that the instrument holds on the page. */
export interface Wire {
  sends: Frame[];
  recvs: Frame[];
  resizes: number[];
  keys: number[];
  ticks: number[];
  writes: Span[];
  draws: Span[];
  renders: Span[];
  tasks: Span[];
}

/** The globals that the instrument reaches for. */
type WireWindow = {
  __pirateWire?: Wire;
  __pirate?: { term: unknown };
};

/**
 * Start a browser, a pirate process, and a page, and instrument the socket.
 *
 * The caller stops all three with `close`.
 */
export interface Join {
  context: BrowserContext;
  page: Page;
  server: Pirate;
  /** Every console error and every uncaught page error, in order. */
  errors: string[];
  close(): Promise<void>;
}

/**
 * The one browser of the file. It launches on the first call.
 *
 * One browser serves every test. A launch per test leaves the software WebGL2
 * stack of the run before it in memory, and a later `page.evaluate` then waits
 * with no timeout. Measured: five launches in one file, and the fourth test
 * never returned.
 */
let browser: Browser | undefined;

/** Close the browser of the file. The last test calls this. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

/** Open one real browser on one real pirate process, with the instrument in. */
export async function join(shell: string): Promise<Join> {
  const server = await startPirate({ shell });
  if (browser === undefined) {
    browser = await chromium.launch(launchOptions());
  }
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: VIEWPORT,
  });
  await context.addInitScript(installWire);
  // A headed browser asks for `/favicon.ico`, and the server answers 404. The
  // page then logs a console error, and the page has no icon to log it about.
  // `chrome-headless-shell` sends no such request, so the two paths differ
  // here and only here. This route makes them equal. It matches one URL, so
  // no other request goes through the interceptor.
  await context.route("**/favicon.ico", (route) =>
    route.fulfill({ status: 200, contentType: "image/x-icon", body: "" }),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });
  await page.goto(`${server.url}/`);
  await login(page, server.token);
  await waitFor(
    () => page.evaluate(() => (globalThis as unknown as WireWindow).__pirate !== undefined),
    (ready) => ready,
    "the client",
  );
  await instrumentTerminal(page);
  return {
    context,
    page,
    server,
    errors,
    async close(): Promise<void> {
      await context.close().catch(() => undefined);
      await server.stop();
    },
  };
}

/**
 * The init script. It runs in the page, before any script of the client.
 *
 * The wrapper adds its `message` listener inside the constructor, so that
 * listener runs before the `onmessage` handler that `src/main.ts` assigns
 * later. The stamp is therefore the arrival, not the end of the parse.
 */
function installWire(): void {
  /** The bytes of one frame that the record holds, as hexadecimal pairs. */
  const HEAD = 256;
  const hex = (view: Uint8Array): string =>
    Array.from(view)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  const head = (view: Uint8Array): string => hex(view.subarray(0, HEAD));
  // The last bytes matter as much as the first. A full-screen program puts its
  // question at the end of the frame that it writes before it waits, and a
  // frame above HEAD bytes hides that question from the head alone.
  const tail = (view: Uint8Array): string =>
    view.length <= HEAD ? "" : hex(view.subarray(view.length - HEAD));
  const record = {
    sends: [] as { t: number; tag: number; bytes: number; head: string; tail: string }[],
    recvs: [] as { t: number; tag: number; bytes: number; head: string; tail: string }[],
    resizes: [] as number[],
    keys: [] as number[],
    ticks: [] as number[],
    renders: [] as { start: number; end: number }[],
    tasks: [] as { start: number; end: number }[],
    writes: [] as { start: number; end: number }[],
    draws: [] as { start: number; end: number }[],
  };
  (globalThis as unknown as { __pirateWire: typeof record }).__pirateWire = record;

  const Native = globalThis.WebSocket;
  class Watched extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event: MessageEvent) => {
        const data: unknown = event.data;
        let bytes = 0;
        let tag = -1;
        let first = "";
        let last = "";
        if (data instanceof ArrayBuffer) {
          bytes = data.byteLength;
          if (bytes > 0) {
            const view = new Uint8Array(data);
            tag = view[0];
            first = head(view);
            last = tail(view);
          }
        }
        record.recvs.push({ t: performance.now(), tag, bytes, head: first, tail: last });
      });
    }

    // The signature of `send` takes a view on an ArrayBuffer and not a view on
    // a SharedArrayBuffer. `src/main.ts` sends the first form, so this wrapper
    // takes the parameter type of the method that it replaces.
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      let bytes = 0;
      let tag = -1;
      let first = "";
      let last = "";
      let view: Uint8Array | undefined;
      if (ArrayBuffer.isView(data)) {
        view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        view = new Uint8Array(data);
      }
      if (view !== undefined) {
        bytes = view.length;
        if (bytes > 0) {
          tag = view[0];
          first = head(view);
          last = tail(view);
        }
      }
      record.sends.push({ t: performance.now(), tag, bytes, head: first, tail: last });
      super.send(data);
    }
  }
  globalThis.WebSocket = Watched as unknown as typeof WebSocket;

  // Every task of the main thread above 50 ms. A gap between two beats with
  // no long task in it is a frame loop that the browser paused, and not a
  // main thread that ran something else.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record.tasks.push({ start: entry.startTime, end: entry.startTime + entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // The browser has no long task observer. The beats stay the measurement.
  }

  // A heartbeat on the animation frame. A gap between two beats is a main
  // thread that ran something else, and a socket message waits behind it.
  const beat = (): void => {
    record.ticks.push(performance.now());
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);

  globalThis.addEventListener("resize", () => {
    record.resizes.push(performance.now());
  });
  // The capture phase runs before the handler of the client, so this stamp is
  // the arrival of the key and not the end of its work.
  globalThis.addEventListener(
    "keydown",
    () => {
      record.keys.push(performance.now());
    },
    true,
  );
}

/**
 * Wrap `term.write` and `renderer.draw` so that each call records its span.
 *
 * The wrapped paint call is `draw` and never `render`. `bench/instrument.ts`
 * holds the measurement that gave that choice.
 */
function instrumentTerminal(page: Page): Promise<void> {
  return page.evaluate(() => {
    const scope = globalThis as unknown as WireWindow;
    const record = scope.__pirateWire;
    if (record === undefined || scope.__pirate === undefined) {
      throw new Error("the page carries no instrument");
    }
    const term = scope.__pirate.term as unknown as {
      write(data: Uint8Array): void;
      renderer: {
        draw(...args: unknown[]): void;
        render(...args: unknown[]): void;
        fit(...args: unknown[]): unknown;
      };
    };
    const write = term.write.bind(term);
    term.write = (data: Uint8Array): void => {
      const start = performance.now();
      write(data);
      record.writes.push({ start, end: performance.now() });
    };
    // `draw` is a method of the prototype, so it needs its receiver.
    const renderer = term.renderer;
    const draw = renderer.draw.bind(renderer);
    renderer.draw = (...args: unknown[]): void => {
      const start = performance.now();
      draw(...args);
      record.draws.push({ start, end: performance.now() });
    };
    // `render` submits the frame, and `fit` rebuilds the grid after a resize.
    // `bench/instrument.ts` measured `render` at 0.0 ms on a quiet stream, so
    // a large value here belongs to the rebuild that follows a resize.
    const render = renderer.render.bind(renderer);
    renderer.render = (...args: unknown[]): void => {
      const start = performance.now();
      render(...args);
      record.renders.push({ start, end: performance.now() });
    };
    const fit = renderer.fit.bind(renderer);
    renderer.fit = (...args: unknown[]): unknown => {
      const start = performance.now();
      const result = fit(...args);
      record.renders.push({ start, end: performance.now() });
      return result;
    };
  });
}

/** Forget every recorded span and every recorded frame. */
export function reset(page: Page): Promise<void> {
  return page.evaluate(() => {
    const record = (globalThis as unknown as WireWindow).__pirateWire;
    if (record !== undefined) {
      record.sends = [];
      record.recvs = [];
      record.resizes = [];
      record.keys = [];
      record.ticks = [];
      record.writes = [];
      record.draws = [];
      record.renders = [];
      record.tasks = [];
    }
  });
}

/** Everything that the instrument holds now. */
export function wire(page: Page): Promise<Wire> {
  return page.evaluate(() => {
    const record = (globalThis as unknown as WireWindow).__pirateWire;
    if (record === undefined) {
      throw new Error("the page carries no instrument");
    }
    return {
      sends: [...record.sends],
      recvs: [...record.recvs],
      resizes: [...record.resizes],
      keys: [...record.keys],
      ticks: [...record.ticks],
      writes: [...record.writes],
      draws: [...record.draws],
      renders: [...record.renders],
      tasks: [...record.tasks],
    };
  });
}

/** The stages of one screen event, in milliseconds. */
export interface Stages {
  /** The trigger to the send: the input path of the client, or the debounce. */
  client: number;
  /** The child, the server, and the wire: the send to the first frame. */
  childAndWire: number;
  /**
   * The largest gap between two animation frames inside `childAndWire`.
   *
   * The main thread of the page runs the animation frame and the socket
   * handler. A gap here is a main thread that ran something else, and the
   * answer of the server then waits in the queue.
   */
  stall: number;
  /** Time inside `renderer.render` and `renderer.fit`, inside `childAndWire`. */
  renderer: number;
  /** Time of every task above 50 ms of the main thread, inside `childAndWire`. */
  longTask: number;
  /**
   * Paint work of the browser inside `childAndWire`.
   *
   * The main thread of the page runs the paint and the socket handler. A paint
   * that runs while the answer is on the wire holds that answer in the queue,
   * and the delay then looks like server time. This value names that part.
   */
  blocked: number;
  /** The first frame to the end of the last parse: the burst of the child. */
  stream: number;
  /** Time inside `term.write`, added. This is the wasm VT parse. */
  parse: number;
  /** `stream` less `parse`: the time between two frames of one burst. */
  betweenFrames: number;
  /** The end of the last parse to the end of the paint. */
  paint: number;
  /** The three stages above, added. */
  total: number;
  /** Frames that the server sent. */
  frames: number;
  /** Bytes that the server sent, over every frame. */
  bytes: number;
  /** Dump frames that arrived. Each one is a dropped backlog. */
  dumps: number;
}

/**
 * Split one screen event into stages.
 *
 * `from` is the start of the event on the clock of the page: a key, or the
 * last resize event. `sendTag` is the tag of the frame that the client sends
 * for that event: 0x00 for input, 0x01 for a new size.
 *
 * The four stages do not overlap, and they add up to `total`. `parse` is a
 * part of `stream`, and the report gives it beside `stream`.
 *
 * The paint is the first `draw` that starts after the last parse ends. A draw
 * that was already running when the bytes arrived cannot hold them.
 */
export function stages(record: Wire, from: number, sendTag: number): Stages {
  const send = record.sends.find((frame) => frame.tag === sendTag && frame.t >= from);
  if (send === undefined) {
    throw new Error(`the client sent no frame with tag ${sendTag} after the trigger`);
  }
  const recvs = record.recvs.filter((frame) => frame.t >= send.t);
  if (recvs.length === 0) {
    throw new Error("no server frame arrived after the trigger");
  }
  const writes = record.writes.filter((span) => span.start >= send.t);
  if (writes.length === 0) {
    throw new Error("the client parsed nothing after the trigger");
  }
  const lastWrite = writes[writes.length - 1];
  const paint = record.draws.find((span) => span.start >= lastWrite.end);
  if (paint === undefined) {
    throw new Error("no paint followed the parse");
  }
  const parse = writes.reduce((sum, span) => sum + (span.end - span.start), 0);
  const childAndWire = recvs[0].t - send.t;
  const blocked = overlap(record.draws, send.t, recvs[0].t);
  const stream = lastWrite.end - recvs[0].t;
  return {
    client: send.t - from,
    childAndWire,
    stall: widestGap(record.ticks, send.t, recvs[0].t),
    renderer: overlap(record.renders, send.t, recvs[0].t),
    longTask: overlap(record.tasks, send.t, recvs[0].t),
    blocked,
    stream,
    parse,
    betweenFrames: stream - parse,
    paint: paint.end - lastWrite.end,
    total: paint.end - from,
    frames: recvs.length,
    bytes: recvs.reduce((sum, frame) => sum + frame.bytes, 0),
    dumps: recvs.filter((frame) => frame.tag === 0x01).length,
  };
}

/** The part of every span in `spans` that falls between `from` and `to`. */
function overlap(spans: Span[], from: number, to: number): number {
  return spans
    .filter((span) => span.end > from && span.start < to)
    .reduce((sum, span) => sum + (Math.min(span.end, to) - Math.max(span.start, from)), 0);
}

/**
 * The widest gap between two beats that touches the window `from` to `to`.
 *
 * The window edges count as beats, so a window with no beat in it gives its
 * own width.
 */
function widestGap(ticks: number[], from: number, to: number): number {
  const inside = ticks.filter((at) => at >= from && at <= to);
  const marks = [from, ...inside, to];
  let widest = 0;
  for (let index = 1; index < marks.length; index += 1) {
    widest = Math.max(widest, marks[index] - marks[index - 1]);
  }
  return widest;
}

/** The value at `fraction` of a sorted copy of `values`. */
export function quantile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round((sorted.length - 1) * fraction);
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

/** One row of a printed report. */
export interface Row {
  name: string;
  values: number[];
}

/** Print a table of medians and 95th percentiles. */
export function table(title: string, runs: number, rows: Row[]): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${title}, ${runs} runs`);
  lines.push("");
  lines.push(`${"stage".padEnd(24)}${"median".padStart(12)}${"p95".padStart(12)}`);
  for (const row of rows) {
    lines.push(
      row.name.padEnd(24) +
        `${quantile(row.values, 0.5).toFixed(1)} ms`.padStart(12) +
        `${quantile(row.values, 0.95).toFixed(1)} ms`.padStart(12),
    );
  }
  lines.push("");
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

/** Print one line of counts. */
export function counts(title: string, values: number[]): void {
  // eslint-disable-next-line no-console
  console.log(
    `${title.padEnd(24)}${String(Math.round(quantile(values, 0.5))).padStart(12)}` +
      `${String(Math.round(quantile(values, 0.95))).padStart(12)}`,
  );
}

/**
 * Print every frame of one event, with its offset from the trigger.
 *
 * A stage table gives the size of a gap. This trace gives the bytes on each
 * side of it, so the reader can name the sequence that the gap waits for.
 */
/** The bytes of one frame for the trace: the head, and the tail after it. */
function bytesOf(frame: Frame): string {
  return frame.tail === "" ? frame.head : `${frame.head}  ... tail: ${frame.tail}`;
}

export function trace(title: string, record: Wire, from: number): void {
  const lines: string[] = ["", `  ${title}`, ""];
  const events: { at: number; what: string; note: string }[] = [];
  for (const at of record.keys) {
    events.push({ at, what: "key", note: "" });
  }
  for (const frame of record.sends) {
    events.push({
      at: frame.t,
      what: `send ${frame.bytes} bytes`,
      note: bytesOf(frame),
    });
  }
  for (const frame of record.recvs) {
    events.push({
      at: frame.t,
      what: `recv ${frame.bytes} bytes`,
      note: bytesOf(frame),
    });
  }
  for (const span of record.tasks) {
    events.push({
      at: span.start,
      what: "long task",
      note: `${(span.end - span.start).toFixed(1)} ms`,
    });
  }
  for (const span of record.writes) {
    events.push({
      at: span.start,
      what: "term.write",
      note: `${(span.end - span.start).toFixed(1)} ms`,
    });
  }
  events.sort((a, b) => a.at - b.at);
  for (const event of events) {
    lines.push(
      `${(event.at - from).toFixed(1).padStart(9)} ms  ${event.what.padEnd(18)}${event.note}`,
    );
  }
  lines.push("");
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

/** Wait until every row of the viewport satisfies `ok`. */
export function waitForScreen(
  page: Page,
  ok: (lines: string[]) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<string[]> {
  return waitFor(() => viewportText(page), ok, what, timeoutMs);
}

/** Wait until the client sent a frame with `tag`. */
export async function waitForSend(page: Page, tag: number): Promise<void> {
  await waitFor(
    async () => {
      const record = await wire(page);
      return record.sends.some((frame) => frame.tag === tag);
    },
    (sent) => sent,
    `a frame with tag ${tag}`,
  );
}

/**
 * Wait for `minFrames` frames, and then for `quietMs` with no frame.
 *
 * The frame count is not optional. Without it the wait ends at once on an
 * empty record, and the caller then reads the record before the answer of the
 * server arrives.
 */
export async function waitForQuiet(
  page: Page,
  quietMs: number,
  minFrames = 1,
): Promise<void> {
  await waitFor(
    async () => {
      const record = await wire(page);
      const last = record.recvs[record.recvs.length - 1];
      if (last === undefined || record.recvs.length < minFrames) {
        return -1;
      }
      const now = await page.evaluate(() => performance.now());
      return now - last.t;
    },
    (idle) => idle >= quietMs,
    "a quiet socket",
  );
}
