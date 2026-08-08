/**
 * The grid renderer of pirate.
 *
 * This module draws the viewport of a `VtTerminal` with `@beamterm/renderer`,
 * a WebGL2 grid renderer. It owns one canvas inside a container element. It
 * reads the terminal, and it writes nothing back to it. It creates no terminal
 * and it frees no terminal.
 *
 * The module imports nothing from the JavaScript layer of `ghostty-web`. It
 * holds no compatibility buffer and no addon interface. `fit` replaces the fit
 * addon of that package.
 *
 * Use it in three steps:
 *
 *     const grid = await GridRenderer.create(container, { fontSize: 14, theme });
 *     grid.resize(grid.fit().cols, grid.fit().rows);
 *     grid.draw(term);
 *
 * The caller owns the frame loop. `draw` is cheap when nothing changed: it
 * writes no cell and it calls `render` one time.
 */

import init, {
  BeamtermRenderer,
  main as startWasm,
  style,
  type Batch,
  type CellStyle,
} from "@beamterm/renderer/web";

import type { Theme } from "../theme";
import { VtCellFlags, type VtCell, type VtCursor, type VtTerminal } from "../vt";
import { faint, packRgb, Palette, type Rgb24 } from "./palette";

/** The columns and rows that a container holds. */
export interface FitResult {
  cols: number;
  rows: number;
}

/**
 * The font stack of the terminal.
 *
 * The list matches `#terminal` of `src/style.css`. The dynamic atlas of
 * `@beamterm/renderer` rasterizes the first family that the browser has.
 */
const FONT_FAMILIES: string[] = [
  "ui-monospace",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "monospace",
];

/**
 * The style bits that both layers share.
 *
 * `VtCellFlags.BOLD`, `ITALIC`, `UNDERLINE`, and `STRIKETHROUGH` are 1, 2, 4,
 * and 8. `CellStyle` of `@beamterm/renderer` carries the same four attributes.
 * The mask takes those four bits and drops the rest.
 */
const SHARED_FLAGS =
  VtCellFlags.BOLD | VtCellFlags.ITALIC | VtCellFlags.UNDERLINE | VtCellFlags.STRIKETHROUGH;

/** The colors and the attributes of one run of cells. */
interface Paint {
  fg: Rgb24;
  bg: Rgb24;
  bits: number;
}

/** The counter that gives each canvas a unique id for the CSS selector. */
let canvasCount = 0;

/** The promise of the wasm module. One module serves every renderer. */
let wasmReady: Promise<void> | undefined;

/**
 * Load the wasm module of `@beamterm/renderer` one time.
 *
 * The default export instantiates the module. `main` runs the start function
 * of the module, and it needs the instance, so it comes second.
 */
function loadWasm(): Promise<void> {
  wasmReady ??= init().then(() => {
    startWasm();
  });
  return wasmReady;
}

/** The device pixel ratio, with 1 for an environment that reports none. */
function deviceRatio(): number {
  const ratio = globalThis.devicePixelRatio;
  return typeof ratio === "number" && ratio > 0 ? ratio : 1;
}

export class GridRenderer {
  /**
   * Create the WebGL2 renderer inside `container`.
   *
   * The container gets one canvas and nothing else. The grid starts at the
   * size that `fit` reports for the container.
   */
  static async create(
    container: HTMLElement,
    options: { fontSize: number; theme: Theme },
  ): Promise<GridRenderer> {
    await loadWasm();

    const canvas = document.createElement("canvas");
    canvasCount += 1;
    canvas.id = `pirate-grid-${canvasCount}`;
    container.append(canvas);

    // Take the WebGL2 context before `@beamterm/renderer` takes it, and ask for
    // `preserveDrawingBuffer`. `getContext` gives back the context that the
    // canvas already holds, and it ignores the second argument at that point,
    // so the later call inside the wasm module reuses this context with this
    // attribute. The wasm module passes only the context name to `getContext`,
    // so this attribute is not reachable through the API of the package.
    //
    // The drawing buffer then holds the paint after the frame composites, and a
    // reader outside the paint task can measure the canvas.
    //
    // Measurement, in Chromium with `--enable-unsafe-swiftshader`. Without this
    // call, a read in the same task as `render` gives 167,176,216,255 and a read
    // after two animation frames gives 0,0,0,0. With this call, both reads give
    // 167,176,216,255.
    //
    // The cost is inside the noise of the measurement. A grid of 80 by 24 gives
    // a mean `draw` of 0.037 ms without the attribute and 0.032 ms with it. A
    // grid of 174 by 68 gives 0.147 ms for both. Frame throughput under a
    // continuous animation frame loop gives 36.8 and 43.3 frames per second for
    // 80 by 24, and 7.3 for both at 174 by 68.
    canvas.getContext("webgl2", { preserveDrawingBuffer: true });

    // `auto_resize_canvas_css` is false, so this module owns the CSS size of
    // the canvas. With true, `resize` writes the pixel count of the backing
    // store into the CSS size, and the canvas then covers `devicePixelRatio`
    // times the intended box.
    const beam = BeamtermRenderer.withDynamicAtlas(
      `#${canvas.id}`,
      FONT_FAMILIES,
      options.fontSize,
      false,
    );

    const grid = new GridRenderer(container, canvas, beam, options);
    const first = grid.fit();
    grid.resize(first.cols, first.rows);
    return grid;
  }

  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly beam: BeamtermRenderer;
  private palette: Palette;
  private fontSize: number;
  private gridCols = 1;
  private gridRows = 1;
  private ratio = deviceRatio();
  /** True when the next `draw` must paint every row. */
  private fullRedraw = true;
  /** The cell that the cursor covered at the last `draw`, or null. */
  private lastCursor: { x: number; y: number } | null = null;
  private disposed = false;
  private drawnRows: readonly number[] = [];

