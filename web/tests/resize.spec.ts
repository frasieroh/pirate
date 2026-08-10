/**
 * Resize frames: tag `0x01` from the client.
 *
 * The payload is a `u16` cols and a `u16` rows, both big-endian.
 *
 * The block `VtTerminal.resize` at the end of this file is a unit test of the
 * VT layer. It opens no browser and it sends no frame. It reads the wasm
 * binary out of `node_modules`, as `web/tests/vt.spec.ts` does.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { loadVt, type Vt, type VtTerminal } from "../src/vt";
import {
  clientState,
  hex,
  idle,
  server,
  size,
  waitFor,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/** Every resize frame that the client sent. */
function resizeFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 5 && frame[0] === 0x01);
}

/**
 * The pause inside a drag, in milliseconds.
 *
 * The value is more than the debounce of `src/main.ts` and less than the
 * 100 ms of the client before the measurement of the resize latency.
 */
const PAUSE_MS = 70;

/** The viewport that a storm of these tests starts from. */
const FLOOD_START = { width: 1000, height: 600 };

/** Size changes in one storm. */
const STORM_STEPS = 12;

/** Milliseconds between two steps of a storm. */
const STORM_STEP_MS = 40;

/** Lines that one step of the flood sends. */
const FLOOD_BATCH = 25;

/** One line of the flood. It is short, so no size change wraps it. */
function floodLine(number: number): string {
  return `line ${String(number).padStart(4, "0")}`;
}

/** A size in cells. */
interface CellSize {
  cols: number;
  rows: number;
}

/** The size that each layer of the client holds. */
interface LayerSizes {
  /** The cells that the container holds now, from the renderer. */
  container: CellSize;
  /** The grid of the renderer. */
  grid: CellSize;
  /** The VT terminal. */
  vt: CellSize;
}

/**
 * Read `value` until two reads, `gapMs` apart, give the same result.
 *
 * A fixed wait after a storm is not enough on a loaded machine. The resize
 * callbacks of the browser then arrive after the read, and the client fits
 * after it. This poll waits for the client to stop instead.
 */
async function afterQuiet<T>(value: () => Promise<T>, gapMs: number): Promise<T> {
  let last = JSON.stringify(await value());
  const state = await waitFor(
    async () => {
      await idle(gapMs);
      const now = await value();
      const text = JSON.stringify(now);
      const same = text === last;
      last = text;
      return { now, same };
    },
    (read) => read.same,
    "the client to stop after the storm",
  );
  return state.now;
}

/**
 * Every row of the buffer that holds text, scrollback included.
 *
 * `viewportText` of the harness reads the viewport alone. A flood of more
 * lines than the rows of the viewport pushes the early lines into the
 * scrollback, and a drop there stays out of the viewport.
 */
function bufferText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (
      globalThis as unknown as {
        __pirate: {
          term: {
            buffer: {
              active: {
                length: number;
                getLine(index: number): { translateToString(trim?: boolean): string } | undefined;
              };
            };
          };
        };
      }
    ).__pirate.term;
    const buffer = term.buffer.active;
    const out: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const text = buffer.getLine(index)?.translateToString(true) ?? "";
      if (text.length > 0) {
        out.push(text);
      }
    }
    return out;
  });
}

/**
 * Read the size of each layer of the client.
 *
 * `fit` of the renderer measures the container and it writes nothing, so this
 * read changes no size.
 */
function layerSizes(page: Page): Promise<LayerSizes> {
  return page.evaluate(() => {
    const term = (
      globalThis as unknown as {
        __pirate: {
          term: {
            cols: number;
            rows: number;
            renderer: { cols: number; rows: number; fit(): CellSize };
          };
        };
      }
    ).__pirate.term;
    const fitted = term.renderer.fit();
    return {
      container: { cols: fitted.cols, rows: fitted.rows },
      grid: { cols: term.renderer.cols, rows: term.renderer.rows },
      vt: { cols: term.cols, rows: term.rows },
    };
  });
}

