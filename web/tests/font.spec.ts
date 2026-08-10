/**
 * The font size control: two menu buttons and two hotkeys.
 *
 * A size change alters the size of a cell, so the terminal must refit. The
 * property that matters here is the one the client notes name directly: one
 * change of the size gives exactly one `0x01` resize frame, on the same
 * debounce as a window drag, never two.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  clientState,
  countFits,
  framesWithTag,
  hex,
  idle,
  server,
  size,
  waitFor,
  waitForConnected,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/** Every resize frame that the client sent. Mirrors `tests/resize.spec.ts`. */
function resizeFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 5 && frame[0] === 0x01);
}

/** The cols and rows that a resize frame carries, both big-endian. */
function frameDims(frame: Uint8Array): { cols: number; rows: number } {
  return {
    cols: frame[1] * 256 + frame[2],
    rows: frame[3] * 256 + frame[4],
  };
}

test("one font size change gives exactly one resize frame, with the new size", async () => {
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;
    const beforeSize = await size(page);

    await page.click("#font-increase");

    await idle(debounce + 400);

    const frames = resizeFrames(stub.received);
    const after = frames.length;
    const state = await clientState(page);
    const afterSize = await size(page);
    const frame = frames[frames.length - 1];
    const dims = frameDims(frame);

    // eslint-disable-next-line no-console
    console.log(
      `  font ${beforeSize.cols}x${beforeSize.rows} → ${afterSize.cols}x${afterSize.rows}: ` +
        `resize frames ${before} → ${after}, frame ${hex(frame)}`,
    );

    expect(after - before).toBe(1);
    expect(state.fontSize).toBe(15);
    expect(dims.cols).toBe(afterSize.cols);
    expect(dims.rows).toBe(afterSize.rows);
  });
});

test("a larger font gives a smaller grid, and a smaller font gives a larger grid", async () => {
  // The atlas of `@beamterm/renderer` rasterizes at whole device pixels, so a
  // cell size is a whole number and one step of the font size does not always
  // change both of its sides. Measurement at a device pixel ratio of 1, in the
  // container of this test: font 13 gives a cell of 8 by 13, font 14 gives 9 by
  // 15, and font 15 gives 9 by 16. The column count therefore holds from 14 to
  // 15 while the row count falls.
  //
  // This test measures the cell count of the grid, which is the size of the
  // screen. It also holds each side to its direction, so a font increase can
  // never widen the grid.
  await withClient(async (page) => {
    const debounce = (await clientState(page)).resizeDebounceMs;
    const original = await size(page);

    await page.click("#font-increase");
    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === 15,
      "the increased size",
    );
    await idle(debounce + 400);
    const larger = await size(page);
    expect(larger.cols * larger.rows).toBeLessThan(original.cols * original.rows);
    expect(larger.cols).toBeLessThanOrEqual(original.cols);
    expect(larger.rows).toBeLessThanOrEqual(original.rows);

    // Two decreases: one back to the original size, one below it.
    await page.click("#font-decrease");
    await page.click("#font-decrease");
    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === 13,
      "the decreased size",
    );
    await idle(debounce + 400);
    const smaller = await size(page);
    expect(smaller.cols * smaller.rows).toBeGreaterThan(original.cols * original.rows);
    expect(smaller.cols).toBeGreaterThanOrEqual(original.cols);
    expect(smaller.rows).toBeGreaterThanOrEqual(original.rows);
  });
});

test("three rapid changes give exactly one resize frame", async () => {
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => resizeFrames(stub.received),
      (list) => list.length >= 1,
      "the first resize frame",
    );
    const debounce = (await clientState(page)).resizeDebounceMs;
    const before = resizeFrames(stub.received).length;

    // Three presses inside the debounce window, as a window drag gives.
    await page.evaluate(() => {
      const button = document.getElementById("font-increase") as HTMLButtonElement;
      button.click();
      button.click();
      button.click();
    });

    await idle(debounce + 400);

    const after = resizeFrames(stub.received).length;
    const state = await clientState(page);

    // eslint-disable-next-line no-console
    console.log(`  three presses: fontSize ${state.fontSize}, resize frames ${after - before}`);

    expect(state.fontSize).toBe(17);
    expect(after - before).toBe(1);
  });
});

