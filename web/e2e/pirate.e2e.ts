/**
 * The end-to-end suite.
 *
 * One real Chromium drives one real pirate process over TLS. Nothing is
 * stubbed: the certificate, the token file, the session cookie, the WebSocket,
 * and the PTY are the ones that the operator meets.
 *
 * Each test starts its own server and stops it in a `finally`. A server holds
 * a temporary `HOME` and a shell, so a leaked server is a leaked directory and
 * a leaked process. `web/e2e/server.ts` also kills every live server when this
 * process exits, so a failed run and a Ctrl+C leave nothing behind.
 *
 * The suite waits for a condition with a deadline and never sleeps for a fixed
 * time. `staysFalse` is the one exception, and it is the one case that needs
 * it: the absence of an event has no condition to wait for.
 *
 * The runner is `bun test`, not the Playwright runner. `bun run test:e2e`
 * starts it. The file name ends in `.e2e.ts`, which the default discovery of
 * `bun test` does not match, so the unit suite never picks it up.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
  canvasSignature,
  clientReady,
  clientState,
  closeBrowser,
  LIGHT_BACKGROUND,
  login,
  newSession,
  paintedPixels,
  staysFalse,
  statusText,
  strictContext,
  viewportText,
  waitFor,
  waitForConnected,
  waitForLine,
} from "./browser";
import { RECORDER_READY, startPirate } from "./server";

/** The name of the light theme that `src/theme.ts` ships. */
const LIGHT_NAME = "pirate light";

/** The wait of a negative check, in milliseconds. */
const QUIET_MS = 750;

afterAll(closeBrowser);

