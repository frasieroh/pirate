/**
 * The loader of the VT engine.
 *
 * `loadVt` compiles and instantiates `ghostty-vt.wasm` and returns a `Vt`.
 * A `Vt` makes terminals. One module serves any count of terminals.
 *
 * The wasm binary comes from the package `ghostty-web`, at the subpath
 * `ghostty-web/ghostty-vt.wasm`. That package exports this subpath, so no
 * change to `web/vite.config.ts` is necessary.
 */

// The reference pulls the ambient declaration of the `?url` import into every
// program that holds this file. `web/tsconfig.tests.json` includes `tests` and
// `bench` only, so a declaration file under `src` does not reach that program
// through the `include` list.
/// <reference path="./wasm-asset.d.ts" />

import type { VtWasmExports } from "./exports";
import { VtTerminal } from "./terminal";

/**
 * Where the wasm binary comes from.
 *
 * A `BufferSource` holds the bytes. A `string` or a `URL` names a location
 * that `fetch` can read.
 */
export type VtWasmSource = BufferSource | string | URL;

/** The compiled and instantiated VT engine. */
export class Vt {
  private readonly exports: VtWasmExports;

  constructor(exports: VtWasmExports) {
    this.exports = exports;
  }

  /**
   * Make a terminal of `cols` columns and `rows` rows.
   *
   * Call `dispose` on the terminal when it is no longer in use. The wasm heap
   * holds the grid and the scrollback, and the JavaScript garbage collector
   * does not reach that heap.
   */
  createTerminal(cols: number, rows: number): VtTerminal {
    return new VtTerminal(this.exports, cols, rows);
  }
}

/**
 * Load the VT engine.
 *
 * With no argument, this function reads the URL of the asset through a
 * dynamic import of `ghostty-web/ghostty-vt.wasm?url`. Vite resolves that
 * import and copies the asset into the bundle.
 *
 * The import is dynamic, and it is inside this branch, for the unit tests.
 * `bun run test` runs `bun test`, not Vite, and bun cannot resolve the `?url`
 * suffix. A top-level import of that path therefore stops every test file in
 * this directory at parse time, before one test runs. A dynamic import inside
 * a branch runs only when the branch runs, so a test that gives the bytes
 * itself never reaches it. `web/tests/vt.spec.ts` reads the binary with
 * `Bun.file` and gives the bytes here.
 */
export async function loadVt(source?: VtWasmSource): Promise<Vt> {
  const bytes = await readWasm(source);
  const module = await WebAssembly.compile(bytes);

  // The module imports one function, `env.log`. It calls that function with a
  // pointer and a length into its own memory. The instance is not available
  // when this record is built, so the callback reads it from `holder`.
  const holder: { exports: VtWasmExports | null } = { exports: null };
  const instance = await WebAssembly.instantiate(module, {
    env: {
      log: (ptr: number, len: number): void => {
        const exports = holder.exports;
        if (exports === null) {
          return;
        }
        const text = new TextDecoder().decode(
          new Uint8Array(exports.memory.buffer, ptr, len),
        );
        console.log("[ghostty-vt]", text);
      },
    },
  });

  const exports = instance.exports as unknown as VtWasmExports;
  holder.exports = exports;
  return new Vt(exports);
}

/** Read the wasm bytes from the given source, or from the bundled asset. */
async function readWasm(source?: VtWasmSource): Promise<BufferSource> {
  if (source === undefined) {
    const asset = await import("ghostty-web/ghostty-vt.wasm?url");
    return fetchWasm(asset.default);
  }
  if (typeof source === "string" || source instanceof URL) {
    return fetchWasm(source);
  }
  return source;
}

/** Read the wasm bytes over `fetch`, and name the location when it fails. */
async function fetchWasm(url: string | URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `the wasm module of the VT layer did not load\n` +
        `  ${String(url)} answered ${response.status} ${response.statusText}`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(
      `the wasm module of the VT layer is empty\n  ${String(url)} gave 0 bytes`,
    );
  }
  return bytes;
}
