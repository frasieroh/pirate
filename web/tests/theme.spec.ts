/**
 * The theme control: two mode buttons, one `.itermcolors` import, and the
 * `--pirate-*` custom properties that both the menu and the login view read.
 *
 * This file writes its own copy of the WCAG contrast formula, instead of
 * importing `src/theme.ts`. `src/theme.ts` imports `src/menu.ts`, and
 * `src/menu.ts` queries the DOM at the top of the module, so importing it
 * under `bun test`, outside a browser page, throws `document is not
 * defined`. The formula is small and it gives an independent check: this
 * test does not verify the production code against a copy of itself.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  clientState,
  hex,
  idle,
  paintedPixels,
  server,
  size,
  viewportLine,
  waitFor,
  waitForConnected,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/** The absolute path of one fixture file. */
function fixture(name: string): string {
  return `${import.meta.dir}/fixtures/${name}`;
}

/** The background of the light default theme, as red, green, blue. */
const LIGHT_BACKGROUND: [number, number, number] = [0xff, 0xff, 0xff];

/**
 * The muted line of `src/main.ts` for a theme change with no open socket.
 *
 * The client keeps the old terminal in that case, because the dump of the
 * server is the only thing that refills a new one.
 */
const PENDING_THEME_LINE = "The terminal takes the new colors with the next shell.";

/** One channel of the WCAG relative luminance function. */
function linearChannel(byte: number): number {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of `#rrggbb`, from 0 (black) to 1 (white). */
function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** The WCAG contrast ratio of two colors, from 1 (no contrast) to 21. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `#rrggbb`, as the `rgb(r, g, b)` form that `getComputedStyle` returns. */
function hexToRgbString(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

/** The computed value of one custom property, on the root element. */
function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/** The computed `color-scheme` of the root element. */
function colorScheme(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
}

/** The computed `background-color` of `#menu`. */
function menuBackground(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.getElementById("menu")!).backgroundColor,
  );
}

/** The shape that the identity helpers below read on the page. */
interface MarkedWindow {
  __pirate: { term: unknown };
  __marked?: unknown;
}

/**
 * Keep the terminal object of this moment, for a later identity test.
 *
 * `__pirate.term` is a getter, and a theme change replaces the object behind
 * it. The mark is the proof that the client built a new terminal.
 */
function markTerminal(page: Page): Promise<void> {
  return page.evaluate(() => {
    const global = globalThis as unknown as MarkedWindow;
    global.__marked = global.__pirate.term;
  });
}

/** True when `__pirate.term` holds another object than the marked one. */
function isNewTerminal(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const global = globalThis as unknown as MarkedWindow;
    return global.__pirate.term !== global.__marked;
  });
}

/** The theme that `term.options.theme` holds, in the page. */
function termTheme(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const pirate = (globalThis as unknown as { __pirate: { term: { options: { theme: Record<string, string> } } } }).__pirate;
    return { ...pirate.term.options.theme };
  });
}

/**
 * Count every later `mouseup` listener of the document, from now on.
 *
 * The counter goes up for a registration and down for a removal. A listener
 * that the page registered before this call is not in the count, and its
 * removal still counts, so a balanced pair always gives zero.
 */
function watchMouseUpListeners(page: Page): Promise<void> {
  return page.evaluate(() => {
    const global = globalThis as unknown as { __mouseUp: number };
    global.__mouseUp = 0;
    const target = document as unknown as Record<string, unknown>;
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    target.addEventListener = (type: string, ...rest: unknown[]): void => {
      if (type === "mouseup") {
        global.__mouseUp += 1;
      }
      (add as unknown as (...args: unknown[]) => void)(type, ...rest);
    };
    target.removeEventListener = (type: string, ...rest: unknown[]): void => {
      if (type === "mouseup") {
        global.__mouseUp -= 1;
      }
      (remove as unknown as (...args: unknown[]) => void)(type, ...rest);
    };
  });
}

/** The count of `watchMouseUpListeners`. */
function mouseUpListeners(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __mouseUp: number }).__mouseUp);
}

/** The text of the fault line of the menu. */
async function noteText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-note")) ?? "").trim();
}

/** The text of the line of the menu that reports a normal result. */
async function hintText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-hint")) ?? "").trim();
}

/** Every resize frame that the client sent. Mirrors `tests/font.spec.ts`. */
function resizeFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 5 && frame[0] === 0x01);
}

/** Every dump request that the client sent. The frame is the tag alone. */
function dumpFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 1 && frame[0] === 0x02);
}