test("the hotkeys change the size, and send no input frame", async () => {
  // The double-send guard. The registry stops the chord in the capture
  // phase, so ghostty-web never encodes it and the client sends no bytes.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    // One plain key first. It proves that this page does send input frames,
    // so the count below can stay flat for a real reason.
    const before = framesWithTag(stub.received, 0x00).length;
    await page.keyboard.press("x");
    await waitFor(
      async () => framesWithTag(stub.received, 0x00).length,
      (count) => count === before + 1,
      "the input frame of the plain key",
    );
    const baseline = framesWithTag(stub.received, 0x00).length;
    const initial = (await clientState(page)).fontSize;

    await page.keyboard.press("Alt+Equal");
    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === initial + 1,
      "the size after the increase hotkey",
    );

    await page.keyboard.press("Alt+Minus");
    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === initial,
      "the size after the decrease hotkey",
    );

    await idle(300);
    const after = framesWithTag(stub.received, 0x00).length;
    // eslint-disable-next-line no-console
    console.log(`  alt+= then alt+-: input frames ${baseline} → ${after}`);
    expect(after).toBe(baseline);
  });
});

test("the size clamps at 8, and the decrease button is disabled there", async () => {
  await withClient(async (page) => {
    // 30 presses is more than the whole range (8 to 32). Every press past the
    // limit does nothing, because a disabled button takes no click.
    await page.evaluate(() => {
      const button = document.getElementById("font-decrease") as HTMLButtonElement;
      for (let i = 0; i < 30; i += 1) {
        button.click();
      }
    });

    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === 8,
      "the size at the low limit",
    );

    expect(await page.getAttribute("#font-decrease", "disabled")).not.toBe(null);
    expect(await page.getAttribute("#font-increase", "disabled")).toBe(null);
    expect(((await page.textContent("#font-value")) ?? "").trim()).toBe("8");
  });
});

test("the size clamps at 32, and the increase button is disabled there", async () => {
  await withClient(async (page) => {
    await page.evaluate(() => {
      const button = document.getElementById("font-increase") as HTMLButtonElement;
      for (let i = 0; i < 30; i += 1) {
        button.click();
      }
    });

    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === 32,
      "the size at the high limit",
    );

    expect(await page.getAttribute("#font-increase", "disabled")).not.toBe(null);
    expect(await page.getAttribute("#font-decrease", "disabled")).toBe(null);
    expect(((await page.textContent("#font-value")) ?? "").trim()).toBe("32");
  });
});

test("the font size survives a page reload", async () => {
  await withClient(async (page) => {
    await page.click("#font-increase");
    await page.click("#font-increase");
    await waitFor(
      async () => (await clientState(page)).fontSize,
      (value) => value === 16,
      "the size before the reload",
    );

    await page.reload();
    await waitForConnected(page);

    const state = await clientState(page);
    expect(state.fontSize).toBe(16);
    expect(((await page.textContent("#font-value")) ?? "").trim()).toBe("16");
  });
});

/*
 * The line height control.
 *
 * The line height is a multiplier of the cell height of the font metric.
 * The renderer takes this multiplier, so the cell grows, the row count of the
 * grid falls, and the client sends one resize frame. The debounced pass is
 * therefore the measurable property, and `countFits` counts it: `src/main.ts`
 * calls `grid.fit()` one time in each pass.
 */

/** The text of the line height label. */
async function lineValue(page: Page): Promise<string> {
  return ((await page.textContent("#line-height-value")) ?? "").trim();
}

/** The active element of the page, and whether it sits inside `#terminal`. */
function focusInTerminal(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const terminal = document.getElementById("terminal");
    return active !== null && terminal !== null && terminal.contains(active);
  });
}

/** Click one button `count` times, inside one debounce window. */
function clickMany(page: Page, id: string, count: number): Promise<void> {
  return page.evaluate(
    ({ id: name, count: times }: { id: string; count: number }) => {
      const button = document.getElementById(name) as HTMLButtonElement;
      for (let i = 0; i < times; i += 1) {
        button.click();
      }
    },
    { id, count },
  );
}

test("the line height starts at 1.0, and the decrease button is disabled there", async () => {
  await withClient(async (page) => {
    const state = await clientState(page);
    expect(state.lineHeight).toBe(1.0);
    expect(await lineValue(page)).toBe("1.0");
    expect(await page.getAttribute("#line-height-decrease", "disabled")).not.toBe(null);
    expect(await page.getAttribute("#line-height-increase", "disabled")).toBe(null);
  });
});

