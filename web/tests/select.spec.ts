/**
 * Mouse selection, text extraction, and the copy to the system clipboard.
 *
 * `@beamterm/renderer` attaches its mouse listeners to the canvas element from
 * Rust. A synthetic `MouseEvent` on the wrong element passes every assertion
 * here and moves nothing, so every drag in this file goes through
 * `page.mouse`, which drives the input pipeline of the browser. Every
 * coordinate comes from the bounding box of the canvas and from the cell size
 * that the renderer reports. No coordinate is a constant.
 *
 * The file states each precondition as an assertion. `canvasBox` proves that
 * the page holds exactly one canvas, that this canvas is inside `#terminal`,
 * and that its box is not empty. `dragCells` proves that the cell size is more
 * than zero, and that the grid holds every column and every row that the drag
 * asks for. The first test proves that the `beam` field of the renderer is
 * reachable at run time, which is the base of `beamOf` in `src/terminal.ts`.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  canvasSignature,
  clientState,
  countRenders,
  cursor,
  idle,
  paintedPixels,
  server,
  viewportLine,
  viewportText,
  waitFor,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/** The selection API that `src/main.ts` exposes on `__pirate`. */
interface SelectionApi {
  hasSelection(): boolean;
  text(): string;
  clear(): void;
  readonly installs: number;
}

type SelectWindow = {
  __pirate: {
    selection: SelectionApi;
    term: {
      renderer: {
        cellSize(): { width: number; height: number };
        cols: number;
        rows: number;
        render(...args: unknown[]): void;
        draw(...args: unknown[]): void;
        readonly lastDrawnRows: readonly number[];
      };
    };
  };
};

/** True from the mouse-down of a drag until the selection ends. */
function hasSelection(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (globalThis as unknown as SelectWindow).__pirate.selection.hasSelection(),
  );
}

/** The text of the selection, or the empty string. */
function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as unknown as SelectWindow).__pirate.selection.text());
}

/** Drop the selection. */
function clearSelection(page: Page): Promise<void> {
  return page.evaluate(() => {
    (globalThis as unknown as SelectWindow).__pirate.selection.clear();
  });
}

/** The count of `installSelection` calls of this page. */
function installs(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as SelectWindow).__pirate.selection.installs);
}

/** The cell size in CSS pixels, as the renderer reports it. */
function cellSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() =>
    (globalThis as unknown as SelectWindow).__pirate.term.renderer.cellSize(),
  );
}

/** The grid size in cells, as the renderer reports it. */
function gridSize(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => {
    const renderer = (globalThis as unknown as SelectWindow).__pirate.term.renderer;
    return { cols: renderer.cols, rows: renderer.rows };
  });
}

/**
 * The box of the canvas that beamterm listens on.
 *
 * The assertions here are the preconditions of every drag in this file. The
 * page holds exactly one canvas, that canvas is a child of `#terminal`, and
 * its box has a width and a height.
 */
async function canvasBox(page: Page): Promise<{ x: number; y: number }> {
  const count = await page.evaluate(() => document.querySelectorAll("canvas").length);
  expect(count).toBe(1);

  const inside = await page.evaluate(
    () => document.querySelector("#terminal canvas") === document.querySelector("canvas"),
  );
  expect(inside).toBe(true);

  const box = await page.locator("#terminal canvas").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  return { x: box!.x, y: box!.y };
}

/**
 * Drag the left button from one cell to another, with real mouse input.
 *
 * The pointer lands in the middle of each cell, so a rounding difference of
 * one pixel cannot move the drag into a neighbor cell.
 */
