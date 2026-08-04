/**
 * The browser side of the end-to-end suite.
 *
 * One Chromium serves the whole file. Each test opens its own context, so the
 * cookie jar of one test never reaches the next one.
 *
 * The reading helpers are copies of the helpers in `web/tests/harness.ts`.
 * They are copies on purpose: that module starts the stub server when it is
 * imported, and the e2e suite must start nothing but the real server.
 *
 * Every assertion reads terminal state, never a glyph. Font rasterization
 * changes with the machine and the GPU, so an assertion on a glyph is a flaky
 * assertion. One coarse pixel count is the only exception, and it proves that
 * the canvas holds paint.
 *
 * The runner is `bun test`, not the Playwright runner. This machine has no
 * Node, and the Playwright runner needs Node: under bun it starts and then
 * hangs with no output. The Playwright browser API works under bun.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
} from "playwright";
import type { Pirate } from "./server";

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
        getLine(index: number): { translateToString(trim?: boolean): string } | undefined;
      };
    };
  };
  state: {
    connections: number;
    connected: boolean;
    exitStatus: number | null;
    resizeDebounceMs: number;
    fontSize: number;
    repeatRate: number;
    repeatDelayMs: number;
    mode: "dark" | "light";
    themeName: string;
    menu: "open" | "collapsed" | "hidden";
    keys: Record<string, string>;
  };
}

type PirateWindow = { __pirate?: PirateGlobal };

/** The background of the default dark theme, as red, green, blue. */
export const DARK_BACKGROUND: [number, number, number] = [0x16, 0x16, 0x1e];

/** The background of the default light theme, as red, green, blue. */
export const LIGHT_BACKGROUND: [number, number, number] = [0xff, 0xff, 0xff];

/** The size of every window of this suite, in pixels. */
const VIEWPORT = { width: 1000, height: 600 };

/** The poll interval of `waitFor`, in milliseconds. */
const POLL_MS = 25;

/**
 * The Chromium flag that gives a software WebGL2 context.
 *
 * Headless Chromium has no GPU. Chromium then refuses a WebGL context.
 * `getContext("webgl2")` gives null. This flag permits the SwiftShader
 * backend of ANGLE, which draws on the CPU.
 *
 * Playwright adds this flag on macOS only. Linux CI therefore gets no
 * software WebGL2 from the defaults. This list holds the flag for every
 * platform.
 *
 * CAUTION: Do not add `--use-angle=swiftshader` or `--use-gl=angle`. Each of
 * those flags moves the 2D canvas to SwiftShader as well. The paint of the
 * terminal canvas then arrives after the read. The paint assertions of this
 * suite then fail. The failure is intermittent.
 *
 * `web/tests/harness.ts` holds a copy of this list, for the reason in the
 * header of this file.
 */
const WEBGL_ARGS = ["--enable-unsafe-swiftshader"];

let browser: Browser | undefined;

/** The one browser of this file. It launches on the first call. */
async function getBrowser(): Promise<Browser> {
  if (browser === undefined) {
    browser = await chromium.launch({ args: WEBGL_ARGS });
  }
  return browser;
}

/** Close the browser. The last test of the file calls this. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

/** One open page, with the errors that it reported. */
export interface Session {
  page: Page;
  context: BrowserContext;
  /** Every console error and every uncaught page error, in order. */
  errors: string[];
}

/**
 * Open a page on `server`.
 *
 * The certificate is self-signed, so the context accepts it. A test that wants
 * the refusal of the browser uses `strictContext` instead.
 */
export async function newSession(server: Pirate): Promise<Session> {
  const context = await (
    await getBrowser()
  ).newContext({
    ignoreHTTPSErrors: true,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
  });
  await page.goto(`${server.url}/`);
  return { page, context, errors };
}

/**
 * Open a context that trusts no certificate.
 *
 * This is the negative control for the TLS test. A navigation to the
 * self-signed server must fail in this context.
 */
export async function strictContext(): Promise<BrowserContext> {
  return (await getBrowser()).newContext({ viewport: VIEWPORT });
}

/** Poll `read` until `ok` accepts the value. Returns that value. */
export async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what = "condition",
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!ok(last)) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${what}. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    last = await read();
  }
  return last;
}

/**
 * Read `value` every poll for `ms` milliseconds and report whether it stayed
 * false.
 *
 * This is the one helper of this suite that waits for a fixed time, and it is
 * the one case that needs it: the absence of an event has no condition to wait
 * for. A test uses it to prove that no reconnect and no exit happened.
 */
export async function staysFalse(
  read: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await read()) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

