/**
 * The latency instrument for the browser half of the measurements.
 *
 * A screen event costs three things in the browser: the parse inside
 * `term.write`, the wait for the next animation frame, and the paint itself.
 * This file records all three, in the page, with `performance.now`. A
 * measurement taken from the test process instead would carry the round trip of
 * the browser protocol, which is larger than the values it would report.
 *
 * `../tests/harness.ts` holds the parts that every browser test shares. Nothing
 * in this directory belongs to the functional tests, and nothing there imports
 * from here.
 */

import type { Page } from "playwright";
import { idle } from "../tests/harness";

/** One call, as the instrument records it. */
interface Span {
  start: number;
  end: number;
}

/** One paint, with the count of rows that it wrote. */
interface DrawSpan extends Span {
  /**
   * Rows that this paint wrote.
   *
   * `draw` of `src/render/index.ts` returns after a check when no row is
   * dirty, and `lastDrawnRows` is then empty. A row count of 0 is therefore a
   * frame of the loop, not a paint of the screen.
   */
  rows: number;
}

/** One `0x01` resize frame, as the client put it on the socket. */
interface ResizeSend {
  at: number;
  cols: number;
  rows: number;
}

/** The record that the instrument keeps on the page. */
interface LatencyRecord {
  writes: Span[];
  draws: DrawSpan[];
  /** The time of each size change of the terminal container. */
  resizes: number[];
  /** The time of each `fit` call of the renderer. */
  fits: Span[];
  /** Each resize frame that the client sent. */
  sends: ResizeSend[];
  /** The time that each server frame reached the socket of the page. */
  arrivals: number[];
}

/** The latency budget of one screen event, in milliseconds. */
export interface Budget {
  /** Bytes of the event. */
  bytes: number;
  /** Time inside `term.write`. This is the parse. */
  parseMs: number;
  /** Time from the end of the parse to the start of the next paint. */
  waitMs: number;
  /** Time inside the paint that follows the parse. */
  drawMs: number;
  /** The three above, added: the whole client-side cost of the event. */
  totalMs: number;
  /** Paints that ran between the parse and the paint that this row reports. */
  drawsBefore: number;
}

/**
 * The globals of the page that the instrument reaches for.
 *
 * `__pirate` is the handle that `main.ts` publishes for the tests, and
 * `__pirateLatency` is the record that this file adds beside it.
 */
type LatencyWindow = {
  __pirate: { term: unknown };
  __pirateLatency?: LatencyRecord;
};

/**
 * Wrap `term.write` and `renderer.draw` so that each call records its span.
 *
 * The wrapped paint call is `draw`, never `render`. `draw` of
 * `src/render/index.ts` holds the paint work: it reads the cells of the dirty
 * rows, it builds the batch, and it presents the canvas. `render` only submits
 * the frame that `draw` already built, and its cost does not follow the cell
 * count. Measurement, in Chromium with `--enable-unsafe-swiftshader`: 69 by 25
 * gave a `draw` median of 0.100 ms and a `render` median of 0.000 ms, 109 by 38
 * gave 0.100 ms and 0.000 ms, and 176 by 58 gave 0.600 ms and 0.000 ms.
 *
 * CAUTION: Do not point this wrapper back at `render`. Every paint span then
 * reads 0.00 ms, and the scaling test of `latency.spec.ts` fails.
 *
 * Call this once per page, before the first measured event.
 *
 * The instrument also records the three events that a resize needs: each size
 * change of the container, each `fit` of the renderer, and each `0x01` resize
 * frame on the socket. All four clocks are `performance.now` of the page, so
 * the stages of a resize subtract from each other without a correction.
 */
