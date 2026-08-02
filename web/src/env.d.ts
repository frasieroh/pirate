/**
 * Ambient declarations for the assets that Vite resolves.
 *
 * `import "./style.css"` is a Vite instruction, not a TypeScript module.
 * Without this declaration `tsc --noEmit` stops with TS2882.
 */

declare module "*.css";
