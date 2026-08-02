/**
 * The browser test harness.
 *
 * Playwright drives a real Chromium. The stub server runs in this process.
 *
 * Every assertion reads the state of the terminal object, never a glyph.
 * Font rasterization changes with the machine and the GPU, so an assertion on
 * a glyph is a flaky assertion. `web/src/main.ts` exposes `__pirate` for this
 * purpose. One coarse pixel count is the only exception, and it proves that
 * the canvas holds paint.
 *
 * The runner is `bun test`, not the Playwright runner. This machine has no
 * Node, and the Playwright runner needs Node: under bun it starts and then
 * hangs with no output. The Playwright browser API works under bun, so the
 * tests use the library and bun runs them.
 */

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { startStub, type Stub } from "./stub-server";

/** The shape that `web/src/main.ts` exposes on `globalThis.__pirate`. */
interface PirateGlobal {
  term: {
    cols: number;
    rows: number;
    buffer: {
      active: {
        cursorX: number;
        cursorY: number;
        length: number;
        getLine(
          index: number,
        ):
          | {
              translateToString(trim?: boolean): string;
              getCell(x: number): { getChars(): string } | undefined;
            }
          | undefined;
      };
    };
    renderer: { render(...args: unknown[]): void };
  };
  state: {
    connections: number;
    connected: boolean;
    exitStatus: number | null;
    resizeDebounceMs: number;
  };
}

type PirateWindow = { __pirate: PirateGlobal };

/** The background of the theme in `src/main.ts`, as red, green, blue. */
const BACKGROUND: [number, number, number] = [0x16, 0x16, 0x1e];

/** The escape character. Tests build VT sequences with it. */
export const ESC = "";

let browser: Browser | undefined;
let stub: Stub | undefined;

/**
 * Start the browser and the stub server.
 *
 * `tests/setup.ts` calls this once, before the first test file.
 */
export async function start(): Promise<Stub> {
  if (browser === undefined) {
    browser = await chromium.launch();
  }
  if (stub === undefined) {
    stub = startStub(`${import.meta.dir}/../dist`);
  }
  stub.reset();
  return stub;
}

/** Stop the browser and the stub server. */
export async function stop(): Promise<void> {
  await browser?.close();
  browser = undefined;
  stub?.stop();
  stub = undefined;
}

/** The stub server. Call `start` first. */
export function server(): Stub {
  if (stub === undefined) {
    throw new Error("call start() first");
  }
  return stub;
}

/**
 * Open a page on the stub and wait for the first socket.
 *
 * `viewport` sets the size of the window, which sets the size of the terminal.
 */
export async function openClient(options?: {
  viewport?: { width: number; height: number };
  waitForConnection?: boolean;
}): Promise<Page> {
  if (browser === undefined || stub === undefined) {
    throw new Error("call start() first");
  }
  const context = await browser.newContext({
    viewport: options?.viewport ?? { width: 1000, height: 600 },
  });
  const page = await context.newPage();
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      // eslint-disable-next-line no-console
      console.error(`browser error: ${message.text()}`);
    }
  });
  await page.goto(`${stub.url}/`);
  if (options?.waitForConnection !== false) {
    await page.waitForFunction(
      () => (globalThis as unknown as PirateWindow).__pirate?.state.connected === true,
    );
  }
  return page;
}

/** Open a client, run the body, then close the browser context. */
export async function withClient<T>(
  body: (page: Page) => Promise<T>,
  options?: Parameters<typeof openClient>[0],
): Promise<T> {
  const page = await openClient(options);
  try {
    return await body(page);
  } finally {
    await page.context().close();
  }
}

/** Poll `read` until `ok` accepts the value. Returns that value. */
export async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what = "condition",
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = await read();
  }
  return last;
}

/** Wait `ms` milliseconds. Used to prove that a quiet stream still paints. */
export function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Show a frame as hexadecimal pairs, for the test report. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

/** The frames the client sent that carry the given tag. */
export function framesWithTag(frames: Uint8Array[], tag: number): Uint8Array[] {
  return frames.filter((frame) => frame.length > 0 && frame[0] === tag);
}

/** The size of the terminal, in cells. */
export function size(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const term = (globalThis as unknown as PirateWindow).__pirate.term;
    return { cols: term.cols, rows: term.rows };
  });
}

/**
 * The text of one row of the viewport, with the trailing blanks removed.
 *
 * The normal buffer indexes the scrollback first, so the first row of the
 * viewport is at `length - rows`.
 */