export function instrument(page: Page): Promise<void> {
  return page.evaluate(() => {
    const scope = globalThis as unknown as LatencyWindow;
    if (scope.__pirateLatency !== undefined) {
      return;
    }
    const record: LatencyRecord = {
      writes: [],
      draws: [],
      resizes: [],
      fits: [],
      sends: [],
      arrivals: [],
    };
    scope.__pirateLatency = record;

    const term = scope.__pirate.term as unknown as {
      write(data: Uint8Array): void;
      renderer: {
        draw(...args: unknown[]): void;
        fit(...args: unknown[]): unknown;
        readonly lastDrawnRows: readonly number[];
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
      record.draws.push({ start, end: performance.now(), rows: renderer.lastDrawnRows.length });
    };

    // `fit` is the first call of `applyFit` of `src/main.ts`, so its start is
    // the end of the debounce wait. The wrapper gives the result back, because
    // `applyFit` reads the cols and the rows from it.
    const fit = renderer.fit.bind(renderer);
    renderer.fit = (...args: unknown[]): unknown => {
      const start = performance.now();
      const result = fit(...args);
      record.fits.push({ start, end: performance.now() });
      return result;
    };

    // The client holds its socket in a closure, so the wrapper goes on the
    // prototype. A `0x01` frame is 5 bytes: the tag, a `u16` cols, and a
    // `u16` rows, big-endian.
    //
    // The first send also gives the socket itself, and the wrapper takes the
    // `onmessage` of the client from it. That wrapper records the arrival of a
    // server frame before `term.write` runs, so the wire time and the parse
    // stay apart.
    const socket = WebSocket.prototype;
    const send = socket.send;
    let hooked: WebSocket | undefined;
    socket.send = function (data: Parameters<WebSocket["send"]>[0]): void {
      if (data instanceof Uint8Array && data.length === 5 && data[0] === 0x01) {
        record.sends.push({
          at: performance.now(),
          cols: (data[1] << 8) | data[2],
          rows: (data[3] << 8) | data[4],
        });
      }
      if (hooked !== this) {
        hooked = this;
        const onMessage = this.onmessage;
        this.onmessage = function (event: MessageEvent): void {
          record.arrivals.push(performance.now());
          onMessage?.call(this, event);
        };
      }
      send.call(this, data);
    };

    // The product observer of `src/main.ts` watches the same element. This one
    // adds no fit; it records the time of the event alone.
    new ResizeObserver(() => {
      record.resizes.push(performance.now());
    }).observe(document.getElementById("terminal") as Element);
  });
}

/** Forget every recorded span. Call this before each measured event. */
export function resetTimings(page: Page): Promise<void> {
  return page.evaluate(() => {
    const record = (globalThis as unknown as LatencyWindow).__pirateLatency;
    if (record !== undefined) {
      record.writes = [];
      record.draws = [];
      record.resizes = [];
      record.fits = [];
      record.sends = [];
      record.arrivals = [];
    }
  });
}

/** Read the record of the page. */
function readRecord(page: Page): Promise<LatencyRecord> {
  return page.evaluate(() => {
    const value = (globalThis as unknown as LatencyWindow).__pirateLatency;
    return value === undefined
      ? { writes: [], draws: [], resizes: [], fits: [], sends: [], arrivals: [] }
      : value;
  });
}

/**
 * The budget of the event that the page just took.
 *
 * The parse is every `write` span, added. The paint is the first `draw` span
 * that starts after the last parse ends. A draw that was already running when
 * the bytes arrived cannot hold them, so it does not count.
 */
export async function budget(page: Page, bytes: number): Promise<Budget> {
  const record = await readRecord(page);
  if (record.writes.length === 0) {
    throw new Error("the instrument recorded no write");
  }
  const first = record.writes[0];
  const last = record.writes[record.writes.length - 1];
  const parseMs = record.writes.reduce((sum, span) => sum + (span.end - span.start), 0);

  const after = record.draws.filter((span) => span.start >= last.end);
  if (after.length === 0) {
    throw new Error("the instrument recorded no paint after the write");
  }
  const paint = after[0];
  return {
    bytes,
    parseMs,
    waitMs: paint.start - last.end,
    drawMs: paint.end - paint.start,
    totalMs: paint.end - first.start,
    drawsBefore: record.draws.filter(
      (span) => span.start >= first.start && span.start < last.end,
    ).length,
  };
}

/**
 * The median duration of a paint over a quiet period. This is the floor.
 *
 * The frame loop calls `draw` on every animation frame, so a quiet period still
 * records a span for each frame. A quiet `draw` finds no dirty row, so it reads
 * no cell and presents no canvas, and this value is the cost of that check.
 */
export async function idleDrawMs(page: Page, ms: number): Promise<number> {
  await resetTimings(page);
  await idle(ms);
  const record = await readRecord(page);
  const times = record.draws.map((span) => span.end - span.start).sort((a, b) => a - b);
  if (times.length === 0) {
    throw new Error("the instrument recorded no paint while the stream was quiet");
  }
  return times[Math.floor(times.length / 2)];
}

/**
 * The settle latency of one resize storm, split into stages.
 *
 * The stages are consecutive and they do not overlap. `debounceMs`,
 * `fitMs`, `roundTripMs`, `outputMs`, `waitMs`, and `drawMs` add up to
 * `settleMs`. `parseMs` is the part of `outputMs` that ran inside
 * `term.write`.
 */
export interface StormBudget {
  /** Size changes of the container during the storm. */
  resizeEvents: number;
  /** `0x01` frames that the client sent during the storm. */
  resizeFrames: number;
  /** Paints that wrote at least one row during the storm. */
  paints: number;
  /** Cols and rows of the last resize frame. */
  cols: number;
  rows: number;
  /** Bytes that the last redraw carried. The caller counts them. */
  bytes: number;
  /** Last size change to the `fit` that follows it. This is the debounce. */
  debounceMs: number;
  /** `fit` of the renderer, plus the resize of the VT and of the grid. */
  fitMs: number;
  /**
   * The resize frame to the arrival of the first frame of the redraw.
   *
   * This is the wire time and the work of the server. A stub answers in the
   * test process, so this value also carries the wait of that answer.
   */
  roundTripMs: number;
  /** The arrival of the first frame of the redraw to the end of the parse. */
  outputMs: number;
  /** Time inside `term.write` for that redraw. This is the wasm VT parse. */
  parseMs: number;
  /** The last byte of the redraw to the start of the paint that shows it. */
  waitMs: number;
  /** Time inside that paint. */
  drawMs: number;
  /** The last size change to the end of that paint. */
  settleMs: number;
  /** Paints between the last size change and the end of the debounce. */
  paintsDuringWait: number;
  /**
   * Animation frames that ran while `roundTripMs` ran.
   *
   * The frame loop of `src/terminal.ts` calls `draw` on every animation frame,
   * so this count says whether the main thread was free during the round trip.
   * A count near zero with a large `roundTripMs` means a blocked main thread,
   * not a slow wire.
   */
  tripFrames: number;
  /**
   * The resize frame to the next animation frame of the client.
   *
   * The frame loop of `src/terminal.ts` is unconditional, so this value is one
   * display frame on a client that has work-free main thread. A larger value
   * says that the resize itself holds the main thread, and every message that
   * arrives in that time waits behind it.
   */
  stallMs: number;
  /** The time of the last resize frame, on the clock of the page. */
  sendAt: number;
  /** The time that the answer of the server reached the page, same clock. */
  arrivalAt: number;
}

/**
 * The Unix time of the zero of `performance.now` in the page.
 *
 * Add this value to a time of `StormBudget` to compare it against `Date.now`
 * of the test process. Both clocks then read the same wall clock.
 */
export function timeOrigin(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin);
}

