/**
 * The grid renderer: `web/src/render`.
 *
 * The module under test draws with WebGL2. `paintedPixels` and
 * `canvasSignature` of `tests/harness.ts` read a 2D context, and a WebGL2
 * canvas gives null for that context, so both helpers give -1 here. This file
 * reads pixels with `readPixels` of the WebGL2 context instead.
 *
 * Measurement of the read, in this Chromium with `--enable-unsafe-swiftshader`:
 * `@beamterm/renderer` builds its context with `preserveDrawingBuffer` false,
 * and it passes no attribute record to `getContext`, so that option is not
 * reachable through its API. A read in the same task as `render` gives the
 * painted pixels. A read after one animation frame gives 0, 0, 0, 0, and
 * `toDataURL` after that frame gives an empty image. Therefore every pixel
 * assertion here draws and reads inside one `page.evaluate` call.
 *
 * The origin of `readPixels` is the bottom left corner. The row index of the
 * terminal counts from the top, so the conversion is
 * `glY = canvas.height - 1 - topY`.
 *
 * `src/main.ts` does not import the module under test, so the bundle in
 * `web/dist` does not hold it. This file builds the module with `Bun.build`
 * and gives it to the page as a blob module. The import of
 * `@beamterm/renderer/web` stays external, and the blob resolves it against
 * `dist/assets/beamterm.js`, which `web/vite.config.ts` already emits.
 *
 * The theme record is a copy of the dark default of `src/theme.ts`. That
 * module queries the DOM at the top level, so `bun test` cannot import it.
 * `tests/theme.spec.ts` keeps its own copy for the same reason.
 */

import { tmpdir } from "node:os";

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { openClient, server } from "./harness";

/** The escape byte, as text. */
const ESC = "\x1b";

/** A theme with a distinct value in every slot. A copy of `DARK`. */
const THEME = {
  name: "pirate dark",
  background: "#16161e",
  foreground: "#a9b1d6",
  cursor: "#c0caf5",
  cursorAccent: "#16161e",
  selectionBackground: "#283457",
  selectionForeground: "#c0caf5",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff899d",
  brightGreen: "#9fe044",
  brightYellow: "#faba4a",
  brightBlue: "#8db0ff",
  brightMagenta: "#c7a9ff",
  brightCyan: "#a4daff",
  brightWhite: "#c0caf5",
};

/** A second theme. Every color differs from the first one. */
const OTHER_THEME = { ...THEME, name: "probe light", background: "#ffffff", red: "#8c4351" };

/** A sample of the canvas: one cell, one point inside it. */
interface Sample {
  col: number;
  row: number;
  /** The point inside the cell, from 0 to 1. The default is the center. */
  fx?: number;
  fy?: number;
}

/** The page-side API that `install` puts on `globalThis`. */
interface GridApi {
  make(options: { cols: number; rows: number; fontSize: number; theme: unknown }): void;
  write(data: string): void;
  draw(): void;
  drawAndSample(samples: Sample[]): number[];
  cellSignature(col: number, row: number): number;
  call(name: string, args?: unknown[]): unknown;
  state(): {
    containerChildren: string[];
    canvasWidth: number;
    canvasHeight: number;
    cssWidth: string;
    cssHeight: string;
    hasWebgl2: boolean;
    has2d: boolean;
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    fitCols: number;
    fitRows: number;
    lastDrawnRows: number[];
    renderCalls: number;
    clearDirtyCalls: number;
    dpr: number;
  };
  reset(): void;
  setRatio(value: number): void;
}

let page: Page;

/** The source of the bundled module, and the wasm of the VT engine. */
let bundle = "";
let wasmBase64 = "";

beforeAll(async () => {
  const web = `${import.meta.dir}/..`;
  const entry = `${tmpdir()}/pirate-render-entry-${process.pid}.ts`;
  await Bun.write(
    entry,
    `export { GridRenderer } from "${web}/src/render/index.ts";\n` +
      `export { loadVt } from "${web}/src/vt/index.ts";\n`,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    // The renderer import stays external, so the page uses the one copy that
    // `dist/assets/beamterm.js` already holds. The wasm asset import of
    // `src/vt/wasm.ts` stays external too: it sits inside a branch that runs
    // only when `loadVt` gets no bytes, and this file always gives bytes.
    external: ["@beamterm/renderer/web", "ghostty-web/ghostty-vt.wasm?url"],
  });
  if (!built.success) {
    throw new Error(`the test bundle did not build: ${built.logs.join("\n")}`);
  }
  bundle = await built.outputs[0].text();
  const wasm = await Bun.file(`${web}/node_modules/ghostty-web/ghostty-vt.wasm`).bytes();
  wasmBase64 = Buffer.from(wasm).toString("base64");

  page = await openClient({ waitForConnection: false });
  await install(page);
});

afterAll(async () => {
  await page?.context().close();
});