test("the first resize frame carries the size of the terminal, big-endian", async () => {
  const stub = server();

  await withClient(async (page) => {
    const frames = await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const frame = frames[0];
    const { cols, rows } = await size(page);

    // eslint-disable-next-line no-console
    console.log(`  terminal ${cols}x${rows} → frame ${hex(frame)}`);

    expect(frame[0]).toBe(0x01);
    // Big-endian: the high byte comes first. Both values are less than 256
    // here, so the high byte is 0. Little-endian would put the value first.
    expect(frame[1]).toBe(Math.floor(cols / 256));
    expect(frame[2]).toBe(cols % 256);
    expect(frame[3]).toBe(Math.floor(rows / 256));
    expect(frame[4]).toBe(rows % 256);
  });
});

test("a smaller window gives a new resize frame with the new size", async () => {
  const stub = server();

  await withClient(async (page) => {
    const first = await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const before = await size(page);

    await page.setViewportSize({ width: 640, height: 400 });

    const frames = await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length > first.length,
      "a resize frame for the new window",
    );
    const frame = frames[frames.length - 1];
    const after = await size(page);

    // eslint-disable-next-line no-console
    console.log(`  ${before.cols}x${before.rows} → ${after.cols}x${after.rows}: frame ${hex(frame)}`);

    expect(after.cols).toBeLessThan(before.cols);
    expect(frame[1] * 256 + frame[2]).toBe(after.cols);
    expect(frame[3] * 256 + frame[4]).toBe(after.rows);
  });
});

test("a burst of size changes gives one resize frame", async () => {
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;

    // Ten size changes inside the debounce window, as a window drag gives.
    await page.evaluate(async (steps: number) => {
      const element = document.getElementById("terminal") as HTMLElement;
      for (let i = 0; i < steps; i += 1) {
        element.style.paddingRight = `${8 + i * 4}px`;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, 10);

    await idle(debounce + 400);
    const after = resizeFrames(stub.received).length;

    // eslint-disable-next-line no-console
    console.log(`  debounce ${debounce} ms: 10 size changes gave ${after - before} resize frame(s)`);
    expect(after - before).toBe(1);
  });
});

test("a drag that pauses for 70 ms sends the size of the pause", async () => {
  // The debounce holds one drag together. A pause inside the drag is the end
  // of a drag for the operator, and the size of that pause must reach the
  // server. This test therefore pins the debounce under the length of the
  // pause. It counts frames and it measures no duration.
  const stub = server();

  await withClient(
    async (page) => {
      const first = await waitFor(
        async () => resizeFrames(stub.received),
        (list) => list.length >= 1,
        "the first resize frame",
      );
      const before = first.length;

      await page.setViewportSize({ width: 900, height: 560 });
      await idle(PAUSE_MS);
      await page.setViewportSize({ width: 760, height: 480 });

      const frames = await waitFor(
        async () => resizeFrames(stub.received),
        (list) => list.length >= before + 2,
        "one resize frame for each half of the drag",
      );
      const after = await size(page);
      const last = frames[frames.length - 1];

      // eslint-disable-next-line no-console
      console.log(
        `  a pause of ${PAUSE_MS} ms gave ${frames.length - before} resize frame(s)`,
      );
      expect(last[1] * 256 + last[2]).toBe(after.cols);
      expect(last[3] * 256 + last[4]).toBe(after.rows);
    },
    { viewport: { width: 1000, height: 600 } },
  );
});

