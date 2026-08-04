/**
 * Dump frames: tag `0x01`, and the stale screen of risk 5.
 *
 * A dump is one large write, and the stream goes quiet after it. The facade of
 * `src/terminal.ts` paints from an animation frame loop, independent of the
 * parse, so this shape is the one that can leave a stale screen on the canvas.
 *
 * The server sends a dump when a socket opens, and again after it drops the
 * backlog of a slow client. Both cases have the same shape.
 *
 * These tests measure the canvas, not the parser. A parser assertion cannot
 * see a stale screen, because the parser is never the part that fails.
 */

import { beforeEach, expect, test } from "bun:test";
import {
  canvasSignature,
  countRenders,
  ESC,
  idle,
  paintedPixels,
  server,
  size,
  stopRenderLoop,
  viewportLine,
  viewportText,
  waitFor,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

/**
 * A screen of `rows` numbered lines, in the form of a state dump.
 *
 * Each line goes to its own row through cursor addressing, and each line
 * carries a color. Nothing scrolls, so no scrollbar appears and the canvas
 * stays quiet after the write.
 */
function screenText(rows: number, mark: string): string {
  let text = `${ESC}[H${ESC}[2J`;
  for (let row = 1; row <= rows; row += 1) {
    text += `${ESC}[${row};1H${ESC}[3${(row % 7) + 1}m${mark} line ${row}${ESC}[0m`;
  }
  text += `${ESC}[1;1H`;
  return text;
}

test("a 0x01 frame on a new connection paints the screen", async () => {
  const stub = server();
  stub.setOnOpen([{ tag: 0x01, text: screenText(20, "dump") }]);

  await withClient(async (page) => {
    await waitFor(() => viewportLine(page, 0), (line) => line === "dump line 1", "row 0");
    expect(await viewportLine(page, 19)).toBe("dump line 20");
    const painted = await waitFor(() => paintedPixels(page, 19), (n) => n > 50, "paint on row 19");
    expect(painted).toBeGreaterThan(50);
  });
});

test("one large 0x01 frame after live output repaints the screen with no other event", async () => {
  // The backpressure case: the server drops the backlog of a slow client and
  // sends one dump. Nothing follows it.
  const stub = server();

  await withClient(async (page) => {
    const { rows } = await size(page);

    // Fill the screen with live output and wait for the canvas to hold it.
    stub.send([{ tag: 0x00, text: screenText(rows, "live") }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "live line 1", "live text");
    await idle(300);

    // The canvas must be quiet before the dump, or a change after the dump
    // proves nothing.
    const before = await canvasSignature(page);
    await idle(300);
    expect(await canvasSignature(page)).toBe(before);

    // One large dump, then silence. The test sends no key, moves no mouse,
    // and resizes nothing. Reading pixels does not schedule a frame.
    const sentAt = Date.now();
    stub.send([{ tag: 0x01, text: screenText(rows, "dump") }]);
    const after = await waitFor(
      () => canvasSignature(page),
      (hash) => hash !== before,
      "a repaint after the dump",
      5000,
    );
    // eslint-disable-next-line no-console
    console.log(`  repaint after the dump: ${Date.now() - sentAt} ms`);
    expect(after).not.toBe(before);

    const text = await viewportText(page);
    expect(text[0]).toBe("dump line 1");
    expect(text[rows - 1]).toBe(`dump line ${rows}`);
    expect(text.some((line) => line.includes("live"))).toBe(false);
    expect(await paintedPixels(page, rows - 1)).toBeGreaterThan(50);
  });
});

test("control: with the paint loop stopped, the same dump leaves a stale screen", async () => {
  // The negative control. It builds the failure of risk 5 on purpose, and so
  // it proves that the test above can see a stale screen. It also shows that
  // parsing and painting are independent: the cells hold the dump while the
  // canvas still holds the old screen.
  const stub = server();

  await withClient(async (page) => {
    const { rows } = await size(page);
    stub.send([{ tag: 0x00, text: screenText(rows, "live") }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "live line 1", "live text");
    await idle(300);
    const before = await canvasSignature(page);

    await stopRenderLoop(page);

    // The count must span the arrival of the dump, never a quiet period. A
    // quiet terminal calls `render` zero times whether the loop runs or not,
    // because `src/render/index.ts` presents the canvas only for a frame that
    // paints. A count taken before the dump therefore reads zero in both
    // cases, and it would not discriminate. The dump makes every row dirty, so
    // a live loop must call `render` inside this window and a stopped loop
    // cannot.
    const counting = countRenders(page, 1500);
    // The wrapper goes on inside `counting`. Give it the task it needs to
    // install itself before the dump arrives.
    await idle(100);

    stub.send([{ tag: 0x01, text: screenText(rows, "dump") }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "dump line 1", "the dump");
    const rendersOverTheDump = await counting;
    // eslint-disable-next-line no-console
    console.log(`  renderer calls while the dump arrived, loop stopped: ${rendersOverTheDump}`);
    expect(rendersOverTheDump).toBe(0);
    await idle(500);

    // The parser has the dump. The canvas does not. This is the stale screen.
    expect(await viewportLine(page, 0)).toBe("dump line 1");
    expect(await canvasSignature(page)).toBe(before);
    // eslint-disable-next-line no-console
    console.log("  control: the parser took the dump and the canvas did not change");
  });
});

test("the paint loop stays alive through a quiet stream", async () => {
  // The mechanism behind the result above. `src/terminal.ts` runs one
  // unconditional `requestAnimationFrame` loop, so a quiet stream still gets
  // frames and a dump cannot wait for another event.
  //
  // This test replaces an assertion that counted more than ten renderer calls
  // in 500 ms of silence. `src/render/index.ts` now presents the canvas only
  // for a frame that paints, because a WebGL canvas that the page presents on
  // every frame starves the timers of the client: it held the animation frame
  // loop at 22 frames per second and halved the key repeat rate of
  // `src/input.ts`. Silence therefore gives zero renderer calls by design, and
  // the old count no longer measures a live loop.
  //
  // The property that risk 5 needs is unchanged, and this test measures it
  // directly: after a quiet period, one write with no other event still
  // reaches the canvas. A dead loop cannot do that.
  const stub = server();
  stub.setOnOpen([{ tag: 0x01, text: screenText(5, "dump") }]);

  await withClient(async (page) => {
    await waitFor(() => viewportLine(page, 0), (line) => line === "dump line 1", "row 0");
    await idle(500);
    const quiet = await canvasSignature(page);

    // One write, and then no further event of any kind. Only the frame loop
    // can carry this to the canvas. The text goes to row 20, which the dump
    // above did not fill, so it lands on a blank row.
    stub.send([{ tag: 0x00, text: `${ESC}[20;1Hlate write` }]);
    await waitFor(() => viewportLine(page, 19), (line) => line === "late write", "the late write");
    const painted = await waitFor(
      () => canvasSignature(page),
      (value) => value !== quiet,
      "the canvas of the late write",
    );
    // eslint-disable-next-line no-console
    console.log(`  the canvas changed after a quiet period: ${quiet} -> ${painted}`);
    expect(painted).not.toBe(quiet);
  });
});