async function dragCells(
  page: Page,
  from: { col: number; row: number },
  to: { col: number; row: number },
): Promise<void> {
  const origin = await canvasBox(page);
  const cell = await cellSize(page);
  expect(cell.width).toBeGreaterThan(0);
  expect(cell.height).toBeGreaterThan(0);

  // Both beamterm and `src/select.ts` drop a mouse event outside the grid
  // (`beamterm-renderer/src/mouse.rs:317`). A drag to a column or a row that
  // the grid does not hold therefore records a different range than the one
  // that the test asks for. This assertion names that precondition.
  const grid = await gridSize(page);
  for (const target of [from, to]) {
    expect(target.col).toBeLessThan(grid.cols);
    expect(target.row).toBeLessThan(grid.rows);
  }

  const at = (col: number, row: number): [number, number] => [
    origin.x + (col + 0.5) * cell.width,
    origin.y + (row + 0.5) * cell.height,
  ];

  const [x0, y0] = at(from.col, from.row);
  const [x1, y1] = at(to.col, to.row);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

/**
 * Write `text` to the terminal and wait until row 0 holds `first`.
 *
 * The wait on the paint is necessary. The renderer copies the cells into the
 * grid of beamterm during a frame, and `getText` reads that grid. A drag
 * before the first frame therefore reads blanks.
 */
async function writeAndPaint(page: Page, text: string, first: string): Promise<void> {
  server().send([{ tag: 0x00, text }]);
  await waitFor(() => viewportLine(page, 0), (line) => line === first, "row 0");
  await waitFor(() => paintedPixels(page, 0), (n) => n > 50, "paint on row 0");
}

/** Grant the clipboard permissions of the page origin. */
async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
}

/** The text of the system clipboard. */
function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The value that `resetClipboard` writes. No drag in this file gives it. */
const NO_COPY = "<no copy>";

/**
 * Put a sentinel on the clipboard, and prove that the sentinel is there.
 *
 * `withClient` opens a new browser context for each test, but the clipboard
 * belongs to the browser and it outlives the context. A test that waits for
 * an expected value therefore reads a value that an earlier test wrote, and it
 * passes while the copy under test does nothing. This function removes that
 * path.
 */
async function resetClipboard(page: Page): Promise<void> {
  await page.evaluate((value: string) => navigator.clipboard.writeText(value), NO_COPY);
  expect(await clipboardText(page)).toBe(NO_COPY);
}

test("the renderer holds a reachable beam field, and it reports no selection at open", async () => {
  // This is the measurement that `beamOf` of `src/terminal.ts` rests on.
  // TypeScript removes `private` at compile time, so the field is a plain own
  // property of the renderer at run time.
  await withClient(async (page) => {
    const keys = await page.evaluate(() =>
      Object.keys((globalThis as unknown as { __pirate: { term: { renderer: object } } }).__pirate.term.renderer),
    );
    expect(keys).toContain("beam");

    const answer = await page.evaluate(() => {
      const renderer = (globalThis as unknown as { __pirate: { term: { renderer: object } } })
        .__pirate.term.renderer as {
        beam: { hasSelection(): boolean; enableSelection?: unknown };
      };
      return typeof renderer.beam.enableSelection !== "function"
        ? "no enableSelection method"
        : String(renderer.beam.hasSelection());
    });
    expect(answer).toBe("false");
  });
});

test("a left drag across a row selects it, and no selection exists before the drag", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");

    // Criterion 1, the negative half. A fresh page carries no selection.
    expect(await hasSelection(page)).toBe(false);

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });

    // Criterion 1, the positive half.
    expect(await hasSelection(page)).toBe(true);

    // The focus guard of `src/input.ts:203` holds a window-level `mousedown`
    // listener that calls `focus` of the facade on every click outside
    // `#menu`. The guard calls no `preventDefault`, so the browser keeps its
    // own default action for the mouse-down as well.
    //
    // Measured order, after a real drag over the canvas: the guard moves the
    // focus to the hidden text field, and then the default action of the
    // browser moves it to `#terminal`. `#terminal` carries `tabindex="0"`
    // (`src/terminal.ts:338`) and it holds the keydown listener, so the
    // keyboard still works. The assertion above proves that neither step
    // disturbs the selection.
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(focused).toBe("terminal");
  });
});