test("a flood of output during a resize storm loses no line and corrupts none", async () => {
  const stub = server();

  await withClient(
    async (page) => {
      await waitFor(
        async () => resizeFrames(stub.received),
        (list) => list.length >= 1,
        "the first resize frame",
      );
      const debounce = (await clientState(page)).resizeDebounceMs;

      // Each step shrinks the viewport and sends a batch of lines. The drag
      // only shrinks, so no row comes back out of the scrollback. The block
      // `VtTerminal.resize` holds the reason: ghostty-vt.wasm 0.4.0 fills such
      // a row with the bytes that the allocator left there.
      let sent = 0;
      for (let step = 1; step <= STORM_STEPS; step += 1) {
        await page.setViewportSize({
          width: FLOOD_START.width - step * 24,
          height: FLOOD_START.height - step * 16,
        });
        let batch = "";
        for (let line = 0; line < FLOOD_BATCH; line += 1) {
          sent += 1;
          batch += `${floodLine(sent)}\r\n`;
        }
        stub.send([{ tag: 0x00, text: batch }]);
        await idle(STORM_STEP_MS);
      }
      const rows = await afterQuiet(() => bufferText(page), debounce + 200);

      // eslint-disable-next-line no-console
      console.log(
        `  ${sent} lines through ${STORM_STEPS} size changes: ` +
          `${rows.length} rows, first ${rows[0]}, last ${rows[rows.length - 1]}`,
      );

      // Every row is one whole line of the flood. A row that holds a part of
      // two lines, or a byte that no write sent, fails this pattern.
      for (const row of rows) {
        expect(row).toMatch(/^line \d{4}$/);
      }
      // The lines are consecutive, so no line of the flood is missing.
      const numbers = rows.map((row) => Number(row.slice(5)));
      for (let index = 1; index < numbers.length; index += 1) {
        expect(numbers[index]).toBe(numbers[index - 1] + 1);
      }
      // The buffer holds the first line and the last line of the flood, and
      // the count matches. A drop inside the scrollback fails this check.
      expect(numbers[0]).toBe(1);
      expect(numbers[numbers.length - 1]).toBe(sent);
      expect(numbers.length).toBe(sent);
    },
    { viewport: FLOOD_START },
  );
});

test("after a resize storm the grid, the VT, and the PTY hold one size", async () => {
  const stub = server();

  await withClient(
    async (page) => {
      await waitFor(
        async () => resizeFrames(stub.received),
        (list) => list.length >= 1,
        "the first resize frame",
      );
      const debounce = (await clientState(page)).resizeDebounceMs;

      for (let step = 1; step <= STORM_STEPS; step += 1) {
        await page.setViewportSize({
          width: FLOOD_START.width - step * 24,
          height: FLOOD_START.height - step * 16,
        });
        await idle(STORM_STEP_MS);
      }
      const state = await afterQuiet(async () => {
        const sizes = await layerSizes(page);
        const frames = resizeFrames(stub.received);
        const last = frames[frames.length - 1];
        return {
          ...sizes,
          pty: { cols: last[1] * 256 + last[2], rows: last[3] * 256 + last[4] },
        };
      }, debounce + 200);
      const layers = state;
      const pty = state.pty;

      // eslint-disable-next-line no-console
      console.log(
        `  container ${layers.container.cols}x${layers.container.rows}  ` +
          `grid ${layers.grid.cols}x${layers.grid.rows}  ` +
          `vt ${layers.vt.cols}x${layers.vt.rows}  ` +
          `pty ${pty.cols}x${pty.rows}`,
      );

      expect(layers.grid).toEqual(layers.container);
      expect(layers.vt).toEqual(layers.container);
      expect(pty).toEqual(layers.container);
    },
    { viewport: FLOOD_START },
  );
});

// ============================================================================
// VtTerminal.resize
// ============================================================================

/**
 * `VtTerminal.resize` on the wasm engine. No browser takes part.
 *
 * One module serves most of the block. ghostty-vt.wasm 0.4.0 corrupts its
 * heap when it frees a grid that held a grapheme cluster, and the next grid of
 * the same column count then traps. The grapheme test therefore takes its own
 * module. See the note on `VtTerminal.dispose`.
 */
