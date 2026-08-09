/**
 * The preference store.
 *
 * One cookie holds the whole record. The store writes no second cookie, and it
 * touches no localStorage and no sessionStorage.
 *
 * The auth token is never stored here, in any form. The only stored credential
 * of pirate is the `HttpOnly` cookie of the server, which no script can read.
 */

import { hasCommandModifier, isChord } from "./keys";
import { DARK, LIGHT } from "./theme";

/** The theme slot that `prefs.mode` selects. */
export type Mode = "dark" | "light";
/** The state of the menu panel. */
export type MenuState = "open" | "collapsed" | "hidden";
/** The name of one keybinding. */
export type BindingId = "toggleMenu" | "fontIncrease" | "fontDecrease";

/**
 * The shape of a theme.
 *
 * `src/theme.ts` owns the theme model and defines the same members. The two
 * types are structural, so a `Theme` of `theme.ts` goes into a slot of this
 * record without a conversion. This file implements no theme logic.
 */
export interface ThemeRecord {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The whole preference record. One cookie holds it. */
export interface Prefs {
  mode: Mode;
  /** The theme of the dark slot. */
  dark: ThemeRecord;
  /** The theme of the light slot. */
  light: ThemeRecord;
  /** The font size in pixels, 8 to 32. */
  fontSize: number;
  /**
   * The line height, as a multiplier of the cell height of the font metric.
   *
   * The range is 1.0 to 2.0. 1.0 gives the cell height of the font metric.
   */
  lineHeight: number;
  /** The key repeat rate in keys per second, 2 to 30. */
  repeatRate: number;
  /** The normalized chord of each binding. */
  keys: Record<BindingId, string>;
  menu: MenuState;
}

/** The name of the one cookie. */
export const COOKIE_NAME = "pirate.prefs";
/** One year, in seconds. */
const MAX_AGE_SECONDS = 31536000;
/**
 * The largest record that goes to the cookie.
 *
 * A cookie holds 4096 bytes. A larger record stays in memory, and the menu
 * shows the fault.
 */
const COOKIE_LIMIT_BYTES = 3800;

/** The smallest font size in pixels. */
const FONT_MIN = 8;
/** The largest font size in pixels. */
const FONT_MAX = 32;
/** The smallest line height, as a multiplier. */
const LINE_MIN = 1.0;
/** The largest line height, as a multiplier. */
const LINE_MAX = 2.0;
/** The quantum of the line height. The stored value is a multiple of it. */
const LINE_STEP = 0.1;
/** The smallest repeat rate in keys per second. */
const RATE_MIN = 2;
/** The largest repeat rate in keys per second. */
const RATE_MAX = 30;

/** The default chord of each binding, in the normalized form. */
export const DEFAULT_KEYS: Record<BindingId, string> = {
  toggleMenu: "alt+keyh",
  fontIncrease: "alt+equal",
  fontDecrease: "alt+minus",
};

/** Every binding, in the order that the menu shows and the registry matches. */
export const BINDING_IDS: BindingId[] = ["toggleMenu", "fontIncrease", "fontDecrease"];

/** The color members of a theme. `name` is the one member that is not a color. */
const COLOR_FIELDS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** A color of a theme. Every value is `#rrggbb`. */
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The largest length of a stored theme name, in codepoints.
 *
 * The name comes from a file name that the operator chose, so its raw length
 * has no bound. `encodeURIComponent` can expand one wide codepoint, such as
 * an emoji, to twelve encoded characters. Even at that worst case, 32
 * codepoints cost at most 384 encoded bytes: two clamped names, one for each
 * slot, stay far under `COOKIE_LIMIT_BYTES`.
 */
const THEME_NAME_MAX_CODEPOINTS = 32;

/**
 * `name`, cut to `THEME_NAME_MAX_CODEPOINTS` codepoints.
 *
 * `Array.from` splits a string by codepoint, not by UTF-16 code unit, so the
 * cut never splits one wide character, such as an emoji, in two.
 */
function clampThemeName(name: string): string {
  const codepoints = Array.from(name);
  return codepoints.length > THEME_NAME_MAX_CODEPOINTS
    ? codepoints.slice(0, THEME_NAME_MAX_CODEPOINTS).join("")
    : name;
}

/* The default themes live in `src/theme.ts`, which owns the theme model.
   The slots hold a `ThemeRecord`, and the validation above accepts any
   record of that shape. The dark background stays `#16161e`, which
   `tests/harness.ts` holds in `BACKGROUND`. */

/** A fresh record with every default value. */
export function defaultPrefs(): Prefs {
  return {
    mode: "dark",
    dark: { ...DARK },
    light: { ...LIGHT },
    fontSize: 14,
    lineHeight: 1.0,
    repeatRate: 10,
    keys: { ...DEFAULT_KEYS },
    menu: "open",
  };
}

/** The line for the menu when a record does not fit in the cookie. */
const FAULT_LINE =
  "The record did not fit in the cookie. pirate keeps it in memory for this session only. Make the change smaller. Try it again.";

/** The stored value, or null when the record is too large for a cookie. */
let fault: string | null = null;

/** The callback that runs after every write to the cookie, success or fault. */
let notifyFault: (line: string | null) => void = (): void => {};

/**
 * Give the store a callback for the fault line.
 *
 * `src/menu.ts` calls this one time, in `initMenu`. The store then calls the
 * callback after every write to the cookie, not only at page load, so a
 * fault that happens during the session still reaches the operator.
 */
export function onPrefsFault(callback: (line: string | null) => void): void {
  notifyFault = callback;
}

/** The record in memory. `prefs()` loads it on the first call. */
let current: Prefs | null = null;

/** The theme of `value`, or null when a member is absent or malformed. */
function readTheme(value: unknown): ThemeRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const source = value as Record<string, unknown>;
  if (typeof source.name !== "string" || source.name.length === 0) {
    return null;
  }
  const out: Record<string, string> = { name: clampThemeName(source.name) };
  for (const field of COLOR_FIELDS) {
    const color = source[field];
    if (typeof color !== "string" || !COLOR.test(color)) {
      return null;
    }
    out[field] = color;
  }
  // Every member is present and is a `#rrggbb` string, so the record is a
  // ThemeRecord. TypeScript cannot see that through the index signature.
  return out as unknown as ThemeRecord;
}