  private constructor(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    beam: BeamtermRenderer,
    options: { fontSize: number; theme: Theme },
  ) {
    this.container = container;
    this.canvas = canvas;
    this.beam = beam;
    this.fontSize = options.fontSize;
    this.palette = new Palette(options.theme);
  }

  /**
   * The draw call.
   *
   * This is a method of the prototype. A caller that counts the paints assigns
   * its own function to `render` on one instance, which shadows this method,
   * and it removes that own property with `delete` to stop counting. A method
   * of the prototype comes back after that `delete`. An own property of the
   * instance would not come back, and every later `draw` would then stop.
   */
  render(): void {
    if (this.disposed) {
      return;
    }
    this.beam.render();
  }

  get cols(): number {
    return this.gridCols;
  }

  get rows(): number {
    return this.gridRows;
  }

  /**
   * The rows that the last `draw` painted, in ascending order.
   *
   * This is the measurement of the dirty-row path. An empty array means that
   * the last `draw` wrote no cell. `draw` builds this array for the cursor
   * restore, so the report adds no allocation.
   */
  get lastDrawnRows(): readonly number[] {
    return this.drawnRows;
  }

  /**
   * The cell size in CSS pixels.
   *
   * `cellSize` of `@beamterm/renderer` reports the backing store size, which
   * is `devicePixelRatio` times the CSS size. Measurement: at a device pixel
   * ratio of 1 the static atlas reports 10 by 18, and at a ratio of 2 it
   * reports 20 by 36 for the same grid of 40 columns.
   */
  cellSize(): { width: number; height: number } {
    const size = this.beam.cellSize();
    const width = size.width / this.ratio;
    const height = size.height / this.ratio;
    size.free();
    return { width, height };
  }

  /**
   * The columns and rows that the container holds at the current font size.
   *
   * The measurement takes the content box, not the padding box. `clientWidth`
   * and `clientHeight` count the padding, and `#terminal` of `src/style.css`
   * carries 8 px of it on every side. A grid built from `clientWidth` is
   * therefore too wide, and its canvas covers the padding. A change of the
   * padding alone would also move no column, so the grid would not follow its
   * container.
   */
  fit(): FitResult {
    const cell = this.cellSize();
    if (cell.width <= 0 || cell.height <= 0) {
      return { cols: 1, rows: 1 };
    }
    const box = this.contentBox();
    return {
      cols: Math.max(1, Math.floor(box.width / cell.width)),
      rows: Math.max(1, Math.floor(box.height / cell.height)),
    };
  }

  /**
   * Set the font size in CSS pixels.
   *
   * The atlas rasterizes again at the new size, and the cell size changes. The
   * grid keeps its column count and its row count, so the canvas changes size.
   * The caller reads `fit` after this call and resizes the grid.
   */
  setFontSize(px: number): void {
    if (this.disposed) {
      return;
    }
    this.fontSize = px;
    this.rasterize();
  }

  /**
   * Set the theme.
   *
   * This builds no renderer and no canvas. The colors of a cell go to the GPU
   * with the cell, so the next `draw` carries the new theme.
   */
  setTheme(theme: Theme): void {
    this.palette = new Palette(theme);
    this.fullRedraw = true;
  }

