/**
 * The `.itermcolors` import.
 *
 * An `.itermcolors` file is an XML property list (a plist). The top-level
 * `<dict>` holds `Ansi 0 Color` through `Ansi 15 Color`, `Background Color`,
 * `Foreground Color`, `Cursor Color`, `Cursor Text Color`, `Selection Color`,
 * and `Selected Text Color`. Each of these is itself a `<dict>` with a
 * `Red Component`, a `Green Component`, and a `Blue Component`, each a
 * `<real>` from 0 to 1.
 *
 * A file that iTerm2 itself writes also carries a `Color Space` string and an
 * `Alpha Component` real inside each color `<dict>`. This parser ignores
 * both: every fixture that pirate ships holds sRGB components already, and
 * the client draws only opaque terminal colors, so an alpha value has no
 * effect on the theme.
 */

import type { Theme } from "./theme";

/** The line for a file that is not a valid `.itermcolors` file. */
const NOT_A_PLIST = "The file is not a valid .itermcolors file. Choose another file.";

/** The line for a file with no `key`. */
function missingKeyError(key: string): string {
  return `The file has no \`${key}\`. Choose a valid .itermcolors file.`;
}

/** The answer of `parseItermColors`. */
export type ItermParseResult = { ok: true; theme: Theme } | { ok: false; error: string };

/** The field of `Theme` for each key of the top-level `<dict>`, in order. */
const FIELD_KEYS: ReadonlyArray<[Exclude<keyof Theme, "name">, string]> = [
  ["background", "Background Color"],
  ["foreground", "Foreground Color"],
  ["cursor", "Cursor Color"],
  ["cursorAccent", "Cursor Text Color"],
  ["selectionBackground", "Selection Color"],
  ["selectionForeground", "Selected Text Color"],
  ["black", "Ansi 0 Color"],
  ["red", "Ansi 1 Color"],
  ["green", "Ansi 2 Color"],
  ["yellow", "Ansi 3 Color"],
  ["blue", "Ansi 4 Color"],
  ["magenta", "Ansi 5 Color"],
  ["cyan", "Ansi 6 Color"],
  ["white", "Ansi 7 Color"],
  ["brightBlack", "Ansi 8 Color"],
  ["brightRed", "Ansi 9 Color"],
  ["brightGreen", "Ansi 10 Color"],
  ["brightYellow", "Ansi 11 Color"],
  ["brightBlue", "Ansi 12 Color"],
  ["brightMagenta", "Ansi 13 Color"],
  ["brightCyan", "Ansi 14 Color"],
  ["brightWhite", "Ansi 15 Color"],
];

/**
 * The direct `<key>` and value pairs of `dict`, as a map.
 *
 * A plist `<dict>` holds a flat sequence of `<key>` elements, each followed
 * by one value element. This reads both the top-level `<dict>` and a color
 * `<dict>`, because the two have the same shape.
 */
function readDictEntries(dict: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  const children = Array.from(dict.children);
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node.tagName === "key") {
      const value = children[i + 1];
      if (value !== undefined) {
        map.set(node.textContent ?? "", value);
      }
    }
  }
  return map;
}

/** The number of a `<real>` element, or null when it is absent or malformed. */
function readReal(el: Element | undefined): number | null {
  if (el === undefined || el.tagName !== "real") {
    return null;
  }
  const value = Number(el.textContent);
  return Number.isFinite(value) ? value : null;
}

/** `value`, clamped to 0 to 1, as a byte from 0 to 255. */
function componentToByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/** Three byte values, each 0 to 255, as `#rrggbb`. */
function bytesToHex(r: number, g: number, b: number): string {
  const byte = (v: number): string => v.toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The `#rrggbb` of a color `<dict>`, or null when a component is absent. */
function readColorHex(dict: Element): string | null {
  const entries = readDictEntries(dict);
  const red = readReal(entries.get("Red Component"));
  const green = readReal(entries.get("Green Component"));
  const blue = readReal(entries.get("Blue Component"));
  if (red === null || green === null || blue === null) {
    return null;
  }
  return bytesToHex(componentToByte(red), componentToByte(green), componentToByte(blue));
}

/**
 * Parse the text of an `.itermcolors` file into a `Theme` named `name`.
 *
 * A file that is not a plist, or that has no `Background Color`, gives a
 * clear error line and no theme. The same holds for every other required
 * color: the theme needs a full set to go to `term.options.theme`.
 */
export function parseItermColors(xmlText: string, name: string): ItermParseResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { ok: false, error: NOT_A_PLIST };
  }
  const root = doc.documentElement;
  if (root === null || root.tagName !== "plist") {
    return { ok: false, error: NOT_A_PLIST };
  }
  const topDict = Array.from(root.children).find((el) => el.tagName === "dict");
  if (topDict === undefined) {
    return { ok: false, error: NOT_A_PLIST };
  }
  const entries = readDictEntries(topDict);

  const colors: Partial<Record<Exclude<keyof Theme, "name">, string>> = {};
  for (const [field, key] of FIELD_KEYS) {
    const valueEl = entries.get(key);
    const hex = valueEl === undefined ? null : readColorHex(valueEl);
    if (hex === null) {
      return { ok: false, error: missingKeyError(key) };
    }
    colors[field] = hex;
  }

  return { ok: true, theme: { name, ...colors } as Theme };
}
