/**
 * The data types of the VT layer.
 *
 * Every type here is declared in this layer. Nothing comes from the
 * TypeScript layer of the package `ghostty-web`. The only thing that this
 * layer takes from that package is the wasm binary.
 *
 * The numbers in the enums are an ABI, not a choice of this file. The wasm
 * module writes and reads these numbers. A changed number gives wrong colors,
 * wrong styles, or a wrong control sequence.
 */

export { VtKey } from "./key-codes";

/** One color, in 8-bit components. */
export interface VtRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The style bits of a cell.
 *
 * The wasm module packs these bits into one byte of the cell record. Read
 * them with a bitwise AND, for example `(cell.flags & VtCellFlags.BOLD) !== 0`.
 */
export enum VtCellFlags {
  BOLD = 1,
  ITALIC = 2,
  UNDERLINE = 4,
  STRIKETHROUGH = 8,
  INVERSE = 16,
  INVISIBLE = 32,
  BLINK = 64,
  FAINT = 128,
}

/**
 * One cell of the grid.
 *
 * The color components are flat numbers, not a nested `VtRgb`. One viewport
 * of 80 by 24 holds 1920 cells, and a renderer reads them one time per frame.
 * A nested object per cell adds two more objects per cell to that path.
 *
 * `codepoint` is 0 for an empty cell. `width` is 0 for the second half of a
 * wide character, 1 for a narrow character, and 2 for a wide character.
 * `graphemeLength` is more than 0 when the cell holds a grapheme cluster. Read
 * that cluster with `getGrapheme` or `getGraphemeString`.
 */
export interface VtCell {
  codepoint: number;
  fgR: number;
  fgG: number;
  fgB: number;
  bgR: number;
  bgG: number;
  bgB: number;
  /** A bitset of `VtCellFlags`. */
  flags: number;
  width: number;
  /** 0 for a cell with no hyperlink. */
  hyperlinkId: number;
  graphemeLength: number;
}

/** The cursor, in viewport coordinates. The origin is the top left cell. */
export interface VtCursor {
  x: number;
  y: number;
  visible: boolean;
}

/** The default colors of the screen. */
export interface VtColors {
  foreground: VtRgb;
  background: VtRgb;
}

/** The action of a key event. */
export enum VtKeyAction {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}

/** The modifier bits of a key event. Combine them with a bitwise OR. */
export enum VtMods {
  NONE = 0,
  SHIFT = 1,
  CTRL = 2,
  ALT = 4,
  /** The Command key on macOS, and the Windows key elsewhere. */
  SUPER = 8,
  CAPSLOCK = 16,
  NUMLOCK = 32,
}

/**
 * One key event for the encoder.
 *
 * `utf8` holds the text that the key produces without the Control modifier.
 * The encoder needs it for a printable key. A key such as `VtKey.UP` needs no
 * `utf8`.
 */
export interface VtKeyEvent {
  action: VtKeyAction;
  key: number;
  /** A bitset of `VtMods`. */
  mods: number;
  utf8?: string;
  unshiftedCodepoint?: number;
}