test("the default dark theme sets --pirate-bg, and term.options.theme matches", async () => {
  await withClient(async (page) => {
    expect(await cssVar(page, "--pirate-bg")).toBe("#16161e");
    expect((await termTheme(page)).background).toBe("#16161e");
    expect((await clientState(page)).mode).toBe("dark");
  });
});

test("switching to light changes --pirate-bg, --pirate-fg, and color-scheme", async () => {
  await withClient(async (page) => {
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    expect(await cssVar(page, "--pirate-bg")).toBe("#ffffff");
    expect(await cssVar(page, "--pirate-fg")).toBe("#343b58");
    expect(await colorScheme(page)).toBe("light");
    expect((await termTheme(page)).background).toBe("#ffffff");
  });
});

test("importing atom-one-light.itermcolors gives the exact colors of the file", async () => {
  // Hand-computed from the <real> components of tests/fixtures/atom-one-light.itermcolors:
  // Background Color  0.97647058823529409, 0.97647058823529409, 0.97647058823529409 -> #f9f9f9
  // Foreground Color  0.16470588235294117, 0.17254901960784313, 0.20000000000000001 -> #2a2c33
  // Ansi 1 Color (red) 0.87058823529411766, 0.24313725490196078, 0.20784313725490197 -> #de3e35
  await withClient(async (page) => {
    await page.setInputFiles("#theme-import", fixture("atom-one-light.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "atom-one-light",
      "the imported theme name",
    );

    const state = await clientState(page);
    expect(state.mode).toBe("light");

    const theme = await termTheme(page);
    expect(theme.background).toBe("#f9f9f9");
    expect(theme.foreground).toBe("#2a2c33");
    expect(theme.red).toBe("#de3e35");

    expect(await cssVar(page, "--pirate-bg")).toBe("#f9f9f9");
  });
});

test("importing 3024-night.itermcolors switches the mode to dark", async () => {
  // Hand-computed background: 0.03529411764705882, 0.011764705882352941, 0.0 -> #090300
  await withClient(async (page) => {
    // Start from light, so the switch to dark is a real change.
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    await page.setInputFiles("#theme-import", fixture("3024-night.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "3024-night",
      "the imported theme name",
    );

    const state = await clientState(page);
    expect(state.mode).toBe("dark");
    const theme = await termTheme(page);
    expect(theme.background).toBe("#090300");
  });
});

test("a file with extra Color Space and Alpha Component keys still parses", async () => {
  // tests/fixtures/hand-made-with-extras.itermcolors is not a real iTerm2
  // export. The theme worker wrote it by hand to prove the parser tolerates
  // the two extra keys that a real export adds to every color.
  await withClient(async (page) => {
    await page.setInputFiles("#theme-import", fixture("hand-made-with-extras.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "hand-made-with-extras",
      "the imported theme name",
    );

    const state = await clientState(page);
    expect(state.mode).toBe("dark");
    const theme = await termTheme(page);
    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#ffffff");
    expect(theme.red).toBe("#ff0000");
    expect(await noteText(page)).toBe("");
  });
});

test("a file that is not a plist gives the error line, and changes no color", async () => {
  await withClient(async (page) => {
    const before = await cssVar(page, "--pirate-bg");
    const beforeState = await clientState(page);

    await page.setInputFiles("#theme-import", fixture("not-a-plist.itermcolors"));
    await waitFor(() => noteText(page), (text) => text.length > 0, "the error line");

    expect(await noteText(page)).toContain(".itermcolors");
    expect(await cssVar(page, "--pirate-bg")).toBe(before);
    expect((await clientState(page)).mode).toBe(beforeState.mode);
    expect((await clientState(page)).themeName).toBe(beforeState.themeName);
  });
});

test("the imported theme survives a page reload", async () => {
  await withClient(async (page) => {
    await page.setInputFiles("#theme-import", fixture("atom-one-light.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "atom-one-light",
      "the imported theme name",
    );

    await page.reload();
    await waitForConnected(page);

    const state = await clientState(page);
    expect(state.mode).toBe("light");
    expect(state.themeName).toBe("atom-one-light");
    expect(await cssVar(page, "--pirate-bg")).toBe("#f9f9f9");
    expect((await termTheme(page)).background).toBe("#f9f9f9");
  });
});

test("the light palette meets the contrast floors", async () => {
  // Every normal color and the foreground reach 4.5:1 against the light
  // background. Every bright color reaches 3:1. The values come from the
  // running client, through term.options.theme, not from a copy pasted into
  // this file.
  await withClient(async (page) => {
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    const theme = await termTheme(page);
    const background = theme.background;

    const normal = ["foreground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    for (const field of normal) {
      const ratio = contrastRatio(theme[field], background);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    const bright = [
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ];
    for (const field of bright) {
      const ratio = contrastRatio(theme[field], background);
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });
});

test("a theme change refills the screen from the dump, and sends no resize frame", async () => {
  // A theme change builds a new terminal facade. The VT terminal below it lives
  // on, so `src/main.ts` clears the screen with RIS before it asks for the
  // dump, and the `0x02` dump request then brings the screen back from the
  // server. Without that clear the dump would land on the old text. The guard
  // that stays from the old behavior: the rebuild sends no resize frame.
  const stub = server();
  stub.setOnDump([{ tag: 0x01, text: "pirate" }]);

  await withClient(async (page) => {
    // Real content on one row, so the canvas holds real content, not only
    // the empty background.
    stub.send([{ tag: 0x00, text: "pirate" }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "pirate", "row 0");
    const inkBefore = await waitFor(
      () => paintedPixels(page, 0),
      (n) => n > 50,
      "paint from the written text",
    );

    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;
    const beforeSize = await size(page);
    await markTerminal(page);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    // 1. The client built a new terminal.
    expect(await isNewTerminal(page)).toBe(true);
    // 2. The dump put the text back on that new terminal.
    await waitFor(
      () => viewportLine(page, 0),
      (line) => line === "pirate",
      "the text of the dump on the new terminal",
    );
    // 3. The canvas of the new terminal holds the ink of that text. Both
    //    counts run against the LIGHT background, the background of the new
    //    theme, so an empty row counts near zero and only glyphs count. Row 3
    //    holds no text and gives that floor. A canvas that kept the dark
    //    colors would count every pixel of both rows, and the difference would
    //    then go away, so this assertion can fail.
    const inkAfter = await waitFor(
      () => paintedPixels(page, 0, LIGHT_BACKGROUND),
      (n) => n > 50,
      "the ink of the dump on the light canvas",
    );
    const emptyAfter = await paintedPixels(page, 3, LIGHT_BACKGROUND);
    // eslint-disable-next-line no-console
    console.log(
      `  row 0 against the dark background: ${inkBefore} pixels. ` +
        `Against the light background: row 0 ${inkAfter}, empty row ${emptyAfter}`,
    );
    expect(inkAfter).toBeGreaterThan(emptyAfter + 50);

    // Wait longer than the debounce, so a late resize frame would be counted.
    await idle(debounce + 400);
    const after = resizeFrames(stub.received).length;
    const afterSize = await size(page);
    expect(after).toBe(before);
    expect(afterSize).toEqual(beforeSize);
  });
});

test("a theme change repaints the menu at once, with no reload", async () => {
  // The custom properties, the menu, and the terminal all follow the new
  // theme. No part of the client waits for a page reload.
  await withClient(async (page) => {
    expect(await cssVar(page, "--pirate-bg")).toBe("#16161e");
    const menuBefore = await menuBackground(page);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    expect(await cssVar(page, "--pirate-bg")).toBe("#ffffff");
    const surface = await cssVar(page, "--pirate-surface");
    const menuAfter = await menuBackground(page);
    expect(menuAfter).not.toBe(menuBefore);
    expect(menuAfter).toBe(hexToRgbString(surface));
    expect(relativeLuminance(surface)).toBeGreaterThan(0.5);
  });
});

test("a theme change shows no note, because the client needs no reload", async () => {
  // The old client showed a muted line that named a page reload and the cost
  // of one: the reload ended the shell. The rebuild removed that cost, so the
  // line went with it. Both lines of the menu stay empty.
  const stub = server();

  await withClient(async (page) => {
    expect(await hintText(page)).toBe("");

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request",
    );

    expect(await hintText(page)).toBe("");
    expect(await noteText(page)).toBe("");
  });
});

test("an import rebuilds the terminal too, and shows no note", async () => {
  const stub = server();

  await withClient(async (page) => {
    await markTerminal(page);

    await page.setInputFiles("#theme-import", fixture("atom-one-light.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "atom-one-light",
      "the imported theme name",
    );
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request",
    );

    expect(await isNewTerminal(page)).toBe(true);
    expect((await termTheme(page)).background).toBe("#f9f9f9");
    expect(await hintText(page)).toBe("");
    expect(await noteText(page)).toBe("");
  });
});

test("a page load sends no dump request, because the constructor holds the stored theme", async () => {
  // The load path calls `paint` alone. `src/main.ts` already gave the stored
  // theme to the constructor of the terminal, so a rebuild on that path would
  // throw away the screen for nothing.
  const stub = server();

  await withClient(async (page) => {
    // A fresh page, with the default theme.
    expect(dumpFrames(stub.received).length).toBe(0);

    // An operator change stores the light theme and rebuilds the terminal.
    await page.click("#theme-light");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request",
    );
    expect(dumpFrames(stub.received).length).toBe(1);

    // The reload gives the light theme to the constructor again. The screen is
    // then correct at once, and the client asks for no dump.
    await page.reload();
    await waitForConnected(page);
    await idle(300);
    expect((await clientState(page)).mode).toBe("light");
    expect(dumpFrames(stub.received).length).toBe(1);
  });
});

test("a theme change builds a new terminal, and sends one 0x02 frame and no 0x01 frame", async () => {
  // The hard requirement of section 4.1 rule 3 of `docs/program-status.md`: a
  // change that does not change the size sends no resize frame. A new terminal
  // starts at the default size, so `applyFit` compares against the size that
  // the server knows and not against the size of the new terminal.
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;
    const beforeSize = await size(page);
    await markTerminal(page);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request",
    );

    // Wait longer than the debounce, so a late resize frame would be counted.
    await idle(debounce + 400);
    const after = resizeFrames(stub.received).length;
    const afterSize = await size(page);
    // eslint-disable-next-line no-console
    console.log(
      `  one theme change: ${dumpFrames(stub.received).length} dump request(s), ` +
        `resize frames ${before} → ${after}`,
    );

    expect(await isNewTerminal(page)).toBe(true);
    expect(dumpFrames(stub.received).length).toBe(1);
    expect(after).toBe(before);
    expect(afterSize).toEqual(beforeSize);
  });
});

test("the shell survives a theme change: one connection, and a key still reaches the server", async () => {
  // The proof that the rebuild costs no session. The socket stays open, the
  // stub counts no second connection, and the next keystroke of the operator
  // arrives as a `0x00` input frame from the new terminal.
  const stub = server();

  await withClient(async (page) => {
    expect(stub.connections).toBe(1);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request",
    );

    expect(stub.connections).toBe(1);
    expect(stub.open).toBe(true);
    const state = await clientState(page);
    expect(state.connections).toBe(1);
    expect(state.connected).toBe(true);

    await page.focus("#terminal");
    const first = stub.received.length;
    await page.keyboard.press("a");
    const frames = await waitFor(
      async () => stub.received.slice(first),
      (list) => list.length >= 1,
      "an input frame after the theme change",
    );
    // eslint-disable-next-line no-console
    console.log(`  the key after the theme change: ${hex(frames[0])}`);
    expect(Array.from(frames[0])).toEqual([0x00, 0x61]);
  });
});

test("the new terminal carries the new theme, and its canvas paints the new background", async () => {
  const stub = server();
  stub.setOnDump([{ tag: 0x01, text: "light" }]);

  await withClient(async (page) => {
    // Row 3 holds no text. `paintedPixels` counts the pixels of that row that
    // differ from the DARK background of `tests/harness.ts`, so the count of
    // an empty row under the dark theme stays near zero.
    const darkRow = await paintedPixels(page, 3);
    expect(darkRow).toBeLessThan(100);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await waitFor(
      () => viewportLine(page, 0),
      (line) => line === "light",
      "the text of the dump on the new terminal",
    );

    const theme = await termTheme(page);
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#343b58");

    // The same empty row now holds the white background, which differs from
    // the dark background of the harness on every pixel. A canvas that painted
    // nothing would still count near zero.
    const lightRow = await waitFor(
      () => paintedPixels(page, 3),
      (n) => n > 1000,
      "the light background on the canvas",
    );
    // eslint-disable-next-line no-console
    console.log(`  empty row against the dark background: ${darkRow} → ${lightRow} pixels`);
    expect(lightRow).toBeGreaterThan(darkRow + 1000);
  });
});

test("a rebuild adds no document mouseup listener", async () => {
  // The old client drove ghostty-web, which registered `handleMouseUp` on the
  // document in `open()` and never removed it, so each theme change leaked one
  // listener. `src/main.ts` carried a removal call for it.
  //
  // The renderer of `src/render` registers no listener on the document, and
  // the facade of `src/terminal.ts` registers its one `keydown` listener on
  // `#terminal` and removes it in `dispose`. The removal call is therefore
  // gone from `src/main.ts`, and the count below stays at zero because nothing
  // registers and nothing removes.
  const stub = server();

  await withClient(async (page) => {
    await watchMouseUpListeners(page);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 1,
      "the dump request of the first rebuild",
    );
    await page.click("#theme-dark");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "dark", "dark mode");
    await waitFor(
      async () => dumpFrames(stub.received),
      (list) => list.length >= 2,
      "the dump request of the second rebuild",
    );

    // Two rebuilds. Neither one touches the document.
    const count = await mouseUpListeners(page);
    // eslint-disable-next-line no-console
    console.log(`  document mouseup listeners after two rebuilds: ${count >= 0 ? "+" : ""}${count}`);
    expect(count).toBe(0);
  });
});