test("the selected text matches the row that the drag covered", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    const row = await viewportLine(page, 0);
    expect(row).toBe("hello world");

    await dragCells(page, { col: 0, row: 0 }, { col: row.length - 1, row: 0 });

    expect(await selectedText(page)).toBe(row);
  });
});

test("a drag over part of a row gives that part of the row", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");

    // The drag ends on the last character of "hello", which is column 4.
    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 0 });

    expect(await selectedText(page)).toBe("hello");
  });
});

test("a drag over two rows joins them with one newline", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "alpha\r\nbravo", "alpha");
    expect(await viewportLine(page, 1)).toBe("bravo");

    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 1 });

    expect(await selectedText(page)).toBe("alpha\nbravo");
  });
});

test("a click inside one cell selects that one cell from the idle state", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");

    await dragCells(page, { col: 3, row: 0 }, { col: 3, row: 0 });

    // Measured, and it differs from the beamterm documentation. The cancel of
    // a single-cell click runs from the `MaybeSelecting` state alone, which a
    // mouse-down over a completed selection reaches
    // (`beamterm-renderer/src/mouse.rs:426`). From the `Idle` state a
    // mouse-down gives `Selecting`, and the mouse-up then completes a
    // selection of one cell (`mouse.rs:544`). Column 3 of "hello world" is
    // the second "l".
    expect(await hasSelection(page)).toBe(true);
    expect(await selectedText(page)).toBe("l");
  });
});

test("a click inside one cell cancels the selection that a drag left", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });
    expect(await hasSelection(page)).toBe(true);

    await dragCells(page, { col: 3, row: 0 }, { col: 3, row: 0 });

    // The mouse-down over a completed selection gives `MaybeSelecting`, and a
    // mouse-up on the same cell clears both the state and the tracker
    // (`beamterm-renderer/src/mouse.rs:463`).
    expect(await hasSelection(page)).toBe(false);
    expect(await selectedText(page)).toBe("");
  });
});

test("clearSelection returns the terminal to the state with no selection", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });
    expect(await hasSelection(page)).toBe(true);

    await clearSelection(page);

    expect(await hasSelection(page)).toBe(false);
    expect(await selectedText(page)).toBe("");
  });
});

test("the drag puts the selected text on the system clipboard", async () => {
  await withClient(async (page) => {
    await grantClipboard(page);
    await resetClipboard(page);
    await writeAndPaint(page, "hello world", "hello world");

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });

    // beamterm writes the clipboard through `navigator.clipboard.writeText`
    // and awaits no promise (`beamterm-renderer/src/js.rs:68`), so the write
    // lands in a later task than the mouse-up. The wait ends on any value
    // other than the sentinel, so only a write of this drag can end it.
    const text = await waitFor(
      () => clipboardText(page),
      (value) => value !== NO_COPY,
      "the clipboard",
    );
    expect(text).toBe("hello world");
  });
});

test("selection is installed once, and it survives a theme change", async () => {
  const stub = server();
  // A theme change resets the terminal and asks for a state dump. The stub
  // answers with the same row, so the drag after the change covers the same
  // text as the drag before it.
  stub.setOnDump([{ tag: 0x01, text: "hello world" }]);

  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    expect(await installs(page)).toBe(1);

    // A theme change builds a new `PirateTerminal` facade around the same
    // renderer and the same canvas.
    await page.click("#theme-light");
    await waitFor(
      () => clientState(page).then((s) => s.mode),
      (mode) => mode === "light",
      "light mode",
    );
    // The rebuild resets the terminal and the stub answers the dump request,
    // so row 0 carries the text again.
    await waitFor(() => viewportLine(page, 0), (line) => line === "hello world", "row 0 again");
    await waitFor(
      () => paintedPixels(page, 0, [0xff, 0xff, 0xff]),
      (n) => n > 50,
      "paint on row 0 after the theme change",
    );

    expect(await installs(page)).toBe(1);
    expect(await hasSelection(page)).toBe(false);

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });

    expect(await hasSelection(page)).toBe(true);
    expect(await selectedText(page)).toBe("hello world");
  });
});

