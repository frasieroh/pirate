/**
 * Output frames: tag `0x00`.
 *
 * The assertions read cells and the cursor from the terminal object. The
 * query tests at the end of this file read the input frames that the client
 * sent back, because a query answer leaves on the input path.
 */

import { beforeEach, expect, test } from "bun:test";
import {
  cellAt,
  cursor,
  ESC,
  framesWithTag,
  paintedPixels,
  server,
  viewportLine,
  waitFor,
  withClient,
} from "./harness";
import type { Stub } from "./stub-server";

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

// ============================================================================
// Query answers
//
// `src/vt/query.ts` answers the queries that ghostty-vt.wasm 0.4.0 leaves
// open. Without an answer a full-screen program waits for its own timeout,
// which measured 1004 to 1055 ms on the exit from the alternate screen.
//
// The answer goes out on the input path, so these tests read the `0x00`
// frames that the client sent.
// ============================================================================

/** The background of the dark default theme of `src/theme.ts`, as OSC 11. */
const BACKGROUND_ANSWER = `${ESC}]11;rgb:1616/1616/1e1e`;

/** The text of every input frame that the client sent. */
function inputText(stub: Stub): string[] {
  return framesWithTag(stub.received, 0x00).map((frame) =>
    new TextDecoder().decode(frame.subarray(1)),
  );
}

/** Wait until the client sent `count` input frames, then give their text. */
async function waitForInput(stub: Stub, count: number): Promise<string[]> {
  await waitFor(
    async () => inputText(stub).length,
    (got) => got >= count,
    `${count} input frames`,
  );
  // A settle wait. A frame from a second path arrives inside this window.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return inputText(stub);
}

test("a DA1 query gets the VT220 answer on the input path", async () => {
  const stub = server();

  await withClient(async () => {
    stub.send([{ tag: 0x00, text: `${ESC}[c` }]);
    expect(await waitForInput(stub, 1)).toEqual([`${ESC}[?62;22c`]);
  });
});

test("a DA1 query that two frames split gets its answer", async () => {
  const stub = server();

  await withClient(async () => {
    // A server frame can split at any byte. The scanner holds its state
    // across writes.
    stub.send([{ tag: 0x00, text: `${ESC}[` }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inputText(stub)).toEqual([]);
    stub.send([{ tag: 0x00, text: "c" }]);
    expect(await waitForInput(stub, 1)).toEqual([`${ESC}[?62;22c`]);
  });
});

test("the DSR answer of the engine leaves before the DA1 answer", async () => {
  const stub = server();

  await withClient(async () => {
    // The engine answers DSR and the client answers DA1. A real terminal
    // sends the two answers in the order of the two queries.
    stub.send([{ tag: 0x00, text: `${ESC}[6n${ESC}[c` }]);
    const got = await waitForInput(stub, 2);
    expect(got.length).toBe(2);
    expect(got[0]).toMatch(/^\x1b\[\d+;\d+R$/);
    expect(got[1]).toBe(`${ESC}[?62;22c`);
  });
});

test("an OSC 11 query answers with the background of the theme", async () => {
  const stub = server();

  await withClient(async () => {
    stub.send([{ tag: 0x00, text: `${ESC}]11;?${ESC}\\` }]);
    expect(await waitForInput(stub, 1)).toEqual([`${BACKGROUND_ANSWER}${ESC}\\`]);
  });
});

test("a DECRQM query reports the state of the mode", async () => {
  const stub = server();

  await withClient(async () => {
    // Mode 2004 is bracketed paste, which `src/input.ts:231` honors. It is
    // off in a new terminal, so the answer is 2, "reset". The same query
    // after the set reports 1.
    stub.send([{ tag: 0x00, text: `${ESC}[?2004$p` }]);
    expect(await waitForInput(stub, 1)).toEqual([`${ESC}[?2004;2$y`]);
    stub.send([{ tag: 0x00, text: `${ESC}[?2004h${ESC}[?2004$p` }]);
    expect(await waitForInput(stub, 2)).toEqual([
      `${ESC}[?2004;2$y`,
      `${ESC}[?2004;1$y`,
    ]);
  });
});

test("a query that no answer covers gets none", async () => {
  const stub = server();

  await withClient(async (page) => {
    // DA2. `src/vt/query.ts` holds the evidence for that decision.
    stub.send([{ tag: 0x00, text: `${ESC}[>cpirate` }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "pirate", "row 0");
    expect(inputText(stub)).toEqual([]);
  });
});

test("the ESC of a query ends a DCS body, and the query gets its answer", async () => {
  const stub = server();

  await withClient(async (page) => {
    // The parser of the engine ends the DCS at the ESC and dispatches the
    // DA1 that comes after it. `tests/query-parity.spec.ts` measures that.
    stub.send([{ tag: 0x00, text: `${ESC}Pdata${ESC}[c${ESC}\\pirate` }]);
    await waitFor(() => viewportLine(page, 0), (line) => line === "pirate", "row 0");
    expect(await waitForInput(stub, 1)).toEqual([`${ESC}[?62;22c`]);
  });
});
