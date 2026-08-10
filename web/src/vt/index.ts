/**
 * The VT layer of pirate.
 *
 * This is the entry point. It wraps the raw exports of `ghostty-vt.wasm`, the
 * WebAssembly build of libghostty. libghostty owns the VT100 state machine:
 * escape-sequence parsing, the grid, the scrollback, the cursor, the colors,
 * the dirty state, the modes, the grapheme clusters, and the key encoder.
 *
 * This layer stands alone. The only thing that it takes from the package
 * `ghostty-web` is the wasm binary. Every type here is declared in this
 * directory.
 *
 * This layer draws nothing. It touches no canvas, no WebGL, and no DOM.
 *
 * Use it in three steps:
 *
 *     const vt = await loadVt();
 *     const term = vt.createTerminal(80, 24);
 *     term.write("hello\r\n");
 */

export { loadVt, Vt, type VtWasmSource } from "./wasm";
export { VtTerminal } from "./terminal";
export {
  answerOf,
  DA1_ANSWER,
  QueryScanner,
  type Query,
  type QueryContext,
  type QueryEvent,
} from "./query";
export {
  VtCellFlags,
  VtKey,
  VtKeyAction,
  VtMods,
  type VtCell,
  type VtColors,
  type VtCursor,
  type VtKeyEvent,
  type VtRgb,
} from "./types";
