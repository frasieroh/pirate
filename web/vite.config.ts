import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

/** The extensions that get a `.gz` and a `.br` copy. */
const COMPRESSIBLE = ["html", "js", "css", "json", "svg", "wasm", "map", "txt"];

/** Files smaller than this do not pay for the headers of a compressed form. */
const MIN_SIZE = 1024;

/** Where the data URI starts inside the ESM file of ghostty-web. */
const DATA_URI = "data:application/wasm;base64,";

/**
 * Precompression of the web assets.
 *
 * The server embeds the plain file and both compressed forms, then it chooses
 * one from the Accept-Encoding header. This plugin compresses each file one
 * time at build time, so the server compresses nothing at run time. This step
 * belongs to the web build, because `cargo build` must never need a JavaScript
 * toolchain and must find web/dist complete.
 */
function compress(): Plugin {
  let dist = "";
  let wrote = false;
  return {
    name: "pirate-compress",
    apply: "build",
    // `configResolved` gives the paths that Vite resolved. A path built from
    // `__dirname` breaks when the config moves or when Vite runs from a
    // different directory.
    configResolved(config) {
      dist = resolve(config.root, config.build.outDir);
    },
    // Vite calls `closeBundle` after a failed build too. `writeBundle` runs
    // after a complete write only, so this flag separates the two cases. A
    // failed build leaves the files of the previous build untouched.
    writeBundle() {
      wrote = true;
    },
    closeBundle() {
      if (!wrote) {
        return;
      }
      const count = compressTree(dist);
      console.log(`vite: compressed ${count} files in ${dist}`);
    },
  };
}

/**
 * This function writes a `.gz` and a `.br` beside every compressible file. It
 * returns the count of the files that it compressed.
 */
function compressTree(dir: string): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      count += compressTree(path);
      continue;
    }

    const dot = name.lastIndexOf(".");
    if (dot <= 0) {
      continue;
    }
    const ext = name.slice(dot + 1);
    if (!COMPRESSIBLE.includes(ext)) {
      continue;
    }

    const bytes = readFileSync(path);
    if (bytes.length < MIN_SIZE) {
      continue;
    }

    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 9 }));
    writeFileSync(
      `${path}.br`,
      brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_LGWIN]: 22,
        },
      }),
    );
    count += 1;
  }
  return count;
}

/**
 * The build information that only the JavaScript side knows.
 *
 * Two of the six values in `pirate --version --long` come from the installed
 * npm package: the ghostty-web version and the SHA-256 of the wasm module. The
 * `build.rs` script of pirate must not run bun, so this plugin writes them to
 * `web/build-info.toml` and `build.rs` reads that file.
 *
 * The order of the two hooks is the point of this plugin. A failed web build
 * must not leave an output that looks complete. Vite writes web/dist and
 * removes the previous content of that folder, and a build that stops after
 * that step leaves a bundle without the terminal parser. A stale
 * `build-info.toml` beside it makes the state look correct, and the next
 * `cargo build` then embeds the broken bundle without a warning.
 *
 * Therefore `buildStart` removes `build-info.toml` and reads every value,
 * before Vite writes one byte. A missing or inconsistent ghostty-web stops the
 * build there. `closeBundle` writes the file again, after the bundle is
 * complete. A failed build leaves no `build-info.toml`. `build.rs` warns loudly
 * for an absent file, and `cargo xtask web` fails for one.
 */
function buildInfo(): Plugin {
  let web = "";
  let body = "";
  let wrote = false;
  return {
    name: "pirate-build-info",
    apply: "build",
    configResolved(config) {
      web = config.root;
    },
    buildStart() {
      wrote = false;
      rmSync(join(web, "build-info.toml"), { force: true });
      body = readBuildInfo(web);
    },
    // Vite calls `closeBundle` after a failed build too, so this hook alone
    // cannot answer for a complete build. `writeBundle` runs after a complete
    // write only.
    writeBundle() {
      wrote = true;
    },
    closeBundle() {
      if (!wrote) {
        return;
      }
      writeFileSync(join(web, "build-info.toml"), body);
      console.log(`vite: wrote ${join(web, "build-info.toml")}`);
    },
  };
}

/**
 * This function reads the two values from the installed package and returns the
 * text of `build-info.toml`. It throws when a necessary file is absent or when
 * the two forms of the wasm module differ.
 */
