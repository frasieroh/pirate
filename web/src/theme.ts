/**
 * The theme model.
 *
 * Two slots hold two themes: dark and light. `prefs.mode` selects the active
 * slot. This module computes the `--pirate-*` custom properties from the
 * colors of the active theme, in TypeScript, so a test can read one number
 * and compare it. It sets no property with CSS `color-mix`.
 *
 * This file and `src/prefs.ts` import from each other. `src/prefs.ts` needs
 * `DARK` and `LIGHT` as the default themes, and this file needs `prefs` and
 * `setPrefs` to read and store the active theme. Neither file calls the
 * other at the top level of the module, so the cycle is safe: every call
 * happens later, inside a function, after both modules finish loading.
 */

import { addMenuRow, setMenuNote, THEME_GROUP } from "./menu";
import { type Mode, prefs, setPrefs } from "./prefs";
import type { Runtime } from "./runtime";
import { parseItermColors } from "./iterm";
import type { ThemeRecord } from "./prefs";

/**
 * One theme.
 *
 * The member set is the member set of `ITheme` of ghostty-web, so a theme
 * goes to `term.options.theme` without a conversion. Each value is `#rrggbb`.
 */
export type Theme = ThemeRecord;

/** The default theme of the dark slot. */
export const DARK: Theme = {
  name: "pirate dark",
  background: "#16161e",
  foreground: "#a9b1d6",
  cursor: "#c0caf5",
  cursorAccent: "#16161e",
  selectionBackground: "#283457",
  selectionForeground: "#c0caf5",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff899d",
  brightGreen: "#9fe044",
  brightYellow: "#faba4a",
  brightBlue: "#8db0ff",
  brightMagenta: "#c7a9ff",
  brightCyan: "#a4daff",
  brightWhite: "#c0caf5",
};

/**
 * The default theme of the light slot.
 *
 * Every normal color and the foreground reach a contrast ratio of 4.5 to 1
 * against the background. Every bright color reaches 3 to 1.
 * `tests/theme.spec.ts` measures this with `contrastRatio`, below.
 */
export const LIGHT: Theme = {
  name: "pirate light",
  background: "#ffffff",
  foreground: "#343b58",
  cursor: "#343b58",
  cursorAccent: "#ffffff",
  selectionBackground: "#b7c1e3",
  selectionForeground: "#343b58",
  black: "#0f0f14",
  red: "#8c4351",
  green: "#33635c",
  yellow: "#8f5e15",
  blue: "#34548a",
  magenta: "#5a4a78",
  cyan: "#0f4b6e",
  white: "#343b58",
  brightBlack: "#545c7e",
  brightRed: "#a8404c",
  brightGreen: "#28615a",
  brightYellow: "#875c14",
  brightBlue: "#2e4d80",
  brightMagenta: "#54446f",
  brightCyan: "#0d4465",
  brightWhite: "#343b58",
};

/**
 * The background luminance that separates the light slot from the dark slot.
 *
 * The relative luminance of a color runs from 0 (black) to 1 (white). A
 * background at or above 0.5 gets the light slot. A background below 0.5
 * gets the dark slot.
 */
const LIGHT_SLOT_LUMINANCE = 0.5;

