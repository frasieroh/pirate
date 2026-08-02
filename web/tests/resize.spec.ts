/**
 * Resize frames: tag `0x01` from the client.
 *
 * The payload is a `u16` cols and a `u16` rows, both big-endian.
 */

import { beforeEach, expect, test } from "bun:test";
import { clientState, hex, idle, server, size, waitFor, withClient } from "./harness";

beforeEach(() => {
  server().reset();
});

/** Every resize frame that the client sent. */
function resizeFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => frame.length === 5 && frame[0] === 0x01);
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