export function viewportLine(page: Page, row: number): Promise<string> {
  return page.evaluate((y: number) => {
    const term = (globalThis as unknown as PirateWindow).__pirate.term;
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.length - term.rows + y)?.translateToString(true) ?? "";
  }, row);
}

/** Every row of the viewport, with the trailing blank rows removed. */
export async function viewportText(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => {
    const term = (globalThis as unknown as PirateWindow).__pirate.term;
    const buffer = term.buffer.active;
    const base = buffer.length - term.rows;
    const out: string[] = [];
    for (let y = 0; y < term.rows; y += 1) {
      out.push(buffer.getLine(base + y)?.translateToString(true) ?? "");
    }
    return out;
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * The characters of one cell of the viewport.
 *
 * A cell that no write has touched holds codepoint 0, and `getChars` gives an
 * empty string for it. A written blank gives a space.
 */
export function cellAt(page: Page, row: number, column: number): Promise<string> {
  return page.evaluate(
    ({ row: y, column: x }: { row: number; column: number }) => {
      const term = (globalThis as unknown as PirateWindow).__pirate.term;
      const buffer = term.buffer.active;
      return buffer.getLine(buffer.length - term.rows + y)?.getCell(x)?.getChars() ?? "";
    },
    { row, column },
  );
}

/** The position of the cursor in the viewport. */
export function cursor(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const buffer = (globalThis as unknown as PirateWindow).__pirate.term.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  });
}

/** The client state that `src/main.ts` exposes. */
export function clientState(page: Page): Promise<PirateGlobal["state"]> {
  return page.evaluate(() => ({
    ...(globalThis as unknown as PirateWindow).__pirate.state,
  }));
}

/** The text of the status line. */
export async function statusText(page: Page): Promise<string> {
  return (await page.textContent("#status")) ?? "";
}

/**
 * Count the canvas pixels of one row band that differ from the theme
 * background.
 *
 * This is the only pixel-level measurement. It proves that the canvas holds
 * paint. It makes no claim about the shape of any glyph.
 */
export function paintedPixels(page: Page, row: number): Promise<number> {
  return page.evaluate(
    ({ row: y, background }: { row: number; background: [number, number, number] }) => {
      const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        return -1;
      }
      const term = (globalThis as unknown as PirateWindow).__pirate.term;
      const height = canvas.height / term.rows;
      const data = context.getImageData(
        0,
        Math.floor(y * height),
        canvas.width,
        Math.floor(height),
      ).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - background[0]) > 8 ||
          Math.abs(data[i + 1] - background[1]) > 8 ||
          Math.abs(data[i + 2] - background[2]) > 8
        ) {
          count += 1;
        }
      }
      return count;
    },
    { row, background: BACKGROUND },
  );
}

/**
 * A cheap hash of every pixel of the canvas.
 *
 * A test compares two of these to learn whether the canvas changed. It never
 * compares a hash against a stored value, because rasterization differs
 * between machines.
 */
export function canvasSignature(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return -1;
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ data[i], 16777619);
      hash = Math.imul(hash ^ data[i + 1], 16777619);
      hash = Math.imul(hash ^ data[i + 2], 16777619);
    }
    return hash >>> 0;
  });
}

/**
 * Stop the paint loop of ghostty-web.
 *
 * The loop asks for the next frame from inside its own callback, so one
 * `cancelAnimationFrame` ends it. This is the negative control for risk 5: it
 * builds the stale screen on purpose and shows that the measurement above can
 * see one.
 */
export function stopRenderLoop(page: Page): Promise<void> {
  return page.evaluate(() => {
    const term = (globalThis as unknown as PirateWindow).__pirate.term as unknown as {
      animationFrameId?: number;
    };
    if (term.animationFrameId !== undefined) {
      cancelAnimationFrame(term.animationFrameId);
    }
  });
}

/**
 * Count the calls to the renderer over a quiet period.
 *
 * This is the measurement for risk 5. It shows whether ghostty-web paints on
 * its own after a burst of writes, or waits for another event.
 */
export async function countRenders(page: Page, ms: number): Promise<number> {
  return page.evaluate(async (duration: number) => {
    const renderer = (globalThis as unknown as PirateWindow).__pirate.term.renderer;
    const original = renderer.render.bind(renderer);
    let calls = 0;
    renderer.render = (...args: unknown[]): void => {
      calls += 1;
      original(...args);
    };
    await new Promise((resolve) => setTimeout(resolve, duration));
    delete (renderer as unknown as Record<string, unknown>).render;
    return calls;
  }, ms);
}
