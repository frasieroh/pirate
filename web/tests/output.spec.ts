/**
 * Output frames: tag `0x00`.
 *
 * The assertions read cells and the cursor from the terminal object.
 */

import { beforeEach, expect, test } from "bun:test";
import {
  cellAt,
  cursor,
  ESC,
  paintedPixels,
  server,
  viewportLine,
  waitFor,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

test("a 0x00 frame writes cells and moves the cursor", async () => {
  const stub = server();
  stub.setOnOpen([{ tag: 0x00, text: "pirate\r\nsecond line\r\n" }]);

  await withClient(async (page) => {
    await waitFor(() => viewportLine(page, 0), (line) => line === "pirate", "row 0");
    expect(await viewportLine(page, 1)).toBe("second line");
    expect(await cursor(page)).toEqual({ x: 0, y: 2 });
  });
});

test("cursor addressing puts the character in the given cell", async () => {
  const stub = server();

  await withClient(async (page) => {
    // CUP counts from 1. Row 5 and column 10 give the 0-based cell (9, 4).
    stub.send([{ tag: 0x00, text: `${ESC}[5;10HX` }]);
    await waitFor(() => cellAt(page, 4, 9), (c) => c === "X", "the cell (9, 4)");
    expect(await cellAt(page, 4, 8)).toBe("");
    expect(await cursor(page)).toEqual({ x: 10, y: 4 });
  });
});

test("the canvas holds paint after an output frame", async () => {
  const stub = server();
  stub.setOnOpen([{ tag: 0x00, text: `${ESC}[32mgreen text${ESC}[0m` }]);

  await withClient(async (page) => {
    await waitFor(() => viewportLine(page, 0), (line) => line === "green text", "row 0");
    // The one coarse pixel measurement. It counts pixels that differ from the
    // background and makes no claim about the shape of any glyph.
    const painted = await waitFor(() => paintedPixels(page, 0), (n) => n > 50, "paint on row 0");
    expect(painted).toBeGreaterThan(50);
  });
});
