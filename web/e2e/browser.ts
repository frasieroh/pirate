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

let browser: Browser | undefined;

/** The one browser of this file. It launches on the first call. */
async function getBrowser(): Promise<Browser> {
  if (browser === undefined) {
    browser = await chromium.launch();
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
 */
export function paintedPixels(
  page: Page,
  row: number,
  background: [number, number, number] = DARK_BACKGROUND,
): Promise<number> {
  return page.evaluate(
    ({ row: y, background: bg }: { row: number; background: [number, number, number] }) => {
      const canvas = document.querySelector("#terminal canvas") as HTMLCanvasElement | null;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        return -1;
      }
      const term = (globalThis as unknown as PirateWindow).__pirate!.term;
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

/** The text of the session status, from the header of the menu. */
export async function statusText(page: Page): Promise<string> {
  return (await page.textContent("#menu-status")) ?? "";
}
