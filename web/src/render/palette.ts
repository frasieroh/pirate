/**
 * The color map from a VT cell to a 24-bit color.
 *
 * The VT layer gives three bytes for the foreground and three bytes for the
 * background of each cell. It gives no palette index. libghostty resolves an
 * index to red, green, and blue inside the wasm module, with its own default
 * palette, before this layer sees the cell.
 *
 * Therefore this module maps the default palette back to the theme. A cell
 * color that equals a default palette entry gets the matching color of the
 * theme. Any other cell color goes to the screen without a change, which
 * covers the 216-color cube, the 24-step gray ramp, and every 24-bit color.
 *
 * Measurement, with `web/node_modules/ghostty-web/ghostty-vt.wasm` 0.4.0:
 * `ESC [ 38;5;n m` for n from 0 to 15 gives the 16 values of `DEFAULT_PALETTE`
 * below. `ESC [ 30 m` to `ESC [ 37 m` and `ESC [ 90 m` to `ESC [ 97 m` give
 * the same 16 values. `ESC [ 38;5;n m` for n from 16 to 255 gives the standard
 * xterm values: index 196 gives 255,0,0 and index 240 gives 88,88,88. A cell
 * that no SGR touched gives 204,204,204 for the foreground and 0,0,0 for the
 * background.
 *
 * None of the 16 default values is a member of the 216-color cube or of the
 * gray ramp, so an index from 0 to 15 and an index from 16 to 255 never
 * collide. Two collisions remain, and both come from the missing index:
 *
 * - `ESC [ 38;5;16 m` gives 0,0,0, and so does the default background. This
 *   module paints both with the background of the theme.
 * - A 24-bit color that equals a default palette entry, for example
 *   `ESC [ 38;2;204;102;102 m`, takes the theme color of that entry.
 */

import type { Theme } from "../theme";

/** A color as 0xRRGGBB. */
export type Rgb24 = number;

/** Pack three 8-bit components into 0xRRGGBB. */
export function packRgb(r: number, g: number, b: number): Rgb24 {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** Read `#rrggbb` as 0xRRGGBB. A malformed string gives 0. */
export function parseHex(hex: string): Rgb24 {
  const value = Number.parseInt(hex.slice(1), 16);
  return Number.isFinite(value) ? value & 0xffffff : 0;
}

/** The names of the 16 ANSI colors of a `Theme`, in palette order. */
const ANSI_NAMES = [
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
] as const satisfies readonly (keyof Theme)[];

/**
 * The default palette of ghostty-vt.wasm 0.4.0, in palette order.
 *
 * The values come from the measurement in the header of this file. A change of
 * the wasm module needs a new measurement here.
 */
const DEFAULT_PALETTE: readonly Rgb24[] = [
  0x1d1f21, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xc5c8c6, 0x666666,
  0xd54e53, 0xb9ca4a, 0xe7c547, 0x7aa6da, 0xc397d8, 0x70c0b1, 0xeaeaea,
];

/** The default foreground of a cell that no SGR touched. */
const DEFAULT_FOREGROUND: Rgb24 = 0xcccccc;

/** The default background of a cell that no SGR touched. */
const DEFAULT_BACKGROUND: Rgb24 = 0x000000;

/** How far a faint cell moves from its foreground toward its background. */
const FAINT_MIX = 0.5;

/**
 * The colors of one theme, ready for the renderer.
 *
 * Build a new one after a change of the theme. The map inside is small and
 * fixed, so a rebuild costs 18 map entries.
 */
export class Palette {
  /** The default background of the screen. */
  readonly background: Rgb24;
  /** The default foreground of the screen. */
  readonly foreground: Rgb24;
  /** The block color of the cursor. */
  readonly cursor: Rgb24;
  /** The color of the character under the cursor. */
  readonly cursorAccent: Rgb24;

  private readonly named = new Map<Rgb24, Rgb24>();

  constructor(theme: Theme) {
    this.background = parseHex(theme.background);
    this.foreground = parseHex(theme.foreground);
    this.cursor = parseHex(theme.cursor);
    this.cursorAccent = parseHex(theme.cursorAccent);
    for (let i = 0; i < DEFAULT_PALETTE.length; i += 1) {
      this.named.set(DEFAULT_PALETTE[i], parseHex(theme[ANSI_NAMES[i]]));
    }
    this.named.set(DEFAULT_FOREGROUND, this.foreground);
    this.named.set(DEFAULT_BACKGROUND, this.background);
  }

  /** The color to paint for one cell color. */
  resolve(color: Rgb24): Rgb24 {
    return this.named.get(color) ?? color;
  }
}

/** `from`, moved `amount` of the way toward `toward`, per channel. */
export function mixRgb(from: Rgb24, toward: Rgb24, amount: number): Rgb24 {
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (toward >> shift) & 0xff;
    return Math.round(a + (b - a) * amount);
  };
  return packRgb(channel(16), channel(8), channel(0));
}

/** The foreground of a faint cell: half the way to its own background. */
export function faint(foreground: Rgb24, background: Rgb24): Rgb24 {
  return mixRgb(foreground, background, FAINT_MIX);
}