test("one line height change asks for exactly one fit, and sends one resize frame", async () => {
  const stub = server();

  await withClient(async (page) => {
    const debounce = (await clientState(page)).resizeDebounceMs;
    await idle(debounce + 400);
    const before = resizeFrames(stub.received).length;
    const beforeSize = await size(page);

    // The quiet control. A page that fits on its own makes the next count
    // true for the wrong reason.
    expect(await countFits(page, debounce + 400)).toBe(0);

    const counting = countFits(page, debounce + 400);
    await idle(100);
    await page.click("#line-height-increase");
    const fits = await counting;

    const state = await clientState(page);
    const after = resizeFrames(stub.received).length;
    const afterSize = await size(page);

    // eslint-disable-next-line no-console
    console.log(
      `  line height ${state.lineHeight}: fits ${fits}, ` +
        `resize frames ${after - before}, grid ${afterSize.cols}x${afterSize.rows}`,
    );

    expect(fits).toBe(1);
    expect(state.lineHeight).toBe(1.1);
    expect(await lineValue(page)).toBe("1.1");
    // The renderer takes the line height, so the cell grows and the client
    // sends one frame. Measurement: one press gives 1.1, and the grid goes
    // from 109x38 to 109x34.
    expect(after - before).toBe(1);
    expect(afterSize.rows).toBeLessThan(beforeSize.rows);
    expect(afterSize.cols).toBe(beforeSize.cols);
  });
});

test("three rapid line height changes ask for exactly one fit", async () => {
  await withClient(async (page) => {
    const debounce = (await clientState(page)).resizeDebounceMs;
    await idle(debounce + 400);

    const counting = countFits(page, debounce + 400);
    await idle(100);
    await clickMany(page, "line-height-increase", 3);
    const fits = await counting;

    const state = await clientState(page);
    // eslint-disable-next-line no-console
    console.log(`  three presses: lineHeight ${state.lineHeight}, fits ${fits}`);

    expect(fits).toBe(1);
    // The step arithmetic holds one decimal. A plain sum of three steps gives
    // 1.3000000000000003.
    expect(state.lineHeight).toBe(1.3);
    expect(await lineValue(page)).toBe("1.3");
  });
});

test("each step of the line height holds one decimal, over the whole range", async () => {
  await withClient(async (page) => {
    const seen: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await page.click("#line-height-increase");
      seen.push((await clientState(page)).lineHeight);
    }
    // eslint-disable-next-line no-console
    console.log(`  steps: ${seen.join(" ")}`);
    expect(seen).toEqual([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0]);
  });
});

test("the line height clamps at 2.0, and the increase button is disabled there", async () => {
  await withClient(async (page) => {
    await clickMany(page, "line-height-increase", 20);
    await waitFor(
      async () => (await clientState(page)).lineHeight,
      (value) => value === 2.0,
      "the line height at the high limit",
    );
    expect(await page.getAttribute("#line-height-increase", "disabled")).not.toBe(null);
    expect(await page.getAttribute("#line-height-decrease", "disabled")).toBe(null);
    expect(await lineValue(page)).toBe("2.0");
  });
});

test("the line height clamps at 1.0, and the decrease button is disabled there", async () => {
  await withClient(async (page) => {
    await clickMany(page, "line-height-increase", 5);
    await waitFor(
      async () => (await clientState(page)).lineHeight,
      (value) => value === 1.5,
      "the line height before the decrease",
    );
    await clickMany(page, "line-height-decrease", 20);
    await waitFor(
      async () => (await clientState(page)).lineHeight,
      (value) => value === 1.0,
      "the line height at the low limit",
    );
    expect(await page.getAttribute("#line-height-decrease", "disabled")).not.toBe(null);
    expect(await lineValue(page)).toBe("1.0");
  });
});

test("a line height equal to the current value writes nothing and asks for no fit", async () => {
  await withClient(async (page) => {
    const debounce = (await clientState(page)).resizeDebounceMs;
    await idle(debounce + 400);
    const cookieBefore = (await page.context().cookies())[0]?.value ?? "";

    // The value is 1.0 and the decrease button is disabled, so each press
    // reaches no handler. The state, the store, and the fit path all hold.
    const counting = countFits(page, debounce + 400);
    await idle(100);
    await clickMany(page, "line-height-decrease", 5);
    const fits = await counting;

    expect(fits).toBe(0);
    expect((await clientState(page)).lineHeight).toBe(1.0);
    expect((await page.context().cookies())[0]?.value ?? "").toBe(cookieBefore);
  });
});

test("a line height button gives the focus back to the terminal", async () => {
  await withClient(async (page) => {
    await page.click("#line-height-increase");
    expect(await focusInTerminal(page)).toBe(true);
    await page.click("#line-height-decrease");
    expect(await focusInTerminal(page)).toBe(true);
  });
});

test("the line height survives a page reload", async () => {
  await withClient(async (page) => {
    await clickMany(page, "line-height-increase", 5);
    await waitFor(
      async () => (await clientState(page)).lineHeight,
      (value) => value === 1.5,
      "the line height before the reload",
    );

    await page.reload();
    await waitForConnected(page);

    expect((await clientState(page)).lineHeight).toBe(1.5);
    expect(await lineValue(page)).toBe("1.5");
  });
});
