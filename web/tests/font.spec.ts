/**
 * The font size control: two menu buttons and two hotkeys.
 *
 * A size change alters the size of a cell, so the terminal must refit. The
 * property that matters here is the one the client notes name directly: one
 * change of the size gives exactly one `0x01` resize frame, on the same
 * debounce as a window drag, never two.
 */

import { expect, test } from "bun:test";
import {
  clientState,
  framesWithTag,
  hex,
  idle,
  server,
  size,
  waitFor,
  waitForConnected,
  withClient,
} from "./harness";

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
  stub.reset();

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

test("a larger font gives fewer columns, and a smaller font gives more columns", async () => {
  const stub = server();
  stub.reset();

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
    expect(larger.cols).toBeLessThan(original.cols);

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
    expect(smaller.cols).toBeGreaterThan(original.cols);
  });
});

test("three rapid changes give exactly one resize frame", async () => {
  const stub = server();
  stub.reset();

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
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
  const stub = server();
  stub.reset();

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
