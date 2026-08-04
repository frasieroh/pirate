/**
 * One terminal on the wasm VT engine.
 *
 * The wasm module owns the parser, the grid, the scrollback, the cursor, the
 * colors, the dirty state, the modes, and the key encoder. This class moves
 * bytes across the wasm boundary and gives the state to a renderer. It draws
 * nothing.
 *
 * Every view into the wasm memory is built at the point of use. A wasm memory
 * grows when the module allocates, and a growth detaches every existing
 * `ArrayBuffer` view of `memory.buffer`. A view that this class held across a
 * call into the module would therefore throw or read zeros.
 */

import {
  CELL_BYTES,
  DIRTY_FULL,
  DIRTY_NONE,
  GRAPHEME_MAX,
  KEY_ENCODE_MAX,
  OPT_CURSOR_KEY_APPLICATION,
  RESPONSE_MAX,
  type VtWasmExports,
} from "./exports";
import { Osc8Scanner } from "./osc8";
import type { VtCell, VtColors, VtCursor, VtKeyEvent } from "./types";

/** DEC mode 1, DECCKM. It selects the application form of the cursor keys. */
const MODE_CURSOR_KEYS = 1;
/** DEC mode 1004. The terminal reports focus and blur. */
const MODE_FOCUS_EVENTS = 1004;
/** DEC mode 2004. The terminal brackets a paste. */
const MODE_BRACKETED_PASTE = 2004;

export class VtTerminal {
  readonly cols: number;
  readonly rows: number;

  private readonly exports: VtWasmExports;
  private readonly handle: number;
  /** The wasm buffer that the module fills with cell records. */
  private readonly cellsPtr: number;
  private readonly cellsBytes: number;
  /** The wasm buffer that the module fills with grapheme codepoints. */
  private readonly graphemePtr: number;
  /** The cells of the viewport. This class reuses these objects each frame. */
  private readonly pool: VtCell[];
  private readonly scanner = new Osc8Scanner();
  private encoder = 0;
  private disposed = false;

  constructor(exports: VtWasmExports, cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new Error(`a terminal needs a positive cols and rows, got ${cols} by ${rows}`);
    }
    this.exports = exports;
    this.cols = cols;
    this.rows = rows;

    this.handle = exports.ghostty_terminal_new(cols, rows);
    if (this.handle === 0) {
      throw new Error(`the wasm module did not make a terminal of ${cols} by ${rows}`);
    }

    // One buffer serves the viewport and one scrollback line, because a
    // viewport of `cols` by `rows` is never smaller than one line of `cols`.
    this.cellsBytes = cols * rows * CELL_BYTES;
    this.cellsPtr = exports.ghostty_wasm_alloc_u8_array(this.cellsBytes);
    this.graphemePtr = exports.ghostty_wasm_alloc_u8_array(GRAPHEME_MAX * 4);
    if (this.cellsPtr === 0 || this.graphemePtr === 0) {
      exports.ghostty_terminal_free(this.handle);
      throw new Error("the wasm module is out of memory");
    }