/**
 * The budget of the resize storm that the page just took.
 *
 * Call `resetTimings` before the storm. The measurement starts at the last
 * size change of the container, because a drag ends there. The last resize
 * frame is the frame that carries the final size, and every stage after it
 * belongs to the settle.
 */
export async function stormBudget(page: Page, bytes: number): Promise<StormBudget> {
  const record = await readRecord(page);
  if (record.resizes.length === 0) {
    throw new Error("the instrument recorded no size change");
  }
  if (record.sends.length === 0) {
    throw new Error("the instrument recorded no resize frame");
  }
  const lastResize = record.resizes[record.resizes.length - 1];
  const send = record.sends[record.sends.length - 1];

  const fits = record.fits.filter((span) => span.end <= send.at);
  if (fits.length === 0) {
    throw new Error("the instrument recorded no fit before the last resize frame");
  }
  const fit = fits[fits.length - 1];

  const writes = record.writes.filter((span) => span.start >= send.at);
  if (writes.length === 0) {
    throw new Error("the instrument recorded no output after the last resize frame");
  }
  const lastWrite = writes[writes.length - 1];

  const arrivals = record.arrivals.filter((at) => at >= send.at);
  if (arrivals.length === 0) {
    throw new Error("the instrument recorded no server frame after the last resize frame");
  }
  const firstArrival = arrivals[0];

  const paint = record.draws.find((span) => span.rows > 0 && span.start >= lastWrite.end);
  if (paint === undefined) {
    throw new Error("the instrument recorded no paint after the redraw");
  }

  return {
    resizeEvents: record.resizes.length,
    resizeFrames: record.sends.length,
    paints: record.draws.filter((span) => span.rows > 0).length,
    cols: send.cols,
    rows: send.rows,
    bytes,
    debounceMs: fit.start - lastResize,
    fitMs: send.at - fit.start,
    roundTripMs: firstArrival - send.at,
    outputMs: lastWrite.end - firstArrival,
    parseMs: writes.reduce((sum, span) => sum + (span.end - span.start), 0),
    waitMs: paint.start - lastWrite.end,
    drawMs: paint.end - paint.start,
    settleMs: paint.end - lastResize,
    paintsDuringWait: record.draws.filter(
      (span) => span.rows > 0 && span.start >= lastResize && span.start < fit.start,
    ).length,
    tripFrames: record.draws.filter((span) => span.start >= send.at && span.start < firstArrival)
      .length,
    stallMs: (record.draws.find((span) => span.start >= send.at)?.start ?? paint.start) - send.at,
    sendAt: send.at,
    arrivalAt: firstArrival,
  };
}

/** One recorded PTY byte stream from `crates/pirate-bench/fixtures`. */
export async function fixture(name: string): Promise<Uint8Array> {
  const path = `${import.meta.dir}/../../crates/pirate-bench/fixtures/${name}`;
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/** Split bytes into chunks of `size`, as a PTY read of that size would. */
export function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
  }
  return out;
}