  /** Set the grid size in cells. This touches no VT terminal. */
  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.gridCols = Math.max(1, Math.floor(cols));
    this.gridRows = Math.max(1, Math.floor(rows));
    this.applyGrid();
  }

  /**
   * Draw the terminal.
   *
   * The method paints the dirty rows, then it clears the dirty state, then it
   * calls `render`. It paints every row when the terminal asks for a full
   * redraw, and after a change of the theme, the font size, the grid size, or
   * the device pixel ratio.
   *
   * `render` runs on every call, and it runs one time. A caller with an
   * unconditional animation frame loop therefore needs no branch of its own.
   */
  draw(term: VtTerminal): void {
    if (this.disposed) {
      this.drawnRows = [];
      return;
    }
    this.syncRatio();

    const cols = Math.min(this.gridCols, term.cols);
    const rows = Math.min(this.gridRows, term.rows);
    const full = this.fullRedraw || term.needsFullRedraw();
    const viewport = term.getViewport();
    const cursor = term.getCursor();
    const drawn: number[] = [];

    const batch = this.beam.batch();
    try {
      if (full) {
        batch.clear(this.palette.background);
      }
      for (let y = 0; y < rows; y += 1) {
        if (!full && !term.isRowDirty(y)) {
          continue;
        }
        this.paintRow(batch, term, viewport, y, cols);
        drawn.push(y);
      }
      this.paintCursor(batch, term, viewport, cursor, cols, rows, drawn);
    } finally {
      batch.free();
    }

    term.clearDirty();
    this.fullRedraw = false;
    this.drawnRows = drawn;
    this.render();
  }

  /** Free the renderer and remove the canvas from the container. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.beam.free();
    this.canvas.remove();
    this.drawnRows = [];
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /** The content box of the container, in CSS pixels. */
  private contentBox(): { width: number; height: number } {
    const style = getComputedStyle(this.container);
    const trim = (value: string): number => {
      const number = parseFloat(value);
      return Number.isFinite(number) ? number : 0;
    };
    return {
      width: Math.max(
        0,
        this.container.clientWidth - trim(style.paddingLeft) - trim(style.paddingRight),
      ),
      height: Math.max(
        0,
        this.container.clientHeight - trim(style.paddingTop) - trim(style.paddingBottom),
      ),
    };
  }

  /**
   * Give the canvas the pixel size of the grid.
   *
   * `resize` of `@beamterm/renderer` takes CSS pixels and multiplies them by
   * the device pixel ratio for the backing store. Measurement: with a ratio of
   * 2, `resize(400, 300)` gives a canvas of 800 by 600 pixels. The CSS size
   * stays with this module, because `auto_resize_canvas_css` is false.
   */
  private applyGrid(): void {
    const cell = this.cellSize();
    const width = this.gridCols * cell.width;
    const height = this.gridRows * cell.height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.beam.resize(width, height);
    this.fullRedraw = true;
  }

  /** Apply a change of the device pixel ratio that came between two draws. */
  private syncRatio(): void {
    const ratio = deviceRatio();
    if (ratio === this.ratio) {
      return;
    }
    this.ratio = ratio;
    this.rasterize();
  }

  /**
   * Build the font atlas again, then give the canvas its size.
   *
   * The atlas rasterizes at the device pixel ratio of the moment. It does not
   * rasterize again on its own, so a change of the ratio needs this call.
   * Measurement: at a ratio of 1 a font size of 16 gives a cell of 11 by 17
   * device pixels, and at a ratio of 2 the same font size gives 21 by 33.
   */
  private rasterize(): void {
    this.beam.replaceWithDynamicAtlas(FONT_FAMILIES, this.fontSize);
    this.applyGrid();
  }

  /** Paint one row, as runs of cells that share their colors and attributes. */
  private paintRow(
    batch: Batch,
    term: VtTerminal,
    viewport: readonly VtCell[],
    y: number,
    cols: number,
  ): void {
    const base = y * term.cols;
    let start = 0;
    let text = "";
    let run: Paint | null = null;

    for (let x = 0; x < cols; x += 1) {
      const paint = this.paintOf(viewport[base + x]);
      if (run === null || paint.fg !== run.fg || paint.bg !== run.bg || paint.bits !== run.bits) {
        this.writeRun(batch, start, y, text, run);
        start = x;
        text = "";
        run = paint;
      }
      text += symbolOf(term, viewport[base + x], x, y);
    }
    this.writeRun(batch, start, y, text, run);
  }

  /**
   * Paint the cursor cell, and restore the cell that the cursor left.
   *
   * The restore covers one cell only. A cursor that moves inside a row that no
   * write touched leaves the old cell painted, and that row is not dirty, so
   * nothing else repaints it.
   */
  private paintCursor(
    batch: Batch,
    term: VtTerminal,
    viewport: readonly VtCell[],
    cursor: VtCursor,
    cols: number,
    rows: number,
    drawn: number[],
  ): void {
    const last = this.lastCursor;
    if (last !== null && !drawn.includes(last.y) && last.x < cols && last.y < rows) {
      const cell = viewport[last.y * term.cols + last.x];
      this.writeRun(batch, last.x, last.y, symbolOf(term, cell, last.x, last.y), this.paintOf(cell));
    }

    if (!cursor.visible || cursor.x >= cols || cursor.y >= rows || cursor.x < 0 || cursor.y < 0) {
      this.lastCursor = null;
      return;
    }
    const cell = viewport[cursor.y * term.cols + cursor.x];
    this.writeRun(batch, cursor.x, cursor.y, symbolOf(term, cell, cursor.x, cursor.y), {
      fg: this.palette.cursorAccent,
      bg: this.palette.cursor,
      bits: cell.flags & SHARED_FLAGS,
    });
    this.lastCursor = { x: cursor.x, y: cursor.y };
  }

  /** The colors and the attributes to paint for one cell. */
  private paintOf(cell: VtCell): Paint {
    let fg = this.palette.resolve(packRgb(cell.fgR, cell.fgG, cell.fgB));
    let bg = this.palette.resolve(packRgb(cell.bgR, cell.bgG, cell.bgB));

    if ((cell.flags & VtCellFlags.INVERSE) !== 0) {
      const swap = fg;
      fg = bg;
      bg = swap;
    }
    // FAINT has no bit in `CellStyle` of `@beamterm/renderer`, so the color
    // carries it: the foreground moves half the way to the background of the
    // same cell.
    if ((cell.flags & VtCellFlags.FAINT) !== 0) {
      fg = faint(fg, bg);
    }
    if ((cell.flags & VtCellFlags.INVISIBLE) !== 0) {
      fg = bg;
    }
    return { fg, bg, bits: cell.flags & SHARED_FLAGS };
  }

  /** Write one run of text. An empty run writes nothing. */
  private writeRun(batch: Batch, x: number, y: number, text: string, run: Paint | null): void {
    if (run === null || text.length === 0) {
      return;
    }
    const built = buildStyle(run);
    batch.text(x, y, text, built);
    built.free();
  }
}

