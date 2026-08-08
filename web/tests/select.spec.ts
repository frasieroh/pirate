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
 * than zero. The first test proves that the `beam` field of the renderer is
 * reachable at run time, which is the base of `beamOf` in `src/terminal.ts`.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import { clientState, paintedPixels, server, viewportLine, waitFor, withClient } from "./harness";

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
    term: { renderer: { cellSize(): { width: number; height: number } } };
  };
};

/** True while a completed selection covers one cell or more. */
function hasSelection(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (globalThis as unknown as SelectWindow).__pirate.selection.hasSelection(),
  );
}

/** The text of the completed selection. */
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
    await writeAndPaint(page, "hello world", "hello world");

    await dragCells(page, { col: 0, row: 0 }, { col: 10, row: 0 });

    // beamterm writes the clipboard through `navigator.clipboard.writeText`
    // and awaits no promise (`beamterm-renderer/src/js.rs:68`), so the write
    // lands in a later task than the mouse-up.
    const text = await waitFor(
      () => clipboardText(page),
      (value) => value === "hello world",
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