test("a backward drag across a row gives the same text as a forward drag", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");

    // `src/select.ts` records the mouse-down cell as the start, and beamterm
    // records the same cell as the start of its own query. `CellQuery` orders
    // the two corners before it reads the cells
    // (`beamterm-core/src/gl/cell_query.rs:111`), so the direction of the drag
    // does not change the text.
    await dragCells(page, { col: 10, row: 0 }, { col: 0, row: 0 });

    expect(await hasSelection(page)).toBe(true);
    expect(await selectedText(page)).toBe("hello world");
  });
});

test("a backward drag over two rows joins them in reading order", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "alpha\r\nbravo", "alpha");
    expect(await viewportLine(page, 1)).toBe("bravo");

    await dragCells(page, { col: 4, row: 1 }, { col: 0, row: 0 });

    expect(await selectedText(page)).toBe("alpha\nbravo");
  });
});

test("the clipboard and the extracted text agree on a row with a blank tail", async () => {
  await withClient(async (page) => {
    await grantClipboard(page);
    await resetClipboard(page);
    await writeAndPaint(page, "alpha\r\nbravo", "alpha");

    // `src/select.ts` builds one `CellQuery` and beamterm builds another one
    // for the copy. Both must trim the trailing blanks, or the extracted text
    // and the clipboard differ. Row 0 holds "alpha" and then blanks to the
    // right edge, and this drag covers that blank tail.
    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 1 });

    const copied = await waitFor(
      () => clipboardText(page),
      (value) => value !== NO_COPY,
      "the clipboard",
    );
    expect(await selectedText(page)).toBe(copied);
    expect(copied).toBe("alpha\nbravo");
  });
});

test("a second drag replaces the first one with no clear between them", async () => {
  await withClient(async (page) => {
    await grantClipboard(page);
    await writeAndPaint(page, "hello world", "hello world");

    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 0 });
    expect(await selectedText(page)).toBe("hello");

    await resetClipboard(page);
    await dragCells(page, { col: 6, row: 0 }, { col: 10, row: 0 });

    expect(await selectedText(page)).toBe("world");
    const copied = await waitFor(
      () => clipboardText(page),
      (value) => value !== NO_COPY,
      "the clipboard",
    );
    expect(copied).toBe("world");
  });
});

test("a mouse-down alone reports a selection and extracts no text", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    const origin = await canvasBox(page);
    const cell = await cellSize(page);
    await page.mouse.move(origin.x + 0.5 * cell.width, origin.y + 0.5 * cell.height);
    await page.mouse.down();

    // Measured. `hasSelection` of beamterm reads the selection tracker, and
    // the mouse-down arm fills that tracker before the drag moves
    // (`beamterm-renderer/src/mouse.rs:440`). `text` needs an end cell, and
    // only a mouse-move or a mouse-up records one.
    expect(await hasSelection(page)).toBe(true);
    expect(await selectedText(page)).toBe("");

    await page.mouse.up();
  });
});

// ============================================================================
// The repaint of a selection change
// ============================================================================
//
// The client holds no select-all command. The proof:
//
//     $ grep -rn "selectAll\|select-all\|selectall" web/src web/e2e
//     (no match)
//
// The paths that change the selection are therefore the drag, the click that
// cancels a selection, and `clear`.
//
// Every test in this section states the absence as well as the presence. A
// frame that another event produced repaints the highlight as a side effect,
// and such a frame hides a missing repaint. Each test therefore measures a
// quiet terminal first, and it compares the cursor, the text of the viewport,
// the client state, and the count of the frames that the client sent to the
// host. The probe below reports the rows that each frame painted: a frame of
// the selection paints every row, and a frame of a write paints the dirty rows
// alone.

/** What the probe counted between `startProbe` and `stopProbe`. */
interface FrameProbe {
  /** The count of `render` calls of the renderer. */
  renders: number;
  /** The rows that each `draw` painted. One entry for each frame. */
  drawnRows: number[][];
}