/**
 * The character of one cell.
 *
 * A cell of codepoint 0 gives one space. The second half of a wide character
 * gives an empty string.
 *
 * `batch.text` of `@beamterm/renderer` 1.0.0 walks the run by grapheme
 * cluster, and it advances by the display width of each cluster, not by one
 * column for each cluster. A wide cluster therefore advances two columns, and
 * the renderer paints that cluster across both of them. Measurement, in
 * Chromium with `--enable-unsafe-swiftshader`: the run `U+6F22` painted
 * columns 0 and 1, and a run of `U+6F22` and two full blocks painted the
 * blocks in columns 3 and 4. An extra character for the second half of a wide
 * character therefore moves the rest of the run one column to the right.
 */
function symbolOf(term: VtTerminal, cell: VtCell, x: number, y: number): string {
  if (cell.width === 0) {
    return "";
  }
  if (cell.graphemeLength > 0) {
    return term.getGraphemeString(x, y);
  }
  return cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
}

/**
 * Build the `CellStyle` of one run. The caller frees it.
 *
 * This function is the one place where a cell flag becomes a style bit of
 * `@beamterm/renderer`. The VT layer also carries `VtCellFlags.BLINK`, and
 * libghostty sets it correctly. `@beamterm/renderer` has no native blink: its
 * `FontStyle` holds Normal, Bold, Italic, and BoldItalic, and its
 * `GlyphEffect` holds None, Underline, and Strikethrough. A shim for blink is
 * out of scope by a decision of the product manager, so a blinking cell paints
 * as a steady cell.
 */
function buildStyle(run: Paint): CellStyle {
  let built = style().fg(run.fg).bg(run.bg);
  if ((run.bits & VtCellFlags.BOLD) !== 0) {
    built = built.bold();
  }
  if ((run.bits & VtCellFlags.ITALIC) !== 0) {
    built = built.italic();
  }
  if ((run.bits & VtCellFlags.UNDERLINE) !== 0) {
    built = built.underline();
  }
  if ((run.bits & VtCellFlags.STRIKETHROUGH) !== 0) {
    built = built.strikethrough();
  }
  return built;
}

export { Palette, packRgb, parseHex, type Rgb24 } from "./palette";