    this.pool = [];
    for (let i = 0; i < cols * rows; i += 1) {
      this.pool.push(emptyCell());
    }
  }

  // ==========================================================================
  // Input
  // ==========================================================================

  /**
   * Write bytes to the parser.
   *
   * A string goes in as UTF-8. The parser accepts a partial escape sequence
   * at the end of a write and continues it on the next write.
   */
  write(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.length === 0) {
      return;
    }
    this.scanner.feed(bytes);
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    if (ptr === 0) {
      throw new Error(`the wasm module is out of memory for ${bytes.length} bytes`);
    }
    try {
      new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
      this.exports.ghostty_terminal_write(this.handle, ptr, bytes.length);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    }
  }

  // ==========================================================================
  // Cells
  // ==========================================================================

  /**
   * Read every cell of the viewport, in row-major order.
   *
   * The returned array and the cell objects in it are reused on the next
   * call. A caller that keeps a cell must copy it. `getLine` copies.
   */
  getViewport(): readonly VtCell[] {
    this.update();
    const count = this.cols * this.rows;
    const got = this.exports.ghostty_render_state_get_viewport(
      this.handle,
      this.cellsPtr,
      count,
    );
    if (got < 0) {
      return this.pool;
    }
    readCells(this.exports, this.cellsPtr, got, this.pool);
    return this.pool;
  }

  /**
   * Read one row of the viewport, as copies.
   *
   * A row outside the viewport gives null.
   */
  getLine(row: number): VtCell[] | null {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) {
      return null;
    }
    const viewport = this.getViewport();
    const start = row * this.cols;
    const line: VtCell[] = [];
    for (let i = 0; i < this.cols; i += 1) {
      line.push({ ...viewport[start + i] });
    }
    return line;
  }

  // ==========================================================================
  // Scrollback
  // ==========================================================================

  /** The count of lines in the scrollback. The viewport is not counted. */
  getScrollbackLength(): number {
    return this.exports.ghostty_terminal_get_scrollback_length(this.handle);
  }

  /**
   * Read one scrollback line, as copies.
   *
   * `offset` counts from the oldest line: 0 is the oldest, and
   * `getScrollbackLength() - 1` is the newest. An offset outside that range
   * gives null.
   */
  getScrollbackLine(offset: number): VtCell[] | null {
    if (!Number.isInteger(offset) || offset < 0) {
      return null;
    }
    this.update();
    const got = this.exports.ghostty_terminal_get_scrollback_line(
      this.handle,
      offset,
      this.cellsPtr,
      this.cols,
    );
    if (got < 0) {
      return null;
    }
    const line: VtCell[] = [];
    for (let i = 0; i < got; i += 1) {
      line.push(emptyCell());
    }
    readCells(this.exports, this.cellsPtr, got, line);
    return line;
  }

  // ==========================================================================
  // Cursor and colors
  // ==========================================================================

  getCursor(): VtCursor {
    this.update();
    return {
      x: this.exports.ghostty_render_state_get_cursor_x(this.handle),
      y: this.exports.ghostty_render_state_get_cursor_y(this.handle),
      visible: this.exports.ghostty_render_state_get_cursor_visible(this.handle) !== 0,
    };
  }

  /** The default foreground and background of the screen, as 8-bit RGB. */
  getColors(): VtColors {
    this.update();
    const fg = this.exports.ghostty_render_state_get_fg_color(this.handle);
    const bg = this.exports.ghostty_render_state_get_bg_color(this.handle);
    return {
      foreground: { r: (fg >> 16) & 0xff, g: (fg >> 8) & 0xff, b: fg & 0xff },
      background: { r: (bg >> 16) & 0xff, g: (bg >> 8) & 0xff, b: bg & 0xff },
    };
  }

  // ==========================================================================
  // Dirty state
  // ==========================================================================

  /** True when the given row changed after the last `clearDirty`. */
  isRowDirty(row: number): boolean {
    this.update();
    return this.exports.ghostty_render_state_is_row_dirty(this.handle, row) !== 0;
  }

  /** True when any row changed after the last `clearDirty`. */
  isDirty(): boolean {
    return this.update() !== DIRTY_NONE;
  }

  /**
   * True when every row must be drawn again.
   *
   * The module reports this state after a switch between the normal screen
   * and the alternate screen.
   */
  needsFullRedraw(): boolean {
    return this.update() === DIRTY_FULL;
  }

  /**
   * Mark the render state clean. Call this after a frame is drawn.
   *
   * The update comes first. The module collects the changes of the terminal
   * into the render state at the update, and it clears the render state at
   * the mark. Without the update, a write that came after the last read stays
   * uncollected, and the next read reports a full redraw.
   */
  clearDirty(): void {
    this.update();
    this.exports.ghostty_render_state_mark_clean(this.handle);
  }

  // ==========================================================================
  // Modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    return this.exports.ghostty_terminal_is_alternate_screen(this.handle) !== 0;
  }

  hasBracketedPaste(): boolean {
    return this.getMode(MODE_BRACKETED_PASTE);
  }

  hasFocusEvents(): boolean {
    return this.getMode(MODE_FOCUS_EVENTS);
  }

  hasMouseTracking(): boolean {
    return this.exports.ghostty_terminal_has_mouse_tracking(this.handle) !== 0;
  }

  /**
   * Read one mode by number.
   *
   * `ansi` is false for a DEC private mode, the form with the `?` prefix. It
   * is true for an ANSI mode.
   */
  getMode(mode: number, ansi = false): boolean {
    return this.exports.ghostty_terminal_get_mode(this.handle, mode, ansi ? 1 : 0) !== 0;
  }

  // ==========================================================================
  // Graphemes
  // ==========================================================================

  /**
   * Read the codepoints of the grapheme cluster at a viewport cell.
   *
   * A cell of one character gives one codepoint. A cell of a complex script,
   * or of an emoji with a zero-width joiner, gives more. An empty cell gives
   * one codepoint, 0. A cell outside the viewport gives null.
   *
   * The cell answers first, and the wasm call runs only for a cell that holds
   * a cluster. The wasm function reports one codepoint for an empty cell and
   * writes nothing into the buffer, so the buffer then holds whatever the
   * module left there. A measurement on a used heap gave the letter `n` for
   * an empty cell.
   */
  getGrapheme(x: number, y: number): number[] | null {
    if (!inRange(x, this.cols) || !inRange(y, this.rows)) {
      return null;
    }
    const cell = this.getViewport()[y * this.cols + x];
    if (cell.graphemeLength === 0) {
      return [cell.codepoint];
    }

    // The wasm function takes the row before the column. See the note on the
    // declaration of `ghostty_render_state_get_grapheme`.
    const got = this.exports.ghostty_render_state_get_grapheme(
      this.handle,
      y,
      x,
      this.graphemePtr,
      GRAPHEME_MAX,
    );
    if (got <= 0) {
      return [cell.codepoint];
    }
    const view = new Uint32Array(this.exports.memory.buffer, this.graphemePtr, got);
    return Array.from(view);
  }

  /**
   * Read the grapheme cluster at a viewport cell, as a string.
   *
   * An empty cell and a cell outside the viewport both give one space, so a
   * renderer needs no branch for them.
   */
  getGraphemeString(x: number, y: number): string {
    const codepoints = this.getGrapheme(x, y);
    if (codepoints === null || codepoints.length === 0 || codepoints[0] === 0) {
      return " ";
    }
    return String.fromCodePoint(...codepoints);
  }

  // ==========================================================================
  // Hyperlinks
  // ==========================================================================

  /**
   * Read the OSC 8 hyperlink URI of a viewport cell.
   *
   * A cell with no hyperlink gives null.
   *
   * The wasm module exports no accessor for the URI. It gives one number per
   * cell, `hyperlinkId`, and version 0.4.0 sets that number to 1 for every
   * cell with a hyperlink: a measurement with three different URIs on one row
   * gave the id 1 three times. The id therefore cannot select a URI. This
   * layer reads the URIs out of the byte stream instead, with `Osc8Scanner`.
   *
   * As a result, a stream with one URI gives that URI, and a stream with more
   * than one URI gives null. The alternative is a wrong URI, and a wrong URI
   * sends the user to the wrong page.
   */
  getHyperlinkUri(x: number, y: number): string | null {
    if (!inRange(x, this.cols) || !inRange(y, this.rows)) {
      return null;
    }
    const cell = this.getViewport()[y * this.cols + x];
    return cell.hyperlinkId === 0 ? null : this.scanner.uri();
  }

  /**
   * Read the OSC 8 hyperlink URI of a scrollback cell.
   *
   * The limit of `getHyperlinkUri` holds here too.
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    if (!inRange(col, this.cols)) {
      return null;
    }
    const line = this.getScrollbackLine(offset);
    if (line === null || col >= line.length) {
      return null;
    }
    return line[col].hyperlinkId === 0 ? null : this.scanner.uri();
  }

  // ==========================================================================
  // Responses
  // ==========================================================================

  /**
   * True when the terminal owes the host an answer.
   *
   * A sequence such as DSR, `ESC [ 6 n`, makes the terminal produce one.
   */
  hasResponse(): boolean {
    return this.exports.ghostty_terminal_has_response(this.handle) !== 0;
  }

  /**
   * Read the pending response, and remove it. With none pending, this gives
   * null.
   */
  readResponse(): string | null {
    if (!this.hasResponse()) {
      return null;
    }
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(RESPONSE_MAX);
    if (ptr === 0) {
      throw new Error("the wasm module is out of memory for a response");
    }
    try {
      const got = this.exports.ghostty_terminal_read_response(
        this.handle,
        ptr,
        RESPONSE_MAX,
      );
      if (got <= 0) {
        return null;
      }
      const bytes = new Uint8Array(this.exports.memory.buffer, ptr, got).slice();
      return new TextDecoder().decode(bytes);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, RESPONSE_MAX);
    }
  }

  // ==========================================================================
  // Key encoding
  // ==========================================================================

  /**
   * Encode a key event into the bytes that the host expects.
   *
   * A key that produces nothing, for example the Shift key alone, gives an
   * empty array.
   *
   * This method reads DEC mode 1 from the terminal and gives it to the
   * encoder before each call. That mode selects the application form of the
   * cursor keys, and a program such as vim sets it. Without this step the Up
   * key gives `ESC [ A` where the program expects `ESC O A`.
   */
  encodeKey(event: VtKeyEvent): Uint8Array {
    const encoder = this.keyEncoder();
    this.setEncoderOption(
      OPT_CURSOR_KEY_APPLICATION,
      this.getMode(MODE_CURSOR_KEYS) ? 1 : 0,
    );

    const eventPtr = this.newKeyEvent();
    const outPtr = this.exports.ghostty_wasm_alloc_u8_array(KEY_ENCODE_MAX);
    const lenPtr = this.exports.ghostty_wasm_alloc_usize();
    try {
      this.exports.ghostty_key_event_set_action(eventPtr, event.action);
      this.exports.ghostty_key_event_set_key(eventPtr, event.key);
      this.exports.ghostty_key_event_set_mods(eventPtr, event.mods);
      if (event.unshiftedCodepoint !== undefined) {
        this.exports.ghostty_key_event_set_unshifted_codepoint(
          eventPtr,
          event.unshiftedCodepoint,
        );
      }
      if (event.utf8 !== undefined && event.utf8.length > 0) {
        this.setKeyText(eventPtr, event.utf8);
      }

      const rc = this.exports.ghostty_key_encoder_encode(
        encoder,
        eventPtr,
        outPtr,
        KEY_ENCODE_MAX,
        lenPtr,
      );
      if (rc !== 0) {
        throw new Error(`the wasm module did not encode the key event: ${rc}`);
      }
      const len = new DataView(this.exports.memory.buffer).getUint32(lenPtr, true);
      return new Uint8Array(this.exports.memory.buffer, outPtr, len).slice();
    } finally {
      this.exports.ghostty_key_event_free(eventPtr);
      this.exports.ghostty_wasm_free_u8_array(outPtr, KEY_ENCODE_MAX);
      this.exports.ghostty_wasm_free_usize(lenPtr);
    }
  }

  // ==========================================================================
  // Lifetime
  // ==========================================================================

  /**
   * Free the wasm memory of this terminal.
   *
   * A second call does nothing. Every other method gives wrong results after
   * this call, because the handle is gone.
   *
   * CAUTION: ghostty-vt.wasm 0.4.0 corrupts its own heap in
   * `ghostty_terminal_free` in two measured cases. A later terminal of the
   * same module then reads wrong cells, or stops with "Out of bounds memory
   * access". Both measurements use the raw wasm exports, with no code of this
   * layer:
   *
   *   - A grid of 9 columns or fewer, with no write at all. A grid of 10
   *     columns or more stays clean.
   *   - A grid of 10 columns that held a grapheme cluster. A grid of 80
   *     columns by 24 rows stays clean.
   *
   * The defect is in the wasm module, so this layer cannot correct it. Give
   * the terminal the full width of a screen, or load one module for each
   * terminal that must go away.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.encoder !== 0) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
    this.exports.ghostty_wasm_free_u8_array(this.graphemePtr, GRAPHEME_MAX * 4);
    this.exports.ghostty_wasm_free_u8_array(this.cellsPtr, this.cellsBytes);
    this.exports.ghostty_terminal_free(this.handle);
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * Bring the render state up to the terminal state.
   *
   * Every read of a cell, a cursor, a color, a grapheme, or a scrollback line
   * needs this step first. The module builds the snapshot here. The call is
   * idempotent, and the dirty state holds until `clearDirty`.
   */
  private update(): number {
    return this.exports.ghostty_render_state_update(this.handle);
  }

  /** Make the key encoder on the first call, then reuse it. */
  private keyEncoder(): number {
    if (this.encoder !== 0) {
      return this.encoder;
    }
    const out = this.exports.ghostty_wasm_alloc_opaque();
    if (out === 0) {
      throw new Error("the wasm module is out of memory for a key encoder");
    }
    try {
      const rc = this.exports.ghostty_key_encoder_new(0, out);
      if (rc !== 0) {
        throw new Error(`the wasm module did not make a key encoder: ${rc}`);
      }
      this.encoder = new DataView(this.exports.memory.buffer).getUint32(out, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(out);
    }
    return this.encoder;
  }

  /** The encoder reads an option value through a pointer, not by value. */
  private setEncoderOption(option: number, value: number): void {
    const ptr = this.exports.ghostty_wasm_alloc_u8();
    if (ptr === 0) {
      throw new Error("the wasm module is out of memory for an encoder option");
    }
    try {
      new DataView(this.exports.memory.buffer).setUint8(ptr, value);
      this.exports.ghostty_key_encoder_setopt(this.encoder, option, ptr);
    } finally {
      this.exports.ghostty_wasm_free_u8(ptr);
    }
  }

  /** Make an empty key event and give its address. */
  private newKeyEvent(): number {
    const out = this.exports.ghostty_wasm_alloc_opaque();
    if (out === 0) {
      throw new Error("the wasm module is out of memory for a key event");
    }
    try {
      const rc = this.exports.ghostty_key_event_new(0, out);
      if (rc !== 0) {
        throw new Error(`the wasm module did not make a key event: ${rc}`);
      }
      return new DataView(this.exports.memory.buffer).getUint32(out, true);
    } finally {
      this.exports.ghostty_wasm_free_opaque(out);
    }
  }

  /**
   * Give the text of the key to the event.
   *
   * The module copies the bytes, so this method frees them at once.
   */
  private setKeyText(eventPtr: number, utf8: string): void {
    const bytes = new TextEncoder().encode(utf8);
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    if (ptr === 0) {
      throw new Error("the wasm module is out of memory for the text of a key");
    }
    try {
      new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
      this.exports.ghostty_key_event_set_utf8(eventPtr, ptr, bytes.length);
    } finally {
      this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    }
  }
}

