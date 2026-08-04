/**
 * The ambient declaration for the Vite URL import of a wasm asset.
 *
 * `import "...wasm?url"` is a Vite instruction, not a TypeScript module.
 * Without this declaration `tsc --noEmit` stops with TS2307. `src/env.d.ts`
 * declares `*.css` for the same reason.
 *
 * `src/vt/wasm.ts` holds a reference directive to this file. The `include`
 * list of `web/tsconfig.tests.json` names `tests` and `bench` only, so this
 * file does not reach that program on its own.
 */

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
