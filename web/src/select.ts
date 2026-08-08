/**
 * Mouse selection and copy for the terminal grid.
 *
 * `@beamterm/renderer` 1.0.0 owns the drag. `enableSelection` attaches
 * `mousedown`, `mouseup`, `mousemove`, `click`, `mouseenter`, and `mouseleave`
 * listeners to the canvas from Rust (`beamterm-renderer/src/mouse.rs:326`).
 * The client forwards no event to the package. On a mouse-up with the left
 * button the package copies the selected text to the system clipboard by
 * itself (`beamterm-renderer/src/mouse.rs:446`), through
 * `navigator.clipboard.writeText`. This module therefore never calls
 * `copyToClipboard`.
 *
 * The package keeps the range of the active selection in a private tracker
 * (`beamterm-core/src/gl/selection.rs`). Version 1.0.0 exports no accessor for
 * that range, and `getText` takes a `CellQuery` that the caller builds. This
 * module therefore records the drag itself, with a second set of listeners on
 * the same canvas. `addEventListener` permits many listeners on one element,
 * and this module never calls `setMouseHandler`. `setMouseHandler` and
 * `enableSelection` remove each other, because each one drops the mouse
 * handler that is present (`beamterm-renderer/src/terminal.rs:464` and `:494`).
 *
 * The cell arithmetic is a copy of `pixel_to_cell` of `mouse.rs:310`: the
 * offset of the event divided by the CSS cell size, rounded down. An offset
 * outside the grid gives no cell, and the package drops such an event as well.
 *
 * `text` answers the empty string when the package reports no selection. The
 * package clears the selection when the cells under it change
 * (`beamterm-renderer/src/mouse.rs:453`), so the recorded range alone is not
 * proof of a live selection.
 */

import { CellQuery, SelectionMode } from "@beamterm/renderer/web";

import type { GridRenderer } from "./render";
import { beamOf } from "./terminal";

/** One cell of the grid, in columns and rows from the top left corner. */
interface Cell {
  col: number;
  row: number;
}

/** The selection of the page. `src/main.ts` exposes it to the tests. */
export interface Selection {
  /** True while a completed selection covers one cell or more. */
  hasSelection(): boolean;
  /** The text of the completed selection, or the empty string. */
  text(): string;
  /** Drop the selection. `hasSelection` then answers false. */
  clear(): void;
}

/**
 * The count of completed `installSelection` calls of this page.
 *
 * `tests/select.spec.ts` reads this count through `__pirate`. The count proves
 * that a theme change adds no second set of listeners.
 */
let installs = 0;

/** The count of completed `installSelection` calls of this page. */
export function selectionInstalls(): number {
  return installs;
}

/**
 * Turn on mouse selection for the canvas inside `container`.
 *
 * Call this function once for the life of the page. `src/main.ts` rebuilds the
 * `PirateTerminal` facade on every theme change, and both the renderer and the
 * canvas survive that rebuild, so the listeners survive it too.
 *
 * The function throws when the container holds no canvas, and it throws on a
 * second call. `enableSelection` of `@beamterm/renderer` also throws when the
 * browser refuses a listener.
 */
export function installSelection(renderer: GridRenderer, container: HTMLElement): Selection {
  if (installs > 0) {
    throw new Error("selection is already installed");
  }
  const canvas = container.querySelector("canvas");
  if (canvas === null) {
    throw new Error("the terminal container holds no canvas");
  }
  const beam = beamOf(renderer);

  // Linear mode follows the flow of the text and wraps at the end of a row.
  // Block mode cuts a rectangle. A terminal selection is linear.
  //
  // The second argument removes the trailing blanks of each selected row. A
  // terminal row is blank to the right of its last character, so without the
  // trim every multi-row selection carries a run of spaces.
  beam.enableSelection(SelectionMode.Linear, true);
  installs += 1;

  /** The cell of the mouse-down of the drag that runs now, or of the last drag. */
  let start: Cell | null = null;
  /** The last cell that the drag covered, or null while no drag completed. */
  let end: Cell | null = null;
  /** True between the mouse-down and the mouse-up of one drag. */
  let dragging = false;

  /**
   * The cell under the pointer, or null for a point outside the grid.
   *
   * `offsetX` and `offsetY` count from the padding edge of the canvas. The
   * canvas carries no padding, so they count from its top left corner.
   */
  function cellOf(event: MouseEvent): Cell | null {
    const size = renderer.cellSize();
    if (size.width <= 0 || size.height <= 0) {
      return null;
    }
    const col = Math.floor(event.offsetX / size.width);
    const row = Math.floor(event.offsetY / size.height);
    if (col < 0 || row < 0 || col >= renderer.cols || row >= renderer.rows) {
      return null;
    }
    return { col, row };
  }

  canvas.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    const cell = cellOf(event);
    if (cell === null) {
      return;
    }
    start = cell;
    end = null;
    dragging = true;
  });

  canvas.addEventListener("mousemove", (event: MouseEvent) => {
    if (!dragging) {
      return;
    }
    const cell = cellOf(event);
    if (cell === null) {
      return;
    }
    end = cell;
  });

  canvas.addEventListener("mouseup", (event: MouseEvent) => {
    if (event.button !== 0 || !dragging) {
      return;
    }
    const cell = cellOf(event);
    if (cell === null) {
      // The package drops this event as well, so the drag stays open for both
      // sides. Keep `dragging` true.
      return;
    }
    end = cell;
    dragging = false;
  });

  return {
    hasSelection(): boolean {
      return beam.hasSelection();
    },

    text(): string {
      if (!beam.hasSelection() || start === null || end === null) {
        return "";
      }
      // Each of `start`, `end`, and `trimTrailingWhitespace` consumes its
      // receiver and gives back a new wrapper around a new wasm object. Only
      // the last wrapper of the chain holds a live pointer, so only that one
      // takes `free`.
      const query = new CellQuery(SelectionMode.Linear)
        .start(start.col, start.row)
        .end(end.col, end.row)
        .trimTrailingWhitespace(true);
      try {
        return beam.getText(query);
      } finally {
        query.free();
      }
    },

    clear(): void {
      beam.clearSelection();
      start = null;
      end = null;
      dragging = false;
    },
  };
}
