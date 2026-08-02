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

import { expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  clientState,
  idle,
  paintedPixels,
  server,
  size,
  viewportLine,
  waitFor,
  waitForConnected,
  withClient,
} from "./harness";

/** The absolute path of one fixture file. */
function fixture(name: string): string {
  return `${import.meta.dir}/fixtures/${name}`;
}

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

/** The theme that `term.options.theme` holds, in the page. */
function termTheme(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const pirate = (globalThis as unknown as { __pirate: { term: { options: { theme: Record<string, string> } } } }).__pirate;
    return { ...pirate.term.options.theme };
  });
}

/** The text of the fault line of the menu. */
async function noteText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-note")) ?? "").trim();
}

/** The text of the line of the menu that reports a normal result. */
async function hintText(page: Page): Promise<string> {
  return ((await page.textContent("#menu-hint")) ?? "").trim();
}

/** The computed `color` of the line that reports a normal result. */
function hintColor(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.getElementById("menu-hint")!).color,
  );
}

/** Every resize frame that the client sent. Mirrors `tests/font.spec.ts`. */
function resizeFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 5 && frame[0] === 0x01);
}

test("the default dark theme sets --pirate-bg, and term.options.theme matches", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    expect(await cssVar(page, "--pirate-bg")).toBe("#16161e");
    expect((await termTheme(page)).background).toBe("#16161e");
    expect((await clientState(page)).mode).toBe("dark");
  });
});

test("switching to light changes --pirate-bg, --pirate-fg, and color-scheme", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    expect(await cssVar(page, "--pirate-bg")).toBe("#ffffff");
    expect(await cssVar(page, "--pirate-fg")).toBe("#343b58");
    expect(await colorScheme(page)).toBe("light");
    expect((await termTheme(page)).background).toBe("#ffffff");
  });
});

test("the menu matches the active theme", async () => {
  // The exact detail: a light terminal with a dark menu over it reads as
  // unfinished software. The computed background of #menu must equal the
  // computed --pirate-surface, and that surface must be light.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    const surface = await cssVar(page, "--pirate-surface");
    expect(relativeLuminance(surface)).toBeGreaterThan(0.5);
    expect(await menuBackground(page)).toBe(hexToRgbString(surface));
  });
});

test("importing atom-one-light.itermcolors gives the exact colors of the file", async () => {
  // Hand-computed from the <real> components of tests/fixtures/atom-one-light.itermcolors:
  // Background Color  0.97647058823529409, 0.97647058823529409, 0.97647058823529409 -> #f9f9f9
  // Foreground Color  0.16470588235294117, 0.17254901960784313, 0.20000000000000001 -> #2a2c33
  // Ansi 1 Color (red) 0.87058823529411766, 0.24313725490196078, 0.20784313725490197 -> #de3e35
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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

test("a theme change keeps the text on the screen, and sends no resize frame", async () => {
  // The decision: ghostty-web 0.4.0 cannot recolor a canvas that already
  // holds text, so the client changes no pixel of the terminal. The old
  // `renderer.resize` call cleared the canvas to the new background and
  // blanked every glyph. This test is the regression guard for that call.
  const stub = server();
  stub.reset();

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
    // Row 3 holds no text. `paintedPixels` counts its pixels against the
    // dark background of `tests/harness.ts`, so the count of an untouched
    // row stays near zero. A `renderer.resize` call fills the whole canvas
    // with the light background, and this count then jumps to thousands.
    const emptyRowBefore = await paintedPixels(page, 3);

    await page.click("#theme-light");
    await waitFor(() => clientState(page).then((s) => s.mode), (mode) => mode === "light", "light mode");

    const inkAfter = await paintedPixels(page, 0);
    const emptyRowAfter = await paintedPixels(page, 3);
    // eslint-disable-next-line no-console
    console.log(
      `  row 0 ink against the dark background: ${inkBefore} → ${inkAfter} pixels\n` +
        `  empty row against the dark background: ${emptyRowBefore} → ${emptyRowAfter} pixels`,
    );

    // 1. The buffer keeps the text.
    expect(await viewportLine(page, 0)).toBe("pirate");
    // 2. The canvas keeps the ink. The count holds a band, and it does not
    //    reach the count of a full row of the new background. The cursor
    //    blinks over one cell, so the band is not one exact number.
    expect(inkAfter).toBeGreaterThan(50);
    expect(inkAfter).toBeLessThan(inkBefore + 1000);
    // 3. The empty row is still the old background. The screen went not
    //    blank.
    expect(emptyRowAfter).toBeLessThan(emptyRowBefore + 100);

    // Wait longer than the debounce, so a late resize frame would be counted.
    await idle(debounce + 400);
    const after = resizeFrames(stub.received).length;
    const afterSize = await size(page);
    expect(after).toBe(before);
    expect(afterSize).toEqual(beforeSize);
  });
});

test("a theme change repaints the menu at once, with no reload", async () => {
  // The custom properties and the menu follow the new theme on the same
  // frame. Only the canvas of the terminal waits for a reload.
  const stub = server();
  stub.reset();

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

test("a theme change shows the note, and the note names the reload", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    expect(await hintText(page)).toBe("");

    await page.click("#theme-light");
    await waitFor(() => hintText(page), (text) => text.length > 0, "the note");

    const text = await hintText(page);
    // eslint-disable-next-line no-console
    console.log(`  the note: ${text}`);
    expect(text).toContain("reload");
    // The second fact: a reload costs the operator the running shell.
    expect(text).toContain("shell");
    // The tone is muted, not warn: a theme change is a normal action, and it
    // reports no fault. The fault line stays empty.
    expect(await hintColor(page)).toBe(hexToRgbString(await cssVar(page, "--pirate-muted")));
    expect(await noteText(page)).toBe("");
  });
});

test("an import shows the same note, because an import also changes the theme", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.setInputFiles("#theme-import", fixture("atom-one-light.itermcolors"));
    await waitFor(
      () => clientState(page).then((s) => s.themeName),
      (name) => name === "atom-one-light",
      "the imported theme name",
    );

    expect(await hintText(page)).toContain("reload");
    expect(await noteText(page)).toBe("");
  });
});

test("the note is absent on a page load, because the stored theme is correct", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    // A fresh page, with the default theme.
    expect(await hintText(page)).toBe("");

    // An operator change stores the light theme and shows the note.
    await page.click("#theme-light");
    await waitFor(() => hintText(page), (text) => text.length > 0, "the note");

    // The reload gives the light theme to the constructor of the terminal.
    // The screen is then correct, and a note that names a reload is false.
    await page.reload();
    await waitForConnected(page);
    expect((await clientState(page)).mode).toBe("light");
    expect(await hintText(page)).toBe("");
  });
});

test("a theme change sends no resize frame, and the terminal size stays the same", async () => {
  const stub = server();
  stub.reset();

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
    console.log(`  two theme changes: resize frames ${before} → ${after}`);
    expect(after).toBe(before);
    expect(afterSize).toEqual(beforeSize);
  });
});