type ProbeWindow = SelectWindow & { __probe?: FrameProbe };

/**
 * Count the frames of the renderer, and record the rows that each one painted.
 *
 * Both wrappers are own properties of the renderer, and `delete` removes them.
 * `render` and `draw` of `GridRenderer` are methods of the prototype, so both
 * come back after that `delete`.
 */
async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const renderer = (globalThis as unknown as ProbeWindow).__pirate.term.renderer;
    const probe: FrameProbe = { renders: 0, drawnRows: [] };
    (globalThis as unknown as ProbeWindow).__probe = probe;
    const render = renderer.render.bind(renderer);
    renderer.render = (...args: unknown[]): void => {
      probe.renders += 1;
      render(...args);
    };
    const draw = renderer.draw.bind(renderer);
    renderer.draw = (...args: unknown[]): void => {
      draw(...args);
      probe.drawnRows.push(Array.from(renderer.lastDrawnRows));
    };
  });
}

/** Stop the probe and read what it counted. */
function stopProbe(page: Page): Promise<FrameProbe> {
  return page.evaluate(() => {
    const globals = globalThis as unknown as ProbeWindow;
    const renderer = globals.__pirate.term.renderer;
    delete (renderer as unknown as Record<string, unknown>).render;
    delete (renderer as unknown as Record<string, unknown>).draw;
    const probe = globals.__probe ?? { renders: -1, drawnRows: [] };
    globals.__probe = undefined;
    return probe;
  });
}

/**
 * Prove that the terminal presents no frame over `ms` milliseconds.
 *
 * The paint of an earlier write can arrive inside the first window.
 * Measurement: the first window after `writeAndPaint` counted one present.
 * The wait therefore ends on a window with no present, and the assertion then
 * measures a second window of the same length.
 */
async function expectQuiet(page: Page, ms = 400): Promise<void> {
  await waitFor(
    () => countRenders(page, ms),
    (renders) => renders === 0,
    "a terminal that presents no frame",
  );
  expect(await countRenders(page, ms)).toBe(0);
}

/**
 * Prove that every frame of the probe painted every row, or no row at all.
 *
 * A frame of a selection change paints every row, because `requestRedraw` asks
 * for a full redraw. A frame that a write produced paints the dirty rows
 * alone. A partial list therefore names another cause for the repaint, and
 * this function rejects it.
 */
function expectSelectionFrames(probe: FrameProbe, rows: number): void {
  const full = Array.from({ length: rows }, (_unused, index) => index);
  const painted = probe.drawnRows.filter((row) => row.length > 0);
  expect(probe.drawnRows.length).toBeGreaterThan(0);
  expect(painted.length).toBeGreaterThan(0);
  for (const row of painted) {
    expect(row).toEqual(full);
  }
}

/**
 * The time for the frame that serves the last mouse event of a drag.
 *
 * The request of `src/select.ts` is one-shot, and the next animation frame
 * serves it. A measurement of a quiet terminal that starts before that frame
 * counts the frame of the drag. One animation frame takes about 16 ms at 60
 * frames per second, and this value holds nine of them.
 */
const SETTLE_MS = 150;

/**
 * The point in the middle of one cell, in page coordinates.
 *
 * The assertions state the preconditions of the drag, as `dragCells` states
 * them: the cell size is more than zero, and the grid holds the cell.
 */
async function pointOf(page: Page, col: number, row: number): Promise<[number, number]> {
  const origin = await canvasBox(page);
  const cell = await cellSize(page);
  expect(cell.width).toBeGreaterThan(0);
  expect(cell.height).toBeGreaterThan(0);
  const grid = await gridSize(page);
  expect(col).toBeLessThan(grid.cols);
  expect(row).toBeLessThan(grid.rows);
  return [origin.x + (col + 0.5) * cell.width, origin.y + (row + 0.5) * cell.height];
}