/** Put the module and the page-side API on `globalThis.__grid`. */
async function install(where: Page): Promise<void> {
  const target = `${server().url}/assets/beamterm.js`;
  const source = bundle
    .replaceAll('"@beamterm/renderer/web"', `"${target}"`)
    .replaceAll("'@beamterm/renderer/web'", `'${target}'`);
  await where.evaluate(
    async (args: { source: string; wasm: string }) => {
      const url = URL.createObjectURL(new Blob([args.source], { type: "text/javascript" }));
      const mod = (await import(url)) as {
        GridRenderer: {
          create(container: HTMLElement, options: unknown): Promise<Record<string, unknown>>;
        };
        loadVt(bytes: BufferSource): Promise<{
          createTerminal(cols: number, rows: number): Record<string, unknown>;
        }>;
      };
      const binary = atob(args.wasm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const vt = await mod.loadVt(bytes);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box: any = {
        vt,
        mod,
        grid: null,
        term: null,
        container: null,
        canvas: null,
        renderCalls: 0,
        clearDirtyCalls: 0,
      };

      /** The WebGL2 context of the current canvas. */
      const context = (): WebGL2RenderingContext =>
        box.canvas.getContext("webgl2") as WebGL2RenderingContext;

      box.make = async (options: {
        cols: number;
        rows: number;
        fontSize: number;
        theme: unknown;
      }): Promise<void> => {
        box.reset();
        const container = document.createElement("div");
        container.id = "grid-host";
        container.style.cssText =
          "position:absolute;left:0;top:0;width:600px;height:400px;overflow:hidden";
        document.body.append(container);
        box.container = container;
        box.grid = await mod.GridRenderer.create(container, {
          fontSize: options.fontSize,
          theme: options.theme,
        });
        box.canvas = container.querySelector("canvas");
        // `render` is a method of the prototype, so it needs its receiver. An
        // unbound call would read `this` as undefined.
        const draw = (box.grid.render as (...a: unknown[]) => void).bind(box.grid);
        box.grid.render = (...a: unknown[]): void => {
          box.renderCalls += 1;
          draw(...a);
        };
        box.grid.resize(options.cols, options.rows);
        box.term = box.vt.createTerminal(options.cols, options.rows);
        const clear = box.term.clearDirty.bind(box.term);
        box.term.clearDirty = (): void => {
          box.clearDirtyCalls += 1;
          clear();
        };
      };

      box.reset = (): void => {
        // This module never frees a VT terminal. `ghostty_terminal_free`
        // corrupts the wasm heap of ghostty-vt.wasm 0.4.0.
        box.grid?.dispose();
        box.container?.remove();
        box.grid = null;
        box.term = null;
        box.container = null;
        box.canvas = null;
        box.renderCalls = 0;
        box.clearDirtyCalls = 0;
      };

      box.write = (data: string): void => {
        box.term.write(data);
      };

      box.draw = (): void => {
        box.grid.draw(box.term);
      };

      /**
       * Draw, then read one point of each sample, in the same task.
       *
       * The drawing buffer of the context holds no paint after the frame
       * composites, so the read cannot wait for another task.
       */
      box.drawAndSample = (
        samples: { col: number; row: number; fx?: number; fy?: number }[],
      ): number[] => {
        box.grid.draw(box.term);
        const gl = context();
        const canvas = box.canvas as HTMLCanvasElement;
        const cellWidth = canvas.width / box.grid.cols;
        const cellHeight = canvas.height / box.grid.rows;
        const out: number[] = [];
        const pixel = new Uint8Array(4);
        for (const s of samples) {
          const x = Math.floor((s.col + (s.fx ?? 0.5)) * cellWidth);
          const top = Math.floor((s.row + (s.fy ?? 0.5)) * cellHeight);
          gl.readPixels(
            x,
            canvas.height - 1 - top,
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixel,
          );
          out.push((pixel[0] << 16) | (pixel[1] << 8) | pixel[2]);
        }
        return out;
      };

      /** Draw, then hash every pixel of one cell box. */
      box.cellSignature = (col: number, row: number): number => {
        box.grid.draw(box.term);
        const gl = context();
        const canvas = box.canvas as HTMLCanvasElement;
        const cellWidth = Math.floor(canvas.width / box.grid.cols);
        const cellHeight = Math.floor(canvas.height / box.grid.rows);
        const data = new Uint8Array(cellWidth * cellHeight * 4);
        gl.readPixels(
          col * cellWidth,
          canvas.height - (row + 1) * cellHeight,
          cellWidth,
          cellHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
        );
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += 1) {
          hash = Math.imul(hash ^ data[i], 16777619);
        }
        return hash >>> 0;
      };

      box.call = (name: string, args: unknown[] = []): unknown => {
        const result = box.grid[name](...args);
        return result === undefined ? null : result;
      };

      box.setRatio = (value: number): void => {
        Object.defineProperty(window, "devicePixelRatio", {
          value,
          configurable: true,
        });
      };

      box.state = (): unknown => {
        const canvas = box.canvas as HTMLCanvasElement;
        const cell = box.grid.cellSize();
        const fit = box.grid.fit();
        return {
          containerChildren: Array.from(box.container.children).map(
            (n) => (n as Element).tagName,
          ),
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          cssWidth: canvas.style.width,
          cssHeight: canvas.style.height,
          hasWebgl2: canvas.getContext("webgl2") !== null,
          has2d: canvas.getContext("2d") !== null,
          cols: box.grid.cols,
          rows: box.grid.rows,
          cellWidth: cell.width,
          cellHeight: cell.height,
          fitCols: fit.cols,
          fitRows: fit.rows,
          lastDrawnRows: Array.from(box.grid.lastDrawnRows as number[]),
          renderCalls: box.renderCalls,
          clearDirtyCalls: box.clearDirtyCalls,
          dpr: window.devicePixelRatio,
        };
      };

      (globalThis as unknown as { __grid: unknown }).__grid = box;
    },
    { source, wasm: wasmBase64 },
  );
}