// ── 1. TLS and the certificate ────────────────────────────────────────────
describe("TLS", () => {
  test("the browser refuses the self-signed certificate, and accepts it on demand", async () => {
    const server = await startPirate({ recorder: true });
    try {
      // The startup lines name the fingerprint, so the operator can compare it
      // with the one in the warning of the browser.
      expect(server.fingerprint).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
      expect(server.stderr()).toContain("nothing signed this certificate");
      expect(server.url).toStartWith("https://127.0.0.1:");

      // A context that trusts no certificate cannot reach the page. This is
      // the proof that the transport is real TLS and not plain HTTP.
      const strict = await strictContext();
      try {
        const page = await strict.newPage();
        let failure = "";
        try {
          await page.goto(`${server.url}/`);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        expect(failure).toContain("ERR_CERT");
      } finally {
        await strict.close();
      }

      // The same server, with the certificate accepted, serves the client.
      const { page, context } = await newSession(server);
      try {
        expect(await page.evaluate(() => location.protocol)).toBe("https:");
        expect(await page.locator("#terminal").count()).toBe(1);
      } finally {
        await context.close();
      }
    } finally {
      await server.stop();
    }
  });
});

// ── 2. the token file ─────────────────────────────────────────────────────
describe("the token file", () => {
  test("the first start writes a private token, and prints no token", async () => {
    const server = await startPirate({ recorder: true });
    try {
      const directory = fs.statSync(`${server.home}/.pirate`);
      const file = fs.statSync(server.tokenPath);
      expect(directory.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
      expect(server.token).toMatch(/^[0-9a-f]{64}$/);

      // The operator reads the token from the file. The server prints the path
      // of that file and never the token itself.
      expect(server.stderr()).toContain(`pirate: token file ${server.tokenPath}`);
      expect(server.stderr()).not.toContain(server.token);
      expect(server.stdout()).not.toContain(server.token);
    } finally {
      await server.stop();
    }
  });
});

// ── 3 and 4. the login view ───────────────────────────────────────────────
describe("the login", () => {
  test("the first load shows the form and starts no terminal", async () => {
    const server = await startPirate({ recorder: true });
    const { page, context } = await newSession(server);
    try {
      await page.waitForSelector("#login");
      expect(await page.getAttribute("body", "data-auth")).toBe("required");
      // `src/main.ts` exposes `__pirate` after `requireSession` resolves. Its
      // absence is the proof that the wasm terminal never started.
      expect(await clientReady(page)).toBe(false);
    } finally {
      await context.close();
      await server.stop();
    }
  });

  test("a wrong token is refused, and the right token connects", async () => {
    const server = await startPirate({ recorder: true });
    const { page, context } = await newSession(server);
    try {
      await page.waitForSelector("#login");

      // A token of the right shape and the wrong value. The server answers 401
      // and the client keeps the form on the screen.
      await login(page, "0".repeat(64));
      await waitFor(
        () => page.textContent(".login-error"),
        (text) => text === "wrong token",
        "the error line",
      );
      expect(await page.locator("#login").count()).toBe(1);
      expect(await page.getAttribute("body", "data-auth")).toBe("required");
      expect(await clientReady(page)).toBe(false);

      // The token of the token file. The form goes away and the socket opens.
      await login(page, server.token);
      await page.waitForSelector("#login", { state: "detached" });
      expect(await page.getAttribute("body", "data-auth")).toBe(null);
      await waitForConnected(page);
      expect((await clientState(page)).connections).toBe(1);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});

// ── 5 and 6. the shell and the keyboard ───────────────────────────────────
describe("the shell", () => {
  test("a keystroke reaches the shell and paints", async () => {
    const server = await startPirate({ recorder: true });
    const { page, context, errors } = await newSession(server);
    try {
      await login(page, server.token);
      await waitForConnected(page);
      await waitForLine(page, (lines) => lines[0] === RECORDER_READY, "the recorder marker");

      await page.keyboard.type("hello");
      const lines = await waitForLine(page, (l) => l[1] === "hello", "the word hello");
      expect(lines[1]).toBe("hello");

      // The row holds paint. The count is against the dark default background,
      // which a fresh page loads.
      expect(await paintedPixels(page, 1)).toBeGreaterThan(0);
      // A row that no write touched holds the background alone.
      expect(await paintedPixels(page, 20)).toBe(0);

      // The client reported no error while it did this work.
      expect(errors.filter((line) => !line.includes("401"))).toEqual([]);
    } finally {
      await context.close();
      await server.stop();
    }
  });

  test("every corrected chord reaches the shell as the right bytes", async () => {
    // `cat -vt` paints a control byte as a caret escape, so each chord below is
    // visible on the screen. Ctrl+J is the line delimiter: `cat` passes the
    // line feed through, and the terminal paints nothing for it.
    //
    // Two measurements shaped the recorder shell of `web/e2e/server.ts`:
    //
    // 1. Without `-icrnl`, the line discipline turned the carriage return of
    //    Ctrl+M into a line feed, and the screen showed the same result for
    //    Ctrl+M and for Ctrl+J.
    // 2. Without the ready marker, the first keystrokes arrived before `stty`
    //    returned. The terminal still echoed then, so `hello` reached the
    //    screen twice: once from the echo and once from `cat`.
    //
    // Each Playwright key name below names the physical key, and
    // `src/input.ts` reads `event.code`. A measurement confirmed the code and
    // the modifier flags of every one of them.
    const chords: [string, string][] = [
      ["Control+KeyA", "^A"],
      ["Control+KeyV", "^V"],
      ["Control+BracketLeft", "^["],
      ["Control+KeyI", "^I"],
      ["Control+KeyM", "^M"],
      ["Control+Minus", "^_"],
      ["Shift+Tab", "^[[Z"],
      ["Alt+KeyB", "^[b"],
    ];

    const server = await startPirate({ recorder: true });
    const { page, context } = await newSession(server);
    try {
      await login(page, server.token);
      await waitForConnected(page);
      await waitForLine(page, (lines) => lines[0] === RECORDER_READY, "the recorder marker");

      // The marker ends with a line feed, so the cursor stands on row 1 and
      // the first chord paints there. Each Ctrl+J then moves down one row.
      //
      // One chord at a time, and one wait for each result. A failure then
      // names the chord that failed.
      //
      // The wait is on the WHOLE expected text and not on the row count. A
      // chord such as Shift+Tab paints four characters, and the bytes can
      // reach the terminal in more than one frame. A wait on the row count
      // alone therefore returns on the first character of a correct chord,
      // and the assertion that follows it fails at random.
      let row = 0;
      for (const [chord, painted] of chords) {
        row += 1;
        await page.keyboard.press(chord);
        // A wrong chord never satisfies the wait. The catch turns that
        // timeout into an assertion that names the chord and the text that
        // the shell painted for it.
        const lines = await waitForLine(
          page,
          (l) => l[row] === painted,
          `${chord} to paint ${painted}`,
          10_000,
        ).catch(() => viewportText(page));
        expect(`${chord} paints ${lines[row] ?? ""}`).toBe(`${chord} paints ${painted}`);
        await page.keyboard.press("Control+KeyJ");
      }
    } finally {
      await context.close();
      await server.stop();
    }
  });
});

// ── 7. the theme change ───────────────────────────────────────────────────
describe("a theme change", () => {
  test("repaints with no reload and keeps the shell", async () => {
    const server = await startPirate({ recorder: true });
    const { page, context } = await newSession(server);
    try {
      await login(page, server.token);
      await waitForConnected(page);
      await waitForLine(page, (lines) => lines[0] === RECORDER_READY, "the recorder marker");

      await page.keyboard.type("before");
      await waitForLine(page, (l) => l[1] === "before", "the word before");
      const before = await clientState(page);
      expect(before.connected).toBe(true);
      expect(before.mode).toBe("dark");

      const signature = await canvasSignature(page);

      // A reload loses this value, so a read of it after the click proves that
      // the page never navigated.
      await page.evaluate(() => {
        (window as unknown as Record<string, unknown>).__e2eMark = "kept";
      });

      await page.click("#theme-light");
      await waitFor(
        async () => (await clientState(page)).themeName,
        (name) => name === LIGHT_NAME,
        "the light theme",
      );

      // The server dump refilled the new terminal, so the old screen is back.
      const after = await waitForLine(
        page,
        (l) => l[0] === RECORDER_READY && l[1] === "before",
        "the old screen after the rebuild",
      );
      expect(after[1]).toBe("before");

      // No reconnect, and no lost shell.
      const state = await clientState(page);
      expect(state.connections).toBe(before.connections);
      expect(state.connected).toBe(true);
      expect(state.exitStatus).toBe(null);
      expect(
        await staysFalse(async () => (await clientState(page)).connected === false, QUIET_MS),
      ).toBe(true);
      expect((await clientState(page)).connections).toBe(before.connections);

      // The canvas carries the new colors. The count is against the light
      // background, so a canvas that still held the dark background would
      // count every pixel of the row.
      expect(await paintedPixels(page, 1, LIGHT_BACKGROUND)).toBeGreaterThan(0);
      expect(await paintedPixels(page, 20, LIGHT_BACKGROUND)).toBe(0);
      expect(await canvasSignature(page)).not.toBe(signature);

      // The page never navigated.
      expect(
        await page.evaluate(() => (window as unknown as Record<string, unknown>).__e2eMark),
      ).toBe("kept");

      // The same shell still reads the keyboard, and the new terminal paints.
      await page.keyboard.press("Control+KeyJ");
      await page.keyboard.type("after");
      const lines = await waitForLine(page, (l) => l[2] === "after", "the word after");
      expect(lines[2]).toBe("after");
      expect(await paintedPixels(page, 2, LIGHT_BACKGROUND)).toBeGreaterThan(0);
      expect((await clientState(page)).connections).toBe(before.connections);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});

// ── 8. the end of the session ─────────────────────────────────────────────
describe("the end of the session", () => {
  test("a shell that exits reports its status, and the server stays up", async () => {
    const server = await startPirate({ shell: "/bin/sh" });
    const { page, context } = await newSession(server);
    try {
      await login(page, server.token);
      await waitForConnected(page);

      await page.keyboard.type("exit 0");
      await page.keyboard.press("Enter");

      const state = await waitFor(
        () => clientState(page),
        (value) => value.exitStatus !== null,
        "the exit frame",
      );
      expect(state.exitStatus).toBe(0);
      expect(state.connected).toBe(false);

      const status = await statusText(page);
      expect(status).toContain("exited with status 0");

      // The client stops after an exit frame, so it opens no second socket.
      expect(
        await staysFalse(async () => (await clientState(page)).connections > 1, QUIET_MS),
      ).toBe(true);
      // The screen of the dead shell stays on the page.
      expect((await viewportText(page)).length).toBeGreaterThan(0);

      // One session ended. The server serves the next browser.
      await context.close();
      expect(server.exited).toBe(false);
      expect(await staysFalse(async () => server.exited, QUIET_MS)).toBe(true);

      await server.stop();
      expect(server.exited).toBe(true);
    } finally {
      await context.close();
      await server.stop();
    }
  });
});