/**
 * `value` on the step and in the range, and `fallback` when it is neither.
 *
 * `step` is the quantum of the field, and 1 gives a whole number. The result
 * is the nearest multiple of the step. A field with a fractional step needs
 * this argument: `fontSize` holds 14 with the default step, and `lineHeight`
 * holds 1.5 with a step of 0.1. A round to a whole number stores 2.0 there,
 * and that value does not survive one reload.
 *
 * `toPrecision` removes the error of the binary float that the division and
 * the multiplication leave. 1.3 then stays 1.3 and does not become
 * 1.3000000000000003.
 */
function readNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  step = 1,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Number((Math.round(value / step) * step).toPrecision(12));
  if (rounded < min || rounded > max) {
    return fallback;
  }
  return rounded;
}

/**
 * The chords of `value`, with a default for each chord that fails a test.
 *
 * A chord must parse, and it must hold Alt, Control, or Meta. Two bindings
 * cannot hold one chord, so a repeat takes the default of its binding.
 */
function readKeys(value: unknown): Record<BindingId, string> {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const out = { ...DEFAULT_KEYS };
  const taken = new Set<string>();
  for (const id of BINDING_IDS) {
    const chord = source[id];
    let next = DEFAULT_KEYS[id];
    if (typeof chord === "string" && isChord(chord) && hasCommandModifier(chord)) {
      next = chord;
    }
    if (taken.has(next)) {
      next = DEFAULT_KEYS[id];
    }
    taken.add(next);
    out[id] = next;
  }
  return out;
}

/** A whole record built from `value`. Each faulty field takes its default. */
function validate(value: unknown): Prefs {
  const base = defaultPrefs();
  if (typeof value !== "object" || value === null) {
    return base;
  }
  const source = value as Record<string, unknown>;
  return {
    mode: source.mode === "light" ? "light" : "dark",
    dark: readTheme(source.dark) ?? base.dark,
    light: readTheme(source.light) ?? base.light,
    fontSize: readNumber(source.fontSize, FONT_MIN, FONT_MAX, base.fontSize),
    lineHeight: readNumber(source.lineHeight, LINE_MIN, LINE_MAX, base.lineHeight, LINE_STEP),
    repeatRate: readNumber(source.repeatRate, RATE_MIN, RATE_MAX, base.repeatRate),
    keys: readKeys(source.keys),
    menu:
      source.menu === "collapsed" || source.menu === "hidden" || source.menu === "open"
        ? source.menu
        : base.menu,
  };
}

/** The raw value of the cookie, or null when the browser holds no such cookie. */
function readCookie(): string | null {
  for (const part of document.cookie.split(";")) {
    const text = part.trim();
    if (text.startsWith(`${COOKIE_NAME}=`)) {
      return text.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}

/**
 * Write the record to the one cookie.
 *
 * A page on https gets the `secure` attribute. A page on http cannot, because
 * the browser drops a secure cookie that comes over a plain connection.
 */
function writeCookie(value: Prefs): void {
  const text = encodeURIComponent(JSON.stringify(value));
  if (text.length > COOKIE_LIMIT_BYTES) {
    fault = FAULT_LINE;
    notifyFault(fault);
    return;
  }
  fault = null;
  notifyFault(fault);
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie =
    `${COOKIE_NAME}=${text}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax` + secure;
}

/**
 * Read the record from the cookie.
 *
 * A cookie that does not parse gives the defaults, and the store writes the
 * defaults over it.
 */
export function loadPrefs(): Prefs {
  const raw = readCookie();
  if (raw === null) {
    return defaultPrefs();
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    const value = defaultPrefs();
    writeCookie(value);
    return value;
  }
  const value = validate(parsed);
  // A field that failed a test now holds its default. Write the corrected
  // record, so that the next load reads a clean cookie.
  if (encodeURIComponent(JSON.stringify(value)) !== raw) {
    writeCookie(value);
  }
  return value;
}

/** The record in memory. The first call reads the cookie. */
export function prefs(): Prefs {
  if (current === null) {
    current = loadPrefs();
  }
  return current;
}

/** Change the given fields, validate the whole record, and write the cookie. */
export function setPrefs(patch: Partial<Prefs>): Prefs {
  current = validate({ ...prefs(), ...patch });
  writeCookie(current);
  return current;
}

/**
 * The line that the menu shows when the store cannot write the cookie.
 *
 * Returns null when the last write reached the cookie.
 */
export function prefsFault(): string | null {
  return fault;
}