/** A cell with the values that the module gives for an empty position. */
function emptyCell(): VtCell {
  return {
    codepoint: 0,
    fgR: 0,
    fgG: 0,
    fgB: 0,
    bgR: 0,
    bgG: 0,
    bgB: 0,
    flags: 0,
    width: 1,
    hyperlinkId: 0,
    graphemeLength: 0,
  };
}

/**
 * Read `count` cell records out of the wasm memory into `into`.
 *
 * The record is 16 bytes: a little-endian `u32` codepoint, three foreground
 * bytes, three background bytes, a flags byte, a width byte, a little-endian
 * `u16` hyperlink id, a grapheme length byte, and one byte of padding.
 */
function readCells(
  exports: VtWasmExports,
  ptr: number,
  count: number,
  into: VtCell[],
): void {
  const bytes = new Uint8Array(exports.memory.buffer, ptr, count * CELL_BYTES);
  const view = new DataView(exports.memory.buffer, ptr, count * CELL_BYTES);
  for (let i = 0; i < count; i += 1) {
    const at = i * CELL_BYTES;
    const cell = into[i];
    cell.codepoint = view.getUint32(at, true);
    cell.fgR = bytes[at + 4];
    cell.fgG = bytes[at + 5];
    cell.fgB = bytes[at + 6];
    cell.bgR = bytes[at + 7];
    cell.bgG = bytes[at + 8];
    cell.bgB = bytes[at + 9];
    cell.flags = bytes[at + 10];
    cell.width = bytes[at + 11];
    cell.hyperlinkId = view.getUint16(at + 12, true);
    cell.graphemeLength = bytes[at + 14];
  }
}

/** True when `value` is an integer from 0 to `limit` minus 1. */
function inRange(value: number, limit: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < limit;
}