/** One channel of `#rrggbb`, as a number from 0 to 255. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Three channel values, each 0 to 255, as `#rrggbb`. Each value clamps first. */
function rgbToHex(r: number, g: number, b: number): string {
  const byte = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * One channel of the WCAG relative luminance function.
 *
 * The function comes from the WCAG contrast formula. It is not a simple
 * average of the red, green, and blue channels.
 */
function linearChannel(byte: number): number {
  const c = byte / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of `hex`, from 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** The WCAG contrast ratio of two colors, from 1 (no contrast) to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * `from`, moved `percent` of the way toward `toward`.
 *
 * The mix runs on the red, green, and blue channels, in TypeScript. This
 * gives `--pirate-surface`, `--pirate-border`, and `--pirate-muted` of
 * CLIENT-NOTES.md section 2. A test can read the result as one `#rrggbb`
 * string and compare it against a hand-computed value.
 */
function mix(from: string, toward: string, percent: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(toward);
  const t = percent / 100;
  return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/** The theme slot that matches the luminance of `theme`'s own background. */
function slotFor(theme: Theme): Mode {
  return relativeLuminance(theme.background) >= LIGHT_SLOT_LUMINANCE ? "light" : "dark";
}

/**
 * Set every `--pirate-*` custom property, and `color-scheme`, from `theme`.
 *
 * `src/login.css` reads the first five properties, and `src/style.css` reads
 * all eight with a dark fallback. Nothing else in the client sets them.
 */
function paintProperties(theme: Theme): void {
  const root = document.documentElement;
  root.style.setProperty("--pirate-bg", theme.background);
  root.style.setProperty("--pirate-fg", theme.foreground);
  root.style.setProperty("--pirate-surface", mix(theme.background, theme.foreground, 6));
  root.style.setProperty("--pirate-border", mix(theme.background, theme.foreground, 22));
  root.style.setProperty("--pirate-error", theme.red);
  root.style.setProperty("--pirate-muted", mix(theme.background, theme.foreground, 55));
  // `--pirate-ok` had no reader in `src/style.css`. Deleted instead of kept
  // as dead output. `src/style.css` now reads `--pirate-muted` for the
  // status line.
  root.style.setProperty("--pirate-warn", theme.yellow);
  root.style.colorScheme = slotFor(theme);
}

/** The text of the mode buttons. */
const DARK_LABEL = "dark";
const LIGHT_LABEL = "light";
/** The text of the import control. */
const IMPORT_LABEL = "choose file";

/**
 * Hide `input` from the screen, and keep it in the tab order.
 *
 * A file input is ugly by default. A `<label>` around a hidden input gives
 * the operator the native file dialog, with no ugly control on the screen.
 * This module may not edit `src/style.css`, so the rule runs as inline style.
 */
function hideVisually(input: HTMLElement): void {
  input.style.position = "absolute";
  input.style.width = "1px";
  input.style.height = "1px";
  input.style.overflow = "hidden";
  input.style.clipPath = "inset(50%)";
  input.style.whiteSpace = "nowrap";
}

/**
 * Give `label` the look of `#menu button`, of `src/style.css`.
 *
 * That CSS rule selects the `button` tag, so a `<label>` matches no such
 * rule. This module may not add a rule to `src/style.css`, so the same
 * declarations run here as inline style. A change to `#menu button` in
 * `src/style.css` will not reach this label. Report a mismatch if one shows.
 */
function styleAsButton(label: HTMLElement): void {
  label.style.font = "inherit";
  label.style.color = "inherit";
  label.style.background = "transparent";
  label.style.border = "1px solid var(--pirate-border, #2f3549)";
  label.style.borderRadius = "3px";
  label.style.padding = "0 6px";
  label.style.cursor = "pointer";
  label.style.display = "inline-block";
}

/**
 * Install the theme control.
 *
 * The function adds the theme rows to the menu, sets the custom properties of
 * the active theme, and puts that theme on the terminal.
 */
export function installTheme(runtime: Runtime): void {
  const darkButton = document.createElement("button");
  darkButton.id = "theme-dark";
  darkButton.type = "button";
  darkButton.textContent = DARK_LABEL;

  const lightButton = document.createElement("button");
  lightButton.id = "theme-light";
  lightButton.type = "button";
  lightButton.textContent = LIGHT_LABEL;

  const fileInput = document.createElement("input");
  fileInput.id = "theme-import";
  fileInput.type = "file";
  fileInput.accept = ".itermcolors";
  hideVisually(fileInput);

  const importLabel = document.createElement("label");
  importLabel.textContent = IMPORT_LABEL;
  styleAsButton(importLabel);
  importLabel.append(fileInput);

  /** Mark the active mode on the two buttons. This changes no color. */
  function syncButtons(mode: Mode): void {
    darkButton.setAttribute("aria-pressed", String(mode === "dark"));
    lightButton.setAttribute("aria-pressed", String(mode === "light"));
  }

  /**
   * Paint `theme` as the theme of `mode`. This writes nothing to the store.
   *
   * This covers the page, the menu, the login view, and the record on the
   * terminal. The canvas of the terminal takes its colors from the constructor
   * of the terminal, so `activate` builds the terminal again. The load path
   * needs no such build: `src/main.ts` already gave the stored theme to the
   * constructor.
   */
  function paint(theme: Theme, mode: Mode): void {
    paintProperties(theme);
    runtime.term.options.theme = theme;
    runtime.state.mode = mode;
    runtime.state.themeName = theme.name;
    syncButtons(mode);
  }

  /**
   * Store `theme` in the slot of `mode`, then paint the stored copy, and give
   * the focus back.
   *
   * The store validates every write, and a long theme name is one field it
   * clamps. Painting the value that `setPrefs` returns, instead of the raw
   * `theme` argument, keeps `state.themeName` and the canvas in step with
   * the record that actually persists. Painting the raw argument here would
   * show the operator a name longer than the one the next reload gives back.
   */
  function activate(theme: Theme, mode: Mode): void {
    const stored = mode === "dark" ? setPrefs({ mode, dark: theme }) : setPrefs({ mode, light: theme });
    paint(stored[mode], mode);
    // The whole client now holds the new theme, the terminal included, and the
    // operator needs no page reload. ghostty-web 0.4.0 bakes the cell colors
    // at `open()` time, so `rebuild` of `src/main.ts` builds a new terminal
    // with the new theme and asks the server for a full-state dump. The socket
    // stays open, so the shell survives. Only this path rebuilds: `activate`
    // runs for an operator change, and the load path at the end of
    // `installTheme` calls `paint` alone, on a terminal that the constructor
    // already colored.
    runtime.rebuild(stored[mode]);
    runtime.term.focus();
  }

  darkButton.addEventListener("click", () => {
    activate(prefs().dark, "dark");
  });
  lightButton.addEventListener("click", () => {
    activate(prefs().light, "light");
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    // Clear the input, so a second pick of the same file still fires this
    // event.
    fileInput.value = "";
    if (file === undefined) {
      return;
    }
    void file.text().then((text) => {
      const name = file.name.replace(/\.[^./\\]+$/, "");
      const result = parseItermColors(text, name);
      if (!result.ok) {
        setMenuNote(result.error);
        runtime.term.focus();
        return;
      }
      setMenuNote("");
      activate(result.theme, slotFor(result.theme));
    });
  });

  addMenuRow({ group: THEME_GROUP, label: "mode", controls: [darkButton, lightButton] });
  addMenuRow({
    group: THEME_GROUP,
    label: "import",
    controls: [importLabel],
  });

  const stored = prefs();
  paint(stored[stored.mode], stored.mode);
}