/**
 * Fill the token field and submit the login form.
 *
 * The submit button is one pixel wide and clipped, because `src/login.css`
 * keeps it in the DOM for the password manager and off the screen for the
 * operator. A real mouse click on it is therefore impossible: the token field
 * covers it. The operator submits with the Enter key, and so does this
 * function. The Enter key fires the same `submit` event as the button.
 */
export async function login(page: Page, token: string): Promise<void> {
  await page.fill("#login-token", token);
  await page.press("#login-token", "Enter");
}

/** Wait until the client reports an open socket. */
export async function waitForConnected(page: Page): Promise<void> {
  await waitFor(
    () =>
      page.evaluate(
        () => (globalThis as unknown as PirateWindow).__pirate?.state.connected === true,
      ),
    (open) => open,
    "an open socket",
  );
}

/** True while the client exposes `__pirate`. It appears after the login. */
export function clientReady(page: Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as unknown as PirateWindow).__pirate !== undefined);
}

/** The client state that `src/main.ts` exposes. */
export function clientState(page: Page): Promise<PirateGlobal["state"]> {
  return page.evaluate(() => ({
    ...(globalThis as unknown as PirateWindow).__pirate!.state,
  }));
}

/**
 * The text of one row of the viewport, with the trailing blanks removed.
 *
 * The normal buffer indexes the scrollback first, so the first row of the
 * viewport is at `length - rows`.
 */
export function viewportLine(page: Page, row: number): Promise<string> {
  return page.evaluate((y: number) => {
    const term = (globalThis as unknown as PirateWindow).__pirate!.term;
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.length - term.rows + y)?.translateToString(true) ?? "";
  }, row);
}

/** Every row of the viewport, with the trailing blank rows removed. */
export async function viewportText(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => {
    const term = (globalThis as unknown as PirateWindow).__pirate!.term;
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

/** Wait until the rows of the viewport satisfy `ok`. Returns those rows. */
export function waitForLine(
  page: Page,
  ok: (lines: string[]) => boolean,
  what = "a line",
  timeoutMs = 20_000,
): Promise<string[]> {
  return waitFor(() => viewportText(page), ok, what, timeoutMs);
}

/**
 * Count the canvas pixels of one row band that differ from a background color.
 *
 * A count against the wrong background counts the whole row, because one
 * background differs from the other on every pixel. A test that changed the
 * theme therefore passes the background of the new theme.
 *
 * This is the only pixel-level measurement. It proves that the canvas holds
 * paint. It makes no claim about the shape of any glyph.
 *
 * The read goes through `readPixels` of the WebGL2 context. A WebGL2 canvas
 * gives null for a 2D context. `src/render/index.ts` takes the context with
 * `preserveDrawingBuffer` set, so the paint of the last frame is still there
 * when this function runs, in a later task than the paint.
 *
 * The origin of `readPixels` is the bottom left corner, and the row index
 * counts from the top, so a band of `band` pixels starts at
 * `canvas.height - top - band`. The cell height comes from
 * `canvas.height / rows`, never from `devicePixelRatio`. The backing store
 * already carries that ratio.
 */
export function paintedPixels(
  page: Page,
  row: number,
  background: [number, number, number] = DARK_BACKGROUND,
): Promise<number> {
  return page.evaluate(
    ({ row: y, background: bg }: { row: number; background: [number, number, number] }) => {
      const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
      const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
      if (!canvas || !gl) {
        return -1;
      }
      const term = (globalThis as unknown as PirateWindow).__pirate!.term;
      const band = Math.floor(canvas.height / term.rows);
      if (band <= 0) {
        return -1;
      }
      const top = Math.floor(y * (canvas.height / term.rows));
      const bottom = canvas.height - top - band;
      if (bottom < 0 || top < 0) {
        return -1;
      }
      const data = new Uint8Array(canvas.width * band * 4);
      gl.readPixels(0, bottom, canvas.width, band, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - bg[0]) > 8 ||
          Math.abs(data[i + 1] - bg[1]) > 8 ||
          Math.abs(data[i + 2] - bg[2]) > 8
        ) {
          count += 1;
        }
      }
      return count;
    },
    { row, background },
  );
}

/**
 * A cheap hash of every pixel of the canvas.
 *
 * A test compares two of these to learn whether the canvas changed. It never
 * compares a hash against a stored value, because rasterization differs
 * between machines.
 *
 * The read goes through `readPixels`, for the reason in `paintedPixels`. This
 * function reads the whole canvas, so the origin of `readPixels` does not
 * change the result.
 */