test("a drag repaints the canvas while no row is dirty", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    // The precondition of this test. A terminal that still paints gives the
    // highlight a frame that the drag did not ask for.
    await expectQuiet(page);

    const grid = await gridSize(page);
    const before = await canvasSignature(page);
    const cursorBefore = await cursor(page);
    const textBefore = await viewportText(page);
    const stateBefore = await clientState(page);
    const sentBefore = server().received.length;

    await startProbe(page);
    const [x0, y0] = await pointOf(page, 0, 0);
    const [x1, y1] = await pointOf(page, 4, 0);
    const [x2, y2] = await pointOf(page, 10, 0);
    await page.mouse.move(x0, y0);
    await page.mouse.down();

    await page.mouse.move(x1, y1, { steps: 4 });
    const short = await waitFor(
      () => canvasSignature(page),
      (value) => value !== before,
      "the canvas after the start of the drag",
    );

    await page.mouse.move(x2, y2, { steps: 4 });
    const long = await waitFor(
      () => canvasSignature(page),
      (value) => value !== short,
      "the canvas after the drag covered more cells",
    );

    await page.mouse.up();
    const probe = await stopProbe(page);

    // Criterion 25. The pixels of the canvas changed two times during the
    // drag, so the highlight followed the pointer.
    expect(short).not.toBe(before);
    expect(long).not.toBe(short);
    expect(probe.renders).toBeGreaterThan(0);
    expect(await hasSelection(page)).toBe(true);

    // The absence half. No other event produced these frames. The cells of
    // the terminal did not change, so the new pixels carry the highlight and
    // nothing else. Every frame that painted painted every row, which is the
    // signature of the selection path.
    expectSelectionFrames(probe, grid.rows);
    expect(await cursor(page)).toEqual(cursorBefore);
    expect(await viewportText(page)).toEqual(textBefore);
    expect(await clientState(page)).toEqual(stateBefore);
    expect(server().received.length).toBe(sentBefore);
  });
});

test("a completed drag leaves the terminal quiet and keeps the highlight", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");

    // Criterion 26, the first half. A quiet terminal with no selection
    // activity presents zero frames.
    await expectQuiet(page);
    const quiet = await canvasSignature(page);

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });
    expect(await hasSelection(page)).toBe(true);
    const highlighted = await waitFor(
      () => canvasSignature(page),
      (value) => value !== quiet,
      "the canvas after the drag",
    );
    await idle(SETTLE_MS);

    // Criterion 26, the second half. The request of each mouse event is
    // one-shot, so the terminal is quiet again after the last one. A request
    // that stayed set would paint every row on every frame.
    await expectQuiet(page);

    // The canvas holds the highlight over that quiet period, because the
    // drawing buffer is preserved.
    expect(await canvasSignature(page)).toBe(highlighted);
  });
});

test("a clear repaints the canvas back to the paint with no highlight", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await expectQuiet(page);
    const grid = await gridSize(page);
    const quiet = await canvasSignature(page);

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });
    const highlighted = await waitFor(
      () => canvasSignature(page),
      (value) => value !== quiet,
      "the canvas after the drag",
    );
    await idle(SETTLE_MS);

    const cursorBefore = await cursor(page);
    const textBefore = await viewportText(page);
    const sentBefore = server().received.length;

    await startProbe(page);
    await clearSelection(page);
    const cleared = await waitFor(
      () => canvasSignature(page),
      (value) => value !== highlighted,
      "the canvas after the clear",
    );
    const probe = await stopProbe(page);

    // Criterion 25 for the clear. The canvas came back to the paint that
    // carried no highlight, and no other event produced that frame.
    expect(await hasSelection(page)).toBe(false);
    expect(cleared).toBe(quiet);
    expect(probe.renders).toBeGreaterThan(0);
    expectSelectionFrames(probe, grid.rows);
    expect(await cursor(page)).toEqual(cursorBefore);
    expect(await viewportText(page)).toEqual(textBefore);
    expect(server().received.length).toBe(sentBefore);
  });
});