test("a theme change after a server 0x02 frame keeps the screen of the dead shell", async () => {
  // The regression guard for the worst case of the rebuild. `onclose` never
  // reconnects after a server `0x02` frame, so the old terminal holds the last
  // output of that shell. A rebuild would dispose that terminal, get no dump,
  // and leave a blank screen with no way back.
  const stub = server();

  await withClient(async (page) => {
    stub.send([{ tag: 0x00, text: "last words" }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "last words", "row 0");

    // The real server sends the exit frame and then closes the socket.
    stub.send([{ tag: 0x02, status: 0 }]);
    await waitFor(
      async () => (await clientState(page)).exitStatus,
      (value) => value === 0,
      "the exit status",
    );
    stub.closeSocket();
    await waitFor(
      async () => (await clientState(page)).connected,
      (value) => value === false,
      "the closed socket",
    );

    await markTerminal(page);
    const dumpsBefore = dumpFrames(stub.received).length;

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    // The terminal is the same object, and the text of the dead shell is on it.
    expect(await isNewTerminal(page)).toBe(false);
    expect(await viewportLine(page, 0)).toBe("last words");
    expect(dumpFrames(stub.received).length).toBe(dumpsBefore);
    // The menu reports the wait on the muted line, never on the fault line.
    expect(await hintText(page)).toBe(PENDING_THEME_LINE);
    expect(await noteText(page)).toBe("");
    // The page, the menu, and the login view still take the new colors at once.
    expect(await cssVar(page, "--pirate-bg")).toBe("#ffffff");
  });
});

test("a theme change on a closed socket lands on the next open socket", async () => {
  // The theme waits in `pendingTheme` of `src/main.ts`, and `ws.onopen` builds
  // the new terminal with it. The dump request then goes out on an open
  // socket, so the new terminal gets its screen.
  const stub = server();
  stub.setOnOpen([{ tag: 0x01, text: "shell 2" }]);

  await withClient(async (page) => {
    // Hold `/auth`. `sessionLost` of `src/login.ts` asks it after every close,
    // so the reconnect waits here and the socket stays closed for the theme
    // change below. The test releases the answer when it is ready.
    let release: () => void = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/auth", async (route) => {
      await held;
      await route.fulfill({ status: 404, contentType: "text/plain", body: "no auth" });
    });

    stub.closeSocket();
    await waitFor(
      async () => (await clientState(page)).connected,
      (value) => value === false,
      "the closed socket",
    );

    await markTerminal(page);
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    // The client kept the old terminal, and it said so.
    expect(await isNewTerminal(page)).toBe(false);
    expect(await hintText(page)).toBe(PENDING_THEME_LINE);

    release();
    await waitFor(
      async () => (await clientState(page)).connections,
      (count) => count === 2,
      "a second connection",
    );

    // The terminal that comes back is another object, and it carries the theme
    // that waited.
    await waitFor(() => isNewTerminal(page), (value) => value === true, "the new terminal");
    const theme = await termTheme(page);
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#343b58");
    expect((await clientState(page)).mode).toBe("light");
    // The line leaves the screen with the rebuild.
    await waitFor(() => hintText(page), (text) => text === "", "the empty muted line");
    expect(await noteText(page)).toBe("");
  });
});

test("a theme change sends no resize frame, and the terminal size stays the same", async () => {
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;
    const beforeSize = await size(page);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");
    await page.click("#theme-dark");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "dark", "dark mode");

    // Wait longer than the debounce, so a late fit would be counted.
    await idle(debounce + 400);

    const after = resizeFrames(stub.received).length;
    const afterSize = await size(page);
    // eslint-disable-next-line no-console
    console.log(
      `  two theme changes: ${dumpFrames(stub.received).length} dump request(s), ` +
        `resize frames ${before} → ${after}`,
    );
    expect(after).toBe(before);
    expect(afterSize).toEqual(beforeSize);
    // Two rebuilds, two dump requests. Each one refills its own new terminal.
    expect(dumpFrames(stub.received).length).toBe(2);
  });
});