export function canvasSignature(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
    const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!canvas || !gl) {
      return -1;
    }
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ data[i], 16777619);
      hash = Math.imul(hash ^ data[i + 1], 16777619);
      hash = Math.imul(hash ^ data[i + 2], 16777619);
    }
    return hash >>> 0;
  });
}

/** What a WebGL2 context of the page reports. */
export interface Webgl2Report {
  /** True when the canvas gave a WebGL2 context. */
  present: boolean;
  /** The `VERSION` parameter of the context, or an empty string. */
  version: string;
  /** The `RENDERER` parameter of the context, or an empty string. */
  renderer: string;
  /** True when the context reports a clear color that it kept. */
  usable: boolean;
}

/**
 * Ask the page for a WebGL2 context and report what it gives.
 *
 * The function adds its own canvas. `usable` clears the drawing buffer to a
 * known color and reads that color back. A clear of the terminal canvas would
 * remove the paint of the client, so the clear runs on a canvas of this
 * function alone. `terminalGlReport` reads the real terminal canvas and
 * writes nothing to it.
 *
 * `usable` runs one command and reads one value back. A stub that answers
 * every call with null cannot pass that step.
 *
 * CAUTION: The `finally` block below removes the canvas. A canvas that stays
 * in the body takes 32 pixels of the page height. `#terminal` then gets 16
 * pixels instead of 600, and the terminal starts with 1 row instead of 38. A
 * measurement of both paths gave those two row counts.
 */
export function webgl2Report(page: Page): Promise<Webgl2Report> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    document.body.appendChild(canvas);
    try {
      const gl = canvas.getContext("webgl2");
      if (gl === null) {
        return { present: false, version: "", renderer: "", usable: false };
      }
      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return {
        present: true,
        version: String(gl.getParameter(gl.VERSION) ?? ""),
        renderer: String(gl.getParameter(gl.RENDERER) ?? ""),
        usable:
          Math.abs(pixel[0] - 64) <= 2 &&
          Math.abs(pixel[1] - 128) <= 2 &&
          Math.abs(pixel[2] - 191) <= 2,
      };
    } finally {
      canvas.remove();
    }
  });
}

/** The size of the terminal, in cells. */
export function size(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const term = (globalThis as unknown as PirateWindow).__pirate!.term;
    return { cols: term.cols, rows: term.rows };
  });
}

/** Where the keyboard focus is. */
export interface FocusReport {
  /** The tag name of `document.activeElement`, or "none". */
  tag: string;
  /** The id of `document.activeElement`, or an empty string. */
  id: string;
  /** True when `document.activeElement` is inside `#terminal`. */
  inTerminal: boolean;
}

/**
 * Report the element that holds the keyboard focus.
 *
 * A test of the focus must never call `page.focus` first. That call sets the
 * state that the test measures, and the test then passes against a client
 * that gives the focus to nothing.
 *
 * `#terminal` holds a hidden text field, and `src/terminal.ts` gives the
 * focus to that field. `inTerminal` therefore reads the subtree and not the
 * id of one element.
 */
export function focusReport(page: Page): Promise<FocusReport> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? "none",
      id: element?.id ?? "",
      inTerminal: element?.closest("#terminal") != null,
    };
  });
}

/** What the canvas of the terminal reports about its own context. */
export interface TerminalGlReport {
  /** True when the canvas of the terminal gave a WebGL2 context. */
  present: boolean;
  /** The `VERSION` parameter of that context, or an empty string. */
  version: string;
  /** True when that context holds the `preserveDrawingBuffer` attribute. */
  preserved: boolean;
}

/**
 * Report the context of the real terminal canvas.
 *
 * `webgl2Report` proves that the page can give a WebGL2 context. This
 * function proves the stronger fact: the canvas that the client draws on
 * holds one. A 2D canvas gives null for `webgl2`, so `present` is false for
 * it.
 *
 * `getContext` gives back the context that the canvas already holds, and it
 * ignores the attributes at that point. The call below therefore reads the
 * context of the client and never builds a second one.
 *
 * `preserved` is the attribute that makes `paintedPixels` and
 * `canvasSignature` work. Without it, `readPixels` gives the paint only in
 * the same task as the draw.
 */
export function terminalGlReport(page: Page): Promise<TerminalGlReport> {
  return page.evaluate(() => {
    const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
    const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!canvas || !gl) {
      return { present: false, version: "", preserved: false };
    }
    return {
      present: true,
      version: String(gl.getParameter(gl.VERSION) ?? ""),
      preserved: gl.getContextAttributes()?.preserveDrawingBuffer === true,
    };
  });
}

/** The text of the session status, from the header of the menu. */
export async function statusText(page: Page): Promise<string> {
  return (await page.textContent("#menu-status")) ?? "";
}