/** Build a grid and a terminal of the given size. */
async function make(
  cols: number,
  rows: number,
  options?: { fontSize?: number; theme?: unknown },
): Promise<void> {
  await page.evaluate(
    async (args: { cols: number; rows: number; fontSize: number; theme: unknown }) => {
      await (
        globalThis as unknown as { __grid: { make(o: unknown): Promise<void> } }
      ).__grid.make(args);
    },
    {
      cols,
      rows,
      fontSize: options?.fontSize ?? 16,
      theme: options?.theme ?? THEME,
    },
  );
}

/** Write to the terminal, draw, then read one point of each sample. */
function drawAndSample(data: string, samples: Sample[]): Promise<number[]> {
  return page.evaluate(
    (args: { data: string; samples: Sample[] }) => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      if (args.data.length > 0) {
        grid.write(args.data);
      }
      return grid.drawAndSample(args.samples);
    },
    { data, samples },
  );
}

/** The state record of the page-side API. */
function state(): Promise<ReturnType<GridApi["state"]>> {
  return page.evaluate(
    () => (globalThis as unknown as { __grid: GridApi }).__grid.state() as never,
  );
}

/** `0xrrggbb` as text, for a readable failure. */
function show(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, "0")}`;
}

// ============================================================================
// The canvas
// ============================================================================

describe("the canvas", () => {
  test("create builds one WebGL2 canvas inside the container", async () => {
    await make(20, 6);
    const s = await state();
    expect(s.containerChildren).toEqual(["CANVAS"]);
    expect(s.hasWebgl2).toBe(true);
    expect(s.has2d).toBe(false);
  });

  test("the container holds no textarea and no second canvas", async () => {
    await make(20, 6);
    const counts = await page.evaluate(() => {
      const host = document.querySelector("#grid-host") as HTMLElement;
      return {
        canvases: host.querySelectorAll("canvas").length,
        textareas: host.querySelectorAll("textarea").length,
        all: host.querySelectorAll("*").length,
      };
    });
    expect(counts).toEqual({ canvases: 1, textareas: 0, all: 1 });
  });
});

// ============================================================================
// The characters
// ============================================================================

describe("the characters", () => {
  test("draw paints the characters of the viewport", async () => {
    await make(20, 6);
    // A full block fills its cell with the foreground color. A space leaves
    // the background. The pair proves that the paint follows the viewport.
    const colors = await drawAndSample(`${ESC}[38;2;18;52;86m█ █`, [
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
    expect(show(colors[0])).toBe("#123456");
    expect(show(colors[1])).toBe(show(0x16161e));
    expect(show(colors[2])).toBe("#123456");
  });

  test("draw paints a character on a later row", async () => {
    await make(20, 6);
    const colors = await drawAndSample(`\r\n\r\n${ESC}[38;2;18;52;86m█`, [
      { col: 0, row: 2 },
      { col: 0, row: 0 },
    ]);
    expect(show(colors[0])).toBe("#123456");
    expect(show(colors[1])).toBe(show(0x16161e));
  });
});

// ============================================================================
// The colors
// ============================================================================

describe("the colors", () => {
  test("the 16 named colors come from the theme", async () => {
    await make(20, 6);
    const sgr = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    const data = sgr.map((code) => `${ESC}[${code}m█`).join("");
    const samples = sgr.map((_, i) => ({ col: i, row: 0 }));
    const colors = await drawAndSample(data, samples);
    const expected = [
      THEME.black,
      THEME.red,
      THEME.green,
      THEME.yellow,
      THEME.blue,
      THEME.magenta,
      THEME.cyan,
      THEME.white,
      THEME.brightBlack,
      THEME.brightRed,
      THEME.brightGreen,
      THEME.brightYellow,
      THEME.brightBlue,
      THEME.brightMagenta,
      THEME.brightCyan,
      THEME.brightWhite,
    ];
    expect(colors.map(show)).toEqual(expected);
  });

  test("the 216-color cube comes from the xterm palette", async () => {
    await make(20, 6);
    // Index 17 is 0,0,95. Index 100 is 135,135,0. Index 196 is 255,0,0.
    const colors = await drawAndSample(
      `${ESC}[38;5;17m█${ESC}[38;5;100m█${ESC}[38;5;196m█`,
      [
        { col: 0, row: 0 },
        { col: 1, row: 0 },
        { col: 2, row: 0 },
      ],
    );
    expect(colors.map(show)).toEqual(["#00005f", "#878700", "#ff0000"]);
  });

  test("the 24-step gray ramp comes from the xterm palette", async () => {
    await make(20, 6);
    // Index 232 is 8,8,8. Index 243 is 118,118,118. Index 255 is 238,238,238.
    const colors = await drawAndSample(
      `${ESC}[38;5;232m█${ESC}[38;5;243m█${ESC}[38;5;255m█`,
      [
        { col: 0, row: 0 },
        { col: 1, row: 0 },
        { col: 2, row: 0 },
      ],
    );
    expect(colors.map(show)).toEqual(["#080808", "#767676", "#eeeeee"]);
  });

  test("a 24-bit foreground paints its exact RGB, in the order red green blue", async () => {
    await make(20, 6);
    // 16, 32, 48 is not a palindrome. A swap of red and blue would give
    // #302010 here. This is the proof of the byte order of the cell record.
    const colors = await drawAndSample(`${ESC}[38;2;16;32;48m█`, [{ col: 0, row: 0 }]);
    expect(show(colors[0])).toBe("#102030");
  });

  test("a 24-bit background paints its exact RGB, in the order red green blue", async () => {
    await make(20, 6);
    const colors = await drawAndSample(`${ESC}[48;2;16;32;48m `, [{ col: 0, row: 0 }]);
    expect(show(colors[0])).toBe("#102030");
  });

  test("the default background comes from the theme", async () => {
    await make(20, 6);
    const colors = await drawAndSample("", [{ col: 5, row: 3 }]);
    expect(show(colors[0])).toBe(THEME.background);
  });

  test("the default foreground comes from the theme", async () => {
    await make(20, 6);
    const colors = await drawAndSample("█", [{ col: 0, row: 0 }]);
    expect(show(colors[0])).toBe(THEME.foreground);
  });
});

// ============================================================================
// The attributes
// ============================================================================

describe("the attributes", () => {
  /** The hash of one cell box, after a write and a draw. */
  async function signature(data: string): Promise<number> {
    await make(20, 6);
    return page.evaluate((text: string) => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write(text);
      return grid.cellSignature(0, 0);
    }, data);
  }

  test("bold changes the paint of the cell", async () => {
    const plain = await signature("M");
    const bold = await signature(`${ESC}[1mM`);
    expect(bold).not.toBe(plain);
  });

  test("italic changes the paint of the cell", async () => {
    const plain = await signature("M");
    const italic = await signature(`${ESC}[3mM`);
    expect(italic).not.toBe(plain);
  });

  test("underline changes the paint of the cell", async () => {
    const plain = await signature("M");
    const underline = await signature(`${ESC}[4mM`);
    expect(underline).not.toBe(plain);
  });

  test("strikethrough changes the paint of the cell", async () => {
    const plain = await signature("M");
    const strike = await signature(`${ESC}[9mM`);
    expect(strike).not.toBe(plain);
  });

  test("INVERSE swaps the foreground and the background", async () => {
    await make(20, 6);
    // The cell holds a space, so the whole cell box shows the background. With
    // INVERSE the background takes the foreground color of the cell.
    const colors = await drawAndSample(`${ESC}[38;2;16;32;48m${ESC}[7m `, [
      { col: 0, row: 0 },
    ]);
    expect(show(colors[0])).toBe("#102030");
  });

  test("INVISIBLE paints the cell in the background color", async () => {
    await make(20, 6);
    const colors = await drawAndSample(
      `${ESC}[48;2;16;32;48m${ESC}[38;2;255;255;255m${ESC}[8m█`,
      [
        { col: 0, row: 0, fx: 0.5, fy: 0.5 },
        { col: 0, row: 0, fx: 0.1, fy: 0.2 },
      ],
    );
    expect(colors.map(show)).toEqual(["#102030", "#102030"]);
  });

  test("FAINT moves the foreground half the way to the background", async () => {
    await make(20, 6);
    // Foreground 255,255,255 over background 16,32,48 gives 136,144,152 at
    // half. `Math.round` gives 136 for 135.5.
    const colors = await drawAndSample(
      `${ESC}[48;2;16;32;48m${ESC}[38;2;255;255;255m${ESC}[2m█`,
      [{ col: 0, row: 0 }],
    );
    expect(show(colors[0])).toBe("#889098");
  });
});

// ============================================================================
// The wide characters
// ============================================================================

describe("the wide characters", () => {
  /**
   * `batch.text` of `@beamterm/renderer` 1.0.0 walks a run by grapheme
   * cluster, and it advances by the display width of the cluster. A wide
   * cluster takes two columns. The second half of a wide character therefore
   * carries no character of its own in a run.
   */
  test("a wide character does not move the rest of its run", async () => {
    await make(20, 6);
    // The cells of row 0 are: a wide ideograph, its second half, and two full
    // blocks. The blocks belong to columns 2 and 3.
    const colors = await drawAndSample(`${ESC}[38;2;18;52;86m漢██`, [
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ]);
    expect(colors.map(show)).toEqual(["#123456", "#123456"]);
  });

  test("a wide character paints across both of its columns", async () => {
    await make(20, 6);
    const colors = await drawAndSample(`${ESC}[38;2;255;255;255m漢`, [
      { col: 0, row: 0, fx: 0.9 },
      { col: 1, row: 0, fx: 0.1 },
    ]);
    for (const color of colors) {
      expect(show(color)).not.toBe(THEME.background);
    }
  });

  test("a grapheme cluster does not move the rest of its run", async () => {
    await make(20, 6);
    // `e` and a combining acute accent make one cluster of one column.
    const colors = await drawAndSample(`${ESC}[38;2;18;52;86mAé█`, [
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ]);
    expect(show(colors[0])).toBe("#123456");
    expect(show(colors[1])).toBe(THEME.cursor);
  });

  test("the wide character comes back when the cursor leaves its second half", async () => {
    await make(20, 6);
    // The cursor moves onto column 1, the second half of the ideograph.
    await drawAndSample(`${ESC}[38;2;255;255;255m漢${ESC}[1;2H`, [{ col: 1, row: 0 }]);
    // The cursor moves to row 1. Row 0 is not dirty, so the restore of the old
    // cursor cell is the only paint of that row.
    const colors = await drawAndSample(`${ESC}[2;1H`, [
      { col: 0, row: 0, fx: 0.9 },
      { col: 1, row: 0, fx: 0.1 },
    ]);
    for (const color of colors) {
      expect(show(color)).not.toBe(THEME.background);
      expect(show(color)).not.toBe(THEME.cursor);
    }
  });
});

// ============================================================================
// The cursor
// ============================================================================

describe("the cursor", () => {
  test("the cursor paints at the position that the terminal reports", async () => {
    await make(20, 6);
    const colors = await drawAndSample("ab", [
      { col: 2, row: 0 },
      { col: 3, row: 0 },
    ]);
    expect(show(colors[0])).toBe(THEME.cursor);
    expect(show(colors[1])).toBe(THEME.background);
  });

  test("the cursor does not paint when it is not visible", async () => {
    await make(20, 6);
    const colors = await drawAndSample(`ab${ESC}[?25l`, [{ col: 2, row: 0 }]);
    expect(show(colors[0])).toBe(THEME.background);
  });

  test("the cell that the cursor leaves goes back to its own colors", async () => {
    await make(20, 6);
    await drawAndSample("ab", [{ col: 2, row: 0 }]);
    // The cursor moves to row 1. Row 0 is not dirty after the move, so the old
    // cursor cell needs its own restore.
    const colors = await drawAndSample("\r\n", [
      { col: 2, row: 0 },
      { col: 0, row: 1 },
    ]);
    expect(show(colors[0])).toBe(THEME.background);
    expect(show(colors[1])).toBe(THEME.cursor);
  });
});

// ============================================================================
// The device pixel ratio
// ============================================================================

describe("the device pixel ratio", () => {
  test("the backing store is the CSS size times the device pixel ratio", async () => {
    await make(20, 6);
    const s = await state();
    expect(s.dpr).toBe(1);
    expect(s.canvasWidth).toBe(Math.round(Number.parseFloat(s.cssWidth) * s.dpr));
    expect(s.canvasHeight).toBe(Math.round(Number.parseFloat(s.cssHeight) * s.dpr));
    expect(s.canvasWidth).toBe(Math.round(s.cols * s.cellWidth * s.dpr));
  });

  test("a change of the device pixel ratio between draws changes the backing store", async () => {
    await make(20, 6);
    const before = await state();
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.setRatio(2);
    });
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.draw();
    });
    const after = await state();
    expect(after.dpr).toBe(2);
    expect(after.canvasWidth).toBe(Math.round(Number.parseFloat(after.cssWidth) * 2));
    expect(after.canvasHeight).toBe(Math.round(Number.parseFloat(after.cssHeight) * 2));
    expect(after.canvasWidth).toBeGreaterThan(before.canvasWidth);
    expect(after.canvasHeight).toBeGreaterThan(before.canvasHeight);
    // The CSS box keeps the size of one cell, so the grid covers the same
    // area. The rounding of the atlas moves it by less than one pixel per cell.
    expect(Math.abs(after.cellWidth - before.cellWidth)).toBeLessThan(1);
    expect(Math.abs(after.cellHeight - before.cellHeight)).toBeLessThan(1);
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.setRatio(1);
    });
  });

  test("the paint is correct after a change of the device pixel ratio", async () => {
    await make(20, 6);
    await drawAndSample(`${ESC}[38;2;16;32;48m█`, [{ col: 0, row: 0 }]);
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.setRatio(2);
    });
    const colors = await drawAndSample("", [{ col: 0, row: 0 }]);
    expect(show(colors[0])).toBe("#102030");
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.setRatio(1);
    });
  });
});

// ============================================================================
// The dirty state
// ============================================================================

describe("the dirty state", () => {
  test("the first draw paints every row", async () => {
    await make(20, 6);
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.draw();
    });
    const s = await state();
    expect(s.lastDrawnRows).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a later draw paints only the dirty rows", async () => {
    await make(20, 6);
    await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("\r\n\r\n\r\n");
      grid.draw();
      grid.write("hello");
      grid.draw();
    });
    const s = await state();
    expect(s.lastDrawnRows).toEqual([3]);
  });

  test("a draw with no change paints no row", async () => {
    await make(20, 6);
    await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("hello");
      grid.draw();
      grid.draw();
    });
    const s = await state();
    expect(s.lastDrawnRows).toEqual([]);
  });

  test("a draw with no change calls no render", async () => {
    // This assertion replaces "a draw with no change still calls render one
    // time". The old behavior presented the canvas on every animation frame,
    // and a WebGL canvas that the page presents costs the compositor a frame
    // even when no cell changed. Measurement, in Chromium with
    // `--enable-unsafe-swiftshader`, on an idle 109 by 38 terminal: a `render`
    // on each frame held an animation frame loop at 22 frames per second and
    // stretched a `setTimeout` of 100 ms to 192 ms. Without it the same loop
    // ran at 121 frames per second and the timer fired every 101 ms. The key
    // repeat of `src/input.ts` runs on such a timer, so the old behavior gave
    // the operator half the repeat rate that the menu reported, and
    // `tests/repeat.spec.ts` measured 8 frames where it requires more than 8.
    //
    // The drawing buffer is preserved, so the canvas keeps the last paint
    // while no `render` runs. The test below proves that a later change still
    // reaches the canvas.
    await make(20, 6);
    const calls = await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.draw();
      const before = grid.state().renderCalls;
      grid.draw();
      return { before, after: grid.state().renderCalls };
    });
    expect(calls.after).toBe(calls.before);
  });

  test("a draw after a change calls render one time", async () => {
    await make(20, 6);
    const calls = await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("hello");
      grid.draw();
      const before = grid.state().renderCalls;
      grid.write("!");
      grid.draw();
      return { before, after: grid.state().renderCalls };
    });
    expect(calls.after).toBe(calls.before + 1);
  });

  test("a full redraw paints every row again", async () => {
    await make(20, 6);
    // `ESC [ ? 1049 h` switches to the alternate screen, and the module then
    // reports a full redraw.
    await page.evaluate((esc: string) => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.draw();
      grid.write(`${esc}[?1049h`);
      grid.draw();
    }, ESC);
    const s = await state();
    expect(s.lastDrawnRows).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("draw clears the dirty state one time for each call that paints", async () => {
    // This assertion replaces "one time for each call". A draw that finds no
    // change now paints no cell and clears nothing, because there is nothing
    // to clear. A draw that paints still clears the state one time, so no row
    // paints twice.
    await make(20, 6);
    const counts = await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("hello");
      grid.draw();
      const one = grid.state().clearDirtyCalls;
      grid.draw();
      const two = grid.state().clearDirtyCalls;
      grid.write("!");
      grid.draw();
      return { one, two, three: grid.state().clearDirtyCalls };
    });
    expect(counts.one).toBe(1);
    expect(counts.two).toBe(1);
    expect(counts.three).toBe(2);
  });

  test("a full redraw with no dirty row still paints every row", async () => {
    await make(20, 6);
    const drawn = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.grid.draw(box.term);
      box.grid.draw(box.term);
      // The shim reports a full redraw and no dirty row. The two answers
      // disagree, and the full redraw must win.
      const shim = Object.create(box.term);
      shim.needsFullRedraw = (): boolean => true;
      shim.isRowDirty = (): boolean => false;
      box.grid.draw(shim);
      return Array.from(box.grid.lastDrawnRows as number[]);
    });
    expect(drawn).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a resize to a larger grid paints every row again", async () => {
    await make(20, 6);
    const drawn = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.grid.draw(box.term);
      box.grid.draw(box.term);
      box.grid.resize(30, 12);
      box.grid.draw(box.term);
      return Array.from(box.grid.lastDrawnRows as number[]);
    });
    // The terminal holds six rows, so the draw paints the six rows that exist.
    expect(drawn).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("draw calls the render property of the instance", async () => {
    await make(20, 6);
    const calls = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      let count = 0;
      box.grid.render = (): void => {
        count += 1;
      };
      // Each draw follows a write, so each one paints and calls `render`.
      box.term.write("a");
      box.grid.draw(box.term);
      box.term.write("b");
      box.grid.draw(box.term);
      return count;
    });
    expect(calls).toBe(2);
  });
});

// ============================================================================
// The redraw request
// ============================================================================
//
// `requestRedraw` serves the selection highlight of `@beamterm/renderer`. A
// change of the selection makes no row dirty, so the early return of `draw`
// holds the last paint on the canvas. A present alone does not carry the
// highlight: the package applies it to the cells that a batch writes, so the
// rows must go to the GPU again. `tests/select.spec.ts` holds that
// measurement. The request is one-shot, because `draw` clears the full-redraw
// state after it paints. A request that stayed set would paint every row on
// every frame, and the dirty-region optimization would then do nothing.

describe("the redraw request", () => {
  test("a request paints every row one time, then the state is quiet again", async () => {
    await make(20, 6);
    const result = await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("hello");
      grid.draw();
      grid.draw();
      const before = grid.state().renderCalls;

      grid.call("requestRedraw");
      grid.draw();
      const served = grid.state();

      grid.draw();
      const after = grid.state();
      return {
        before,
        servedCalls: served.renderCalls,
        servedRows: served.lastDrawnRows,
        afterCalls: after.renderCalls,
        afterRows: after.lastDrawnRows,
      };
    });
    // The request paints every row and presents the canvas one time.
    expect(result.servedRows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.servedCalls).toBe(result.before + 1);
    // The request is one-shot. The next draw paints no row and presents
    // nothing.
    expect(result.afterRows).toEqual([]);
    expect(result.afterCalls).toBe(result.servedCalls);
  });

  test("a request with one dirty row still paints every row", async () => {
    await make(20, 6);
    const rows = await page.evaluate(() => {
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      grid.write("\r\n\r\n\r\n");
      grid.draw();
      grid.draw();

      // The write makes row 3 dirty. The request must widen that paint to
      // every row, because the highlight can cover any row.
      grid.write("hello");
      grid.call("requestRedraw");
      grid.draw();
      return grid.state().lastDrawnRows;
    });
    expect(rows).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a request on a disposed renderer paints nothing and throws no error", async () => {
    await make(20, 6);
    const result = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.grid.draw(box.term);
      box.grid.dispose();
      const before = box.renderCalls as number;
      let error: string | null = null;
      try {
        box.grid.requestRedraw();
        box.grid.draw(box.term);
      } catch (e) {
        error = String(e);
      }
      return {
        error,
        before,
        after: box.renderCalls as number,
        drawn: Array.from(box.grid.lastDrawnRows as number[]),
      };
    });
    expect(result.error).toBeNull();
    expect(result.after).toBe(result.before);
    expect(result.drawn).toEqual([]);
  });
});

// ============================================================================
// The fit
// ============================================================================

describe("the fit", () => {
  test("fit gives the columns and rows of the container box", async () => {
    await make(20, 6);
    const s = await state();
    expect(s.fitCols).toBe(Math.floor(600 / s.cellWidth));
    expect(s.fitRows).toBe(Math.floor(400 / s.cellHeight));
  });

  test("fit never gives less than one column or one row", async () => {
    await make(20, 6);
    const fit = await page.evaluate(() => {
      const host = document.querySelector("#grid-host") as HTMLElement;
      host.style.width = "0px";
      host.style.height = "0px";
      const grid = (globalThis as unknown as { __grid: GridApi }).__grid;
      return grid.call("fit") as { cols: number; rows: number };
    });
    expect(fit).toEqual({ cols: 1, rows: 1 });
  });

  test("setFontSize changes the cell size and the fit of the same container", async () => {
    await make(20, 6, { fontSize: 12 });
    const before = await state();
    await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.call("setFontSize", [24]);
    });
    const after = await state();
    expect(after.cellWidth).toBeGreaterThan(before.cellWidth);
    expect(after.cellHeight).toBeGreaterThan(before.cellHeight);
    expect(after.fitCols).toBeLessThan(before.fitCols);
    expect(after.fitRows).toBeLessThan(before.fitRows);
  });
});

// ============================================================================
// The theme
// ============================================================================

describe("the theme", () => {
  test("setTheme changes the painted colors with no new canvas", async () => {
    await make(20, 6);
    const before = await drawAndSample(`${ESC}[31m█`, [
      { col: 0, row: 0 },
      { col: 5, row: 3 },
    ]);
    expect(before.map(show)).toEqual([THEME.red, THEME.background]);

    const canvasBefore = await page.evaluate(
      () =>
        (globalThis as unknown as { __grid: { canvas: HTMLCanvasElement } }).__grid
          .canvas.id,
    );
    await page.evaluate((theme: unknown) => {
      (globalThis as unknown as { __grid: GridApi }).__grid.call("setTheme", [theme]);
    }, OTHER_THEME);

    const after = await drawAndSample("", [
      { col: 0, row: 0 },
      { col: 5, row: 3 },
    ]);
    expect(after.map(show)).toEqual([OTHER_THEME.red, OTHER_THEME.background]);

    const s = await state();
    expect(s.containerChildren).toEqual(["CANVAS"]);
    const canvasAfter = await page.evaluate(
      () =>
        (globalThis as unknown as { __grid: { canvas: HTMLCanvasElement } }).__grid
          .canvas.id,
    );
    expect(canvasAfter).toBe(canvasBefore);
  });
});

// ============================================================================
// The lifetime
// ============================================================================

describe("the lifetime", () => {
  test("dispose removes the canvas from the container", async () => {
    await make(20, 6);
    const children = await page.evaluate(() => {
      (globalThis as unknown as { __grid: GridApi }).__grid.call("dispose");
      const host = document.querySelector("#grid-host") as HTMLElement;
      return host.children.length;
    });
    expect(children).toBe(0);
  });

  test("a draw after a dispose throws no error and paints nothing", async () => {
    await make(20, 6);
    const result = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.grid.dispose();
      let error: string | null = null;
      try {
        box.grid.draw(box.term);
      } catch (e) {
        error = String(e);
      }
      return { error, drawn: Array.from(box.grid.lastDrawnRows as number[]) };
    });
    expect(result.error).toBeNull();
    expect(result.drawn).toEqual([]);
  });

  test("the VT terminal still works after a dispose", async () => {
    await make(20, 6);
    // ghostty-vt.wasm 0.4.0 corrupts its heap when a grid that held a grapheme
    // cluster is freed. This test writes a cluster and a wide character, then
    // it disposes the renderer and reads the terminal again. A free of the
    // terminal inside the renderer traps here.
    const result = await page.evaluate((esc: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.write(`${esc}[38;2;255;255;255mAé漢`);
      box.grid.draw(box.term);
      box.grid.dispose();
      try {
        box.term.write("ok");
        const cells = box.term.getViewport();
        return { error: null as string | null, cols: box.term.cols, first: cells[0].codepoint };
      } catch (e) {
        return { error: String(e), cols: 0, first: 0 };
      }
    }, ESC);
    expect(result.error).toBeNull();
    expect(result.cols).toBe(20);
    expect(result.first).toBe(0x41);
  });

  test("a second dispose does nothing", async () => {
    await make(20, 6);
    const error = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const box = (globalThis as unknown as { __grid: any }).__grid;
      box.grid.dispose();
      try {
        box.grid.dispose();
      } catch (e) {
        return String(e);
      }
      return null;
    });
    expect(error).toBeNull();
  });
});

// ============================================================================
// The source
// ============================================================================

describe("the source", () => {
  /** Every TypeScript file under `src/render`. */
  async function sources(): Promise<{ path: string; text: string }[]> {
    const dir = `${import.meta.dir}/../src/render`;
    const glob = new Bun.Glob("**/*.ts");
    const out: { path: string; text: string }[] = [];
    for await (const name of glob.scan({ cwd: dir })) {
      out.push({ path: name, text: await Bun.file(`${dir}/${name}`).text() });
    }
    return out;
  }

  test("no file under src/render imports the ghostty-web module", async () => {
    for (const file of await sources()) {
      const imports = file.text.match(/from\s+"[^"]+"/g) ?? [];
      for (const line of imports) {
        expect(`${file.path}: ${line}`).not.toContain('"ghostty-web');
      }
    }
  });

  test("no file under src/render uses an addon or an xterm.js buffer API", async () => {
    const banned = ["loadAddon", "proposeDimensions", "buffer.active", "FitAddon"];
    for (const file of await sources()) {
      for (const name of banned) {
        expect(`${file.path}: ${file.text}`).not.toContain(name);
      }
    }
  });

  /** Every TypeScript file of the client and of its tests. */
  async function allSources(): Promise<{ path: string; text: string }[]> {
    const web = `${import.meta.dir}/..`;
    const glob = new Bun.Glob("**/*.ts");
    const out: { path: string; text: string }[] = [];
    for (const dir of ["src", "tests", "e2e", "bench"]) {
      for await (const name of glob.scan({ cwd: `${web}/${dir}` })) {
        out.push({ path: `${dir}/${name}`, text: await Bun.file(`${web}/${dir}/${name}`).text() });
      }
    }
    return out;
  }

  test("no file of the client imports the ghostty-web JavaScript module", async () => {
    // Criterion 2. The client drives `src/vt` and `src/render`, so the
    // JavaScript layer of `ghostty-web` has no reader left. The package stays
    // in `package.json` for one asset: the wasm binary of the VT engine.
    //
    // The wasm subpath below is the ONE permitted specifier. Any other
    // specifier that starts with `ghostty-web` is a defect.
    const allowed = "ghostty-web/ghostty-vt.wasm?url";
    const specifier = /(?:from|import)\s*\(?\s*"([^"]+)"/g;
    const found: string[] = [];
    for (const file of await allSources()) {
      for (const match of file.text.matchAll(specifier)) {
        const name = match[1];
        if (name.startsWith("ghostty-web") && name !== allowed) {
          found.push(`${file.path}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("the wasm subpath of ghostty-web has exactly one reader", async () => {
    const allowed = "ghostty-web/ghostty-vt.wasm?url";
    const readers = (await allSources())
      .filter((file) => file.text.includes(`"${allowed}"`))
      .map((file) => file.path)
      .sort();
    // `src/vt/wasm.ts` imports the asset. `tests/render.spec.ts` names the same
    // specifier to keep it external in its own bundle.
    expect(readers).toEqual(["src/vt/wasm.ts", "tests/render.spec.ts"]);
  });

  test("src/terminal.ts holds no addon API and no xterm.js buffer API", async () => {
    // Criterion 12. The product surface carries none of these. The adapter of
    // that shape lives in the test bridge of `src/main.ts`.
    //
    // The scan runs on the code alone. A comment names these words to explain
    // why they are absent, and a scan of the raw text would match those.
    const text = await Bun.file(`${import.meta.dir}/../src/terminal.ts`).text();
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const banned = ["loadAddon", "proposeDimensions", "FitAddon", "buffer"];
    expect(banned.filter((name) => code.includes(name))).toEqual([]);
  });
});