function readBuildInfo(web: string): string {
  const pkg = join(web, "node_modules/ghostty-web");
  const manifestPath = join(pkg, "package.json");
  const manifest: unknown = JSON.parse(
    read(manifestPath, "the package.json of ghostty-web").toString("utf8"),
  );
  const version = readVersion(manifest);

  // ghostty-web ships the module twice: as a file, and as a base64 data URI
  // inside the ESM bundle. The browser loads the data URI first. This step
  // hashes the file, then it compares the two forms.
  const wasm = join(pkg, "ghostty-vt.wasm");
  const sha256 = createHash("sha256")
    .update(read(wasm, "the wasm module of ghostty-web"))
    .digest("hex");
  compareInlined(join(pkg, "dist/ghostty-web.js"), sha256);

  console.log(`vite: ghostty-web ${version}, wasm sha256 ${sha256}`);
  return (
    "# Generated by the web build (`bun run build`). Do not edit.\n" +
    "#\n" +
    "# The `build.rs` script of pirate must not run bun, npm, or Vite, so\n" +
    "# the web build writes these two values here and `build.rs` reads them.\n" +
    `ghostty_web_version = "${version}"\n` +
    `wasm_sha256 = "${sha256}"\n`
  );
}

/**
 * This function reads a file that the web build must have. A raw `ENOENT` from
 * Node names no fix, so an absent file gives the path and the command.
 */
function read(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new Error(
      `${what} is absent\n` +
        `  expected at ${path}\n` +
        "  Run `bun install` in web/, then build again.",
    );
  }
}

function readVersion(manifest: unknown): string {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      "the package.json of ghostty-web has no `version` string\n" +
        "  Run `bun install` in web/, then build again.",
    );
  }
  return manifest.version;
}

/**
 * This function decodes the inlined wasm module and compares it against the
 * file.
 *
 * A difference means that the file and the bundle hold different modules. One
 * SHA-256 cannot then describe the build, so a difference is an error.
 */
function compareInlined(esm: string, expected: string): void {
  let text: string;
  try {
    text = readFileSync(esm, "utf8");
  } catch {
    console.log(`vite: note: no ESM bundle at ${esm}`);
    return;
  }

  const start = text.indexOf(DATA_URI);
  if (start < 0) {
    console.log(`vite: note: ${esm} holds no inlined wasm module`);
    return;
  }

  const payload = /^[A-Za-z0-9+/]*/.exec(text.slice(start + DATA_URI.length));
  const bytes = Buffer.from(payload === null ? "" : payload[0], "base64");
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== expected) {
    throw new Error(
      `the inlined wasm module in ${esm} does not match ghostty-vt.wasm\n` +
        `  file    ${expected}\n  inlined ${got}`,
    );
  }
}

export default defineConfig({
  // Relative asset URLs, so the embedded bundle works from any mount point.
  base: "./",
  // `pirate-build-info` validates at `buildStart`, and `pirate-compress` runs
  // at `closeBundle`. Rollup calls every `buildStart` hook before it writes the
  // bundle, and every `closeBundle` hook after it. That difference of hook
  // holds the order, not the position in this array. `closeBundle` goes
  // through `hookParallel`, which gives no order between two plugins.
  plugins: [buildInfo(), compress()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // One JS file and one CSS file keep the embedded asset set small and make
    // the precompression step predictable.
    rollupOptions: {
      // `index.html` is the default input. The second input adds the WebGL2
      // renderer, which no file under `src/` imports today. The build writes
      // one entry chunk for each input. Therefore `assets/beamterm.js` and the
      // wasm module are in `web/dist` before the first import.
      //
      // The subpath `@beamterm/renderer/web` gives the build for the browser.
      // That build reads the wasm module with
      // `new URL("beamterm_renderer_bg.wasm", import.meta.url)`. Vite emits the
      // module into `dist/assets`, and the client fetches a local file. The
      // default subpath imports the wasm module as an ESM module, which needs
      // one more plugin.
      input: {
        index: "index.html",
        beamterm: "@beamterm/renderer/web",
      },
      // Without this option the build treeshakes the exports of an entry chunk
      // that no file imports. The chunk then loses the initialization function
      // and the reference to the wasm module. `strict` keeps the exports of
      // each entry. The entry of `index.html` exports nothing, so
      // `assets/index.js` does not change.
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5173,
  },
});