describe("VtTerminal.resize", () => {
  let vt: Vt;
  let wasmBytes: ArrayBuffer;

  beforeAll(async () => {
    const path = `${import.meta.dir}/../node_modules/ghostty-web/ghostty-vt.wasm`;
    wasmBytes = await Bun.file(path).arrayBuffer();
    vt = await loadVt(wasmBytes);
  });

  /** Make a terminal, run the body, then free the wasm memory. */
  function withTerminal(
    cols: number,
    rows: number,
    body: (term: VtTerminal) => void,
    module: Vt = vt,
  ): void {
    const term = module.createTerminal(cols, rows);
    try {
      body(term);
    } finally {
      term.dispose();
    }
  }

  /** The text of one viewport row, without the trailing empty cells. */
  function rowText(term: VtTerminal, row: number): string {
    const line = term.getLine(row);
    if (line === null) {
      return "";
    }
    return line
      .map((cell) => (cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint)))
      .join("")
      .trimEnd();
  }

  /**
   * Read every row of the viewport, and stop when one row is missing.
   *
   * The row after the last one must give null. A wrong row count in the layer
   * therefore fails here.
   */
  function everyRow(term: VtTerminal): string[] {
    const rows: string[] = [];
    for (let r = 0; r < term.rows; r += 1) {
      const line = term.getLine(r);
      expect(line).not.toBeNull();
      expect(line).toHaveLength(term.cols);
      rows.push(rowText(term, r));
    }
    expect(term.getLine(term.rows)).toBeNull();
    return rows;
  }

  test("a grow reports the new size, and the viewport holds cols by rows cells", () => {
    withTerminal(8, 3, (term) => {
      term.write("pirate");

      term.resize(20, 5);

      expect(term.cols).toBe(20);
      expect(term.rows).toBe(5);
      expect(term.getViewport()).toHaveLength(100);
      expect(everyRow(term)[0]).toBe("pirate");
    });
  });

  test("a shrink reports the new size, and the viewport holds cols by rows cells", () => {
    withTerminal(40, 10, (term) => {
      term.write("pirate");

      term.resize(12, 4);

      expect(term.cols).toBe(12);
      expect(term.rows).toBe(4);
      expect(term.getViewport()).toHaveLength(48);
      expect(everyRow(term)[0]).toBe("pirate");
    });
  });

  test("a grow after a shrink gives a full viewport again", () => {
    // The cell buffer only grows. This test drives the path where the buffer
    // is larger than the grid, then larger again.
    withTerminal(30, 8, (term) => {
      term.resize(5, 2);
      expect(term.getViewport()).toHaveLength(10);

      term.resize(30, 8);
      expect(term.getViewport()).toHaveLength(240);

      term.resize(60, 12);
      expect(term.getViewport()).toHaveLength(720);
      expect(everyRow(term)).toHaveLength(12);
    });
  });

  test("a write after a resize lands in the new grid", async () => {
    withTerminal(8, 3, (term) => {
      term.write("pirate");

      term.resize(20, 5);
      term.write("\r\nsecond line");

      expect(rowText(term, 0)).toBe("pirate");
      // The text is 11 characters. It fits on the new grid and not on the old
      // one, so a stale column count would wrap it.
      expect(rowText(term, 1)).toBe("second line");
    });
  });

  test("a resize keeps a grapheme cluster, and a write after it does not trap", async () => {
    // This terminal holds a cluster when `dispose` frees it. It therefore
    // takes its own module.
    const fresh = await loadVt(wasmBytes);
    withTerminal(
      8,
      3,
      (term) => {
        // `e` and U+0301, the combining acute accent. The module joins them
        // into one cluster in cell 0. The escape keeps the two codepoints
        // apart from the precomposed U+00E9.
        const acute = `e${String.fromCodePoint(0x301)}`;
        term.write(`${acute}x`);
        expect(term.getGraphemeString(0, 0)).toBe(acute);

        term.resize(20, 5);

        expect(term.cols).toBe(20);
        expect(term.getViewport()).toHaveLength(100);
        expect(term.getGraphemeString(0, 0)).toBe(acute);
        expect(term.getGraphemeString(1, 0)).toBe("x");

        term.write(" more");
        // `rowText` reads the base codepoint of each cell, so the cluster
        // shows there as `e` alone. `getGraphemeString` holds the accent.
        expect(rowText(term, 0)).toBe("ex more");
        expect(term.getGraphemeString(0, 0)).toBe(acute);
      },
      fresh,
    );
  });

  test("a resize to a new size reports a full redraw", () => {
    withTerminal(8, 3, (term) => {
      term.write("pirate");
      term.clearDirty();
      expect(term.isDirty()).toBe(false);

      term.resize(20, 5);

      // eslint-disable-next-line no-console
      console.log(`  8x3 -> 20x5: needsFullRedraw ${term.needsFullRedraw()}`);
      expect(term.needsFullRedraw()).toBe(true);
      expect(term.isRowDirty(4)).toBe(true);

      term.clearDirty();
      term.resize(8, 3);

      // eslint-disable-next-line no-console
      console.log(`  20x5 -> 8x3: needsFullRedraw ${term.needsFullRedraw()}`);
      expect(term.needsFullRedraw()).toBe(true);
    });
  });

  test("a resize to the size that the terminal has reports no redraw", () => {
    // The module sets the dirty state, and no row changed here. The JSDoc of
    // `resize` states this case.
    withTerminal(8, 3, (term) => {
      term.write("pirate");
      term.clearDirty();

      term.resize(8, 3);

      expect(term.needsFullRedraw()).toBe(false);
      expect(term.isDirty()).toBe(false);
      expect(term.cols).toBe(8);
      expect(term.rows).toBe(3);
    });
  });

  test("a bad size throws, and the terminal keeps its old size", () => {
    withTerminal(8, 3, (term) => {
      term.write("pirate");

      for (const [cols, rows] of [
        [0, 5],
        [5, 0],
        [-1, 5],
        [5, -1],
        [1.5, 5],
        [5, Number.NaN],
      ] as [number, number][]) {
        expect(() => term.resize(cols, rows)).toThrow(
          /a terminal needs a positive cols and rows/,
        );
      }

      // The module never saw a bad size, so the grid is unchanged and usable.
      expect(term.cols).toBe(8);
      expect(term.rows).toBe(3);
      expect(term.getViewport()).toHaveLength(24);
      expect(rowText(term, 0)).toBe("pirate");
    });
  });

  test("cols and rows take no assignment from outside", () => {
    withTerminal(8, 3, (term) => {
      const outside = term as unknown as { cols: number; rows: number };

      expect(() => {
        outside.cols = 40;
      }).toThrow(TypeError);
      expect(term.cols).toBe(8);
    });
  });

  test("a resize keeps the handle, so the content survives the new size", async () => {
    // A resize that freed the terminal and made a new one would lose these
    // five lines. `resize` calls no `ghostty_terminal_free`.
    //
    // The module reflows the lines across the boundary of the viewport. Five
    // lines on a grid of 3 rows leave 2 lines in the scrollback. A grow to 5
    // rows pulls both lines back into the viewport and leaves the scrollback
    // empty. A shrink to 2 rows pushes 3 lines out again.
    //
    // This test takes its own module. ghostty-vt.wasm 0.4.0 fills the columns
    // after the text of a row that a grow pulls back out of the scrollback
    // with the bytes that the allocator left there. On a heap that already
    // freed a terminal, row 0 of this test then reads `oneate`, where `ate`
    // is the tail of a `pirate` that an earlier test wrote. A measurement of
    // the raw exports gives the same result with no code of this layer, so
    // the defect is in the module. A fresh module has a zeroed heap.
    const fresh = await loadVt(wasmBytes);
    withTerminal(8, 3, (term) => {
      term.write("one\r\ntwo\r\nthree\r\nfour\r\nfive");
      expect(term.getScrollbackLength()).toBe(2);
      expect(everyRow(term)).toEqual(["three", "four", "five"]);

      term.resize(20, 5);

      expect(term.getScrollbackLength()).toBe(0);
      expect(everyRow(term)).toEqual(["one", "two", "three", "four", "five"]);

      term.resize(20, 2);

      expect(term.getScrollbackLength()).toBe(3);
      expect(everyRow(term)).toEqual(["four", "five"]);
      expect(term.getScrollbackLine(0)?.length).toBe(20);
    }, fresh);
  });

  test("a size that the wasm i32 cannot carry throws before the module sees it", () => {
    // JavaScript converts an argument to an i32 at the wasm boundary, with a
    // wrap. A measurement of the raw exports gives the result of each wrap.
    // 2 to the power 31 becomes -2147483648. The module then stops with "Out
    // of bounds memory access". 2 to the power 32 becomes 0, and the module
    // stops the same way. 100000 by 100000 does not return at all.
    //
    // A trap is not a rejection. The layer frees the cell buffer of the old
    // grid before it calls the module. A trap therefore also leaves the
    // terminal unusable, and every later `getViewport` stops the same way.
    withTerminal(8, 3, (term) => {
      term.write("pirate");

      for (const [cols, rows] of [
        [2 ** 31, 1],
        [1, 2 ** 31],
        [2 ** 32, 1],
        [100000, 100000],
        [65535, 65535],
        [65536, 1],
      ] as [number, number][]) {
        expect(() => term.resize(cols, rows)).toThrow(/is too large/);
      }

      // The module never saw any of these sizes, so the terminal still reads.
      expect(term.cols).toBe(8);
      expect(term.rows).toBe(3);
      expect(term.getViewport()).toHaveLength(24);
      expect(rowText(term, 0)).toBe("pirate");
    });
  });

  test("Infinity is not a size", () => {
    withTerminal(8, 3, (term) => {
      for (const [cols, rows] of [
        [Number.POSITIVE_INFINITY, 5],
        [5, Number.POSITIVE_INFINITY],
        [Number.NEGATIVE_INFINITY, 5],
      ] as [number, number][]) {
        expect(() => term.resize(cols, rows)).toThrow(
          /a terminal needs a positive cols and rows/,
        );
      }
      expect(term.cols).toBe(8);
    });
  });

  test("the largest size that the rule allows reaches the module", () => {
    // `CELLS_MAX` is 2 to the power 24. This grid is that count exactly, so
    // the rule and the module agree at the limit.
    withTerminal(8, 3, (term) => {
      term.resize(16384, 1024);

      expect(term.cols).toBe(16384);
      expect(term.rows).toBe(1024);
      expect(term.getLine(1023)).not.toBeNull();
      expect(term.getLine(1024)).toBeNull();
    });
  });

  test("every row is dirty after a resize, and none is after a resize to the same size", () => {
    withTerminal(8, 3, (term) => {
      term.write("pirate");
      term.clearDirty();

      term.resize(20, 5);

      // `needsFullRedraw` and `isRowDirty` must agree. A renderer that trusts
      // one and not the other would leave a stale row on the screen.
      expect(term.needsFullRedraw()).toBe(true);
      for (let row = 0; row < term.rows; row += 1) {
        expect(term.isRowDirty(row)).toBe(true);
      }

      term.clearDirty();
      term.resize(20, 5);

      expect(term.needsFullRedraw()).toBe(false);
      for (let row = 0; row < term.rows; row += 1) {
        expect(term.isRowDirty(row)).toBe(false);
      }
    });
  });

  test("400 resizes in a loop keep the content and the buffer", async () => {
    // The path of a font-size control. This terminal takes its own module,
    // because the shared module already freed a terminal. See the note on the
    // scrollback test.
    const fresh = await loadVt(wasmBytes);
    withTerminal(
      80,
      24,
      (term) => {
        for (let i = 0; i < 200; i += 1) {
          term.resize(60, 18);
          term.resize(100, 30);
        }
        term.write("pirate");

        expect(term.cols).toBe(100);
        expect(term.rows).toBe(30);
        expect(term.getViewport()).toHaveLength(3000);
        expect(rowText(term, 0)).toBe("pirate");

        // No cell outside row 0 holds anything. A stale byte of the wasm heap
        // shows up here as a codepoint that no write put there.
        const written = term
          .getViewport()
          .filter((cell) => cell.codepoint !== 0);
        expect(written).toHaveLength(6);
      },
      fresh,
    );
  });

  test("a resize of a disposed terminal throws", () => {
    const term = vt.createTerminal(8, 3);
    term.dispose();

    expect(() => term.resize(20, 5)).toThrow(/disposed/);
  });
});
