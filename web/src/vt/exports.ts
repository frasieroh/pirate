/**
 * The raw exports of `ghostty-vt.wasm`.
 *
 * This interface names every wasm function that this layer calls. The names
 * and the argument order are the ABI of libghostty. The list was read from
 * the export section of `ghostty-web/ghostty-vt.wasm`, version 0.4.0.
 *
 * A pointer is a `number`: an offset into the linear memory of the module.
 * A boolean argument is a `number`, 0 or 1. The module has no notion of a
 * JavaScript boolean.
 */
export interface VtWasmExports {
  memory: WebAssembly.Memory;

  // Allocation. The module owns its heap, so every buffer that crosses the
  // boundary comes from these functions. Free each one with its pair.
  ghostty_wasm_alloc_u8(): number;
  ghostty_wasm_free_u8(ptr: number): void;
  ghostty_wasm_alloc_u8_array(len: number): number;
  ghostty_wasm_free_u8_array(ptr: number, len: number): void;
  ghostty_wasm_alloc_usize(): number;
  ghostty_wasm_free_usize(ptr: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;

  // Terminal lifetime and input.
  ghostty_terminal_new(cols: number, rows: number): number;
  ghostty_terminal_free(handle: number): void;
  ghostty_terminal_resize(handle: number, cols: number, rows: number): void;
  ghostty_terminal_write(handle: number, ptr: number, len: number): void;

  // The render state. It holds the snapshot that a renderer reads.
  ghostty_render_state_update(handle: number): number;
  ghostty_render_state_get_viewport(handle: number, ptr: number, cells: number): number;
  ghostty_render_state_get_cursor_x(handle: number): number;
  ghostty_render_state_get_cursor_y(handle: number): number;
  ghostty_render_state_get_cursor_visible(handle: number): number;
  ghostty_render_state_get_fg_color(handle: number): number;
  ghostty_render_state_get_bg_color(handle: number): number;
  ghostty_render_state_is_row_dirty(handle: number, row: number): number;
  ghostty_render_state_mark_clean(handle: number): void;
  /**
   * The row comes before the column.
   *
   * A measurement gives the order. A grid of `AB` on row 0 and `CD` on row 1
   * answers `C` for the arguments (1, 0) and `B` for the arguments (0, 1).
   * ghostty-web 0.4.0 passes the column first, so its `getGrapheme` reads the
   * transposed cell.
   */
  ghostty_render_state_get_grapheme(
    handle: number,
    row: number,
    col: number,
    ptr: number,
    max: number,
  ): number;

  // Scrollback.
  ghostty_terminal_get_scrollback_length(handle: number): number;
  ghostty_terminal_get_scrollback_line(
    handle: number,
    offset: number,
    ptr: number,
    cols: number,
  ): number;

  // Modes and responses.
  ghostty_terminal_is_alternate_screen(handle: number): number;
  ghostty_terminal_has_mouse_tracking(handle: number): number;
  ghostty_terminal_get_mode(handle: number, mode: number, ansi: number): number;
  ghostty_terminal_has_response(handle: number): number;
  ghostty_terminal_read_response(handle: number, ptr: number, max: number): number;

  // The key encoder.
  ghostty_key_encoder_new(allocator: number, out: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt(encoder: number, option: number, valuePtr: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    ptr: number,
    max: number,
    lenPtr: number,
  ): number;
  ghostty_key_event_new(allocator: number, out: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
  ghostty_key_event_set_unshifted_codepoint(event: number, codepoint: number): void;
}

/**
 * The dirty state that `ghostty_render_state_update` returns.
 *
 * FULL means that every row changed. The module reports FULL after a switch
 * between the normal screen and the alternate screen.
 */
export const DIRTY_NONE = 0;
export const DIRTY_FULL = 2;

/** The options of the key encoder. Option 0 is DEC mode 1, DECCKM. */
export const OPT_CURSOR_KEY_APPLICATION = 0;

/** The byte count of one cell record in the buffers that the module fills. */
export const CELL_BYTES = 16;

/**
 * The maximum count of codepoints in one grapheme cluster.
 *
 * The module truncates a longer cluster. ghostty-web 0.4.0 uses the same
 * limit for the same call.
 */
export const GRAPHEME_MAX = 16;

/** The buffer size for one terminal response. A DSR reply is a few bytes. */
export const RESPONSE_MAX = 256;

/** The buffer size for one encoded key. The longest kitty sequence is shorter. */
export const KEY_ENCODE_MAX = 32;