test("the frames of a drag follow the mouse events, not the animation frames", async () => {
  // The measurement behind the choice of a full redraw over a present. A
  // present alone leaves the pixels of the canvas unchanged (see
  // `requestRedraw` of `src/render/index.ts`), so the rows must go to the GPU
  // again. The cost of that choice is bounded here: the terminal presents one
  // frame for each mouse event of the drag at most, never one for each
  // animation frame of the browser. A request that never cleared would give
  // one frame for each animation frame.
  const STEPS = 20;
  /** The mouse events of the drag: the first move, the steps, down, and up. */
  const EVENTS = STEPS + 3;
  /** The window of the count. It covers the drag and a quiet tail. */
  const WINDOW_MS = 4000;

  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await expectQuiet(page);

    const grid = await gridSize(page);
    const [x0, y0] = await pointOf(page, 0, 0);
    const [x1, y1] = await pointOf(page, grid.cols - 1, grid.rows - 1);

    const counting = countRenders(page, WINDOW_MS);
    // The wrapper goes on inside `counting`. Give it the task it needs before
    // the drag starts.
    await idle(100);

    const started = Date.now();
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: STEPS });
    await page.mouse.up();
    const elapsed = Date.now() - started;
    const renders = await counting;

    // eslint-disable-next-line no-console
    console.log(
      `  drag over ${grid.cols}x${grid.rows} cells: ${renders} frames for ${EVENTS} mouse ` +
        `events, drag ${elapsed} ms, window ${WINDOW_MS} ms`,
    );
    expect(await hasSelection(page)).toBe(true);
    expect(elapsed).toBeLessThan(WINDOW_MS);
    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThanOrEqual(EVENTS);
  });
});

/**
 * A point below the canvas, inside the page.
 *
 * The canvas of the 1000 by 600 client sits at 8, 8 and it measures 981 by
 * 570, so the page holds a band of 14 pixels below it. A mouse-up in that band
 * reaches the page and it reaches no listener of the canvas.
 */
async function pointBelowCanvas(page: Page): Promise<[number, number]> {
  const box = await page.locator("#terminal canvas").boundingBox();
  expect(box).not.toBeNull();
  const view = page.viewportSize();
  expect(view).not.toBeNull();
  const below = box!.y + box!.height + 2;
  expect(below).toBeLessThan(view!.height);
  return [box!.x + box!.width / 2, below];
}

test("a mouse-up outside the canvas ends the drag, and a later hover paints nothing", async () => {
  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await expectQuiet(page);

    // The drag leaves the canvas with the button down and it ends outside.
    // The mouse-up listener sits on the canvas, so it never sees this event.
    const [x0, y0] = await pointOf(page, 0, 0);
    const [x1, y1] = await pointOf(page, 10, 0);
    const [xOut, yOut] = await pointBelowCanvas(page);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.move(xOut, yOut, { steps: 4 });
    await page.mouse.up();
    await idle(SETTLE_MS);
    await expectQuiet(page);

    const textAfterDrag = await selectedText(page);
    const grid = await gridSize(page);

    // Criterion 26. The pointer crosses the canvas with no button down. This
    // is no selection activity, so the terminal presents zero frames.
    await startProbe(page);
    const hovering = (async () => {
      for (let index = 0; index < 12; index += 1) {
        const [hx, hy] = await pointOf(page, 20 + index, Math.min(5, grid.rows - 1));
        await page.mouse.move(hx, hy);
        await idle(20);
      }
    })();
    const renders = await countRenders(page, 800);
    await hovering;
    const probe = await stopProbe(page);

    expect(renders).toBe(0);
    expect(probe.renders).toBe(0);
    // The hover also moves no end cell of the drag that ended outside. The
    // drag crossed the rows below row 0 on its way out, so the text of the
    // selection covers them. The hover must not add to it.
    expect(textAfterDrag).toContain("hello world");
    expect(await selectedText(page)).toBe(textAfterDrag);
  });
});
