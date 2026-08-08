/**
 * The client-side latency budget of one screen event.
 *
 * Each fixture is a byte stream that `examples/record_fixtures.rs` recorded
 * from a real PTY of 200 columns and 50 rows. The stub sends those exact bytes,
 * and the instrument in `harness.ts` reports where the time went:
 *
 * - `parse` is the time inside `term.write`, which is the WebAssembly parser.
 * - `wait` is the time from the end of the parse to the start of the next paint.
 *   The paint loop of `src/terminal.ts` runs on `requestAnimationFrame`, so this
 *   value is one frame of the display at most.
 * - `draw` is the time inside that paint, which is `draw` of
 *   `src/render/index.ts`.
 *
 * These tests print a table and assert loose bounds only. A tight assertion on
 * a time is a flaky assertion, because the machine that runs it varies. The
 * numbers are the product; the assertions guard against a change of an order of
 * magnitude.
 */

import { expect, test } from "bun:test";
import { canvasSignature, idle, server, size, waitFor, withClient } from "../tests/harness";
import type { Stub } from "../tests/stub-server";
import {
  budget,
  type Budget,
  chunked,
  fixture,
  idleDrawMs,
  instrument,
  resetTimings,
} from "./instrument";
import type { Page } from "playwright";

/** Measurements per scenario. The report gives the median of these. */
const REPEATS = 5;

/** Frames of quiet that a small event gets before the instrument is read. */
const SETTLE_MS = 120;

/**
 * Bytes per WebSocket message that the server sent before the join.
 *
 * `session.rs` asks the PTY for 8192 bytes. `examples/bench_server.rs` measures
 * what a PTY gives back, and the answer is about 1024. One message per read was
 * therefore one message per 1024 bytes on the wire.
 */
const READ_SIZE = 1024;

/**
 * Bytes per WebSocket message that the server sends today.
 *
 * The terminal thread and the pump each join the output that their queue
 * already holds. `examples/bench_server.rs` replays `flood.bin` through a real
 * PTY and a real socket, and it reports about 57 KB per message.
 */
const SERVER_MESSAGE = 57 * 1024;

/** The median of a list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One row of the report. */
function report(name: string, samples: Budget[]): void {
  const of = (pick: (b: Budget) => number): string => median(samples.map(pick)).toFixed(2);
  // eslint-disable-next-line no-console
  console.log(
    `  ${name.padEnd(22)} ${String(samples[0].bytes).padStart(9)} B  ` +
      `parse ${of((b) => b.parseMs).padStart(7)} ms  ` +
      `wait ${of((b) => b.waitMs).padStart(6)} ms  ` +
      `draw ${of((b) => b.drawMs).padStart(7)} ms  ` +
      `total ${of((b) => b.totalMs).padStart(7)} ms  ` +
      // The paints that ran while the bytes were still arriving. Each one costs
      // a full `draw`, so this column says where the rest of `total` went.
      `paints ${of((b) => b.drawsBefore).padStart(6)}`,
  );
}

/**
 * Run one event and give back its budget.
 *
 * `before` puts the client into the state that the event starts from. The wait
 * after it keeps the paint of that state out of the measurement.
 */
async function sample(
  page: Page,
  stub: Stub,
  before: () => void,
  event: Uint8Array[],
  settleMs = SETTLE_MS,
): Promise<Budget> {
  before();
  await idle(SETTLE_MS);
  await resetTimings(page);

  stub.send(event.map((bytes) => ({ tag: 0x00, bytes })));
  await idle(settleMs);

  return budget(
    page,
    event.reduce((sum, chunk) => sum + chunk.length, 0),
  );
}

/** A screen of text, so that a clear has something to erase. */
function filledScreen(rows: number): Uint8Array {
  let text = "\x1b[H\x1b[2J";
  for (let row = 1; row <= rows; row += 1) {
    text += `\x1b[${row};1H\x1b[3${(row % 7) + 1}mrow ${row} of the screen before the event\x1b[0m`;
  }
  return new TextEncoder().encode(text);
}

test("the client-side latency budget of each recorded screen event", async () => {
  const stub = server();
  stub.reset();

  const clear = await fixture("clear.bin");
  const vimOpen = await fixture("vim-open.bin");
  const vimExit = await fixture("vim-exit.bin");

  await withClient(async (page) => {
    await instrument(page);
    const { rows } = await size(page);
    const filled = filledScreen(rows);

    // The floor. `draw` runs every animation frame whether the screen changed
    // or not, so no event can cost less than this. A `draw` that finds no
    // change returns after the check, so the floor is that check.
    const floor = await idleDrawMs(page, 500);
    // eslint-disable-next-line no-console
    console.log(`\n  paint of a screen that did not change: ${floor.toFixed(2)} ms (the floor)\n`);

    // 1. A screen clear. Few bytes, and every cell of the viewport changes.
    const clears: Budget[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      clears.push(await sample(page, stub, () => stub.send([{ tag: 0x00, bytes: filled }]), [clear]));
    }
    report("clear", clears);

    // 2. vim starts: the alternate screen, and a full screen of text.
    const opens: Budget[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      opens.push(
        await sample(page, stub, () => stub.send([{ tag: 0x00, bytes: filled }]), [vimOpen]),
      );
    }
    report("vim opens", opens);

    // 3. vim ends: the client leaves the alternate screen and the screen behind
    //    it comes back. This is the event that the report is about.
    const exits: Budget[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      exits.push(
        await sample(
          page,
          stub,
          () => stub.send([{ tag: 0x00, bytes: filled }, { tag: 0x00, bytes: vimOpen }]),
          [vimExit],
        ),
      );
    }
    report("vim exits", exits);

    // Every event above must still paint. A budget with no paint throws in
    // `budget`, so reaching this line proves that all three painted.
    expect(clears.length).toBe(REPEATS);
    expect(median(exits.map((b) => b.totalMs))).toBeLessThan(1000);
    expect(median(clears.map((b) => b.totalMs))).toBeLessThan(1000);
  });
}, 120_000);

test("the message count of a flood costs more than the bytes of it", async () => {
  // The same bytes, at four message sizes. The bytes and the parse are the
  // same in all four, so the difference is the price of the message count
  // alone. The first size is what the server sent before the join, and the
  // third is what it sends today.
  const stub = server();
  stub.reset();

  const flood = await fixture("flood.bin");
  const sizes = [READ_SIZE, 8192, SERVER_MESSAGE, flood.length];

  await withClient(async (page) => {
    await instrument(page);

    const totals: number[] = [];
    for (const size of sizes) {
      const chunks = chunked(flood, size);
      const samples: Budget[] = [];
      for (let run = 0; run < 3; run += 1) {
        samples.push(await sample(page, stub, () => {}, chunks, 2500));
      }
      report(`flood in ${chunks.length} messages`, samples);
      totals.push(median(samples.map((b) => b.totalMs)));
    }

    // One message is the floor: the same bytes, parsed once. Every split above
    // it pays for its messages. This is the measurement that a change to the
    // server has to beat.
    expect(totals[totals.length - 1]).toBeLessThan(totals[0]);
    expect(await canvasSignature(page)).not.toBe(-1);
  });
}, 240_000);

test("the paint of a screen event scales with the cells on the screen", async () => {
  // A screen clear is 26 bytes at every size, so the bytes cannot explain the
  // paint. This test holds the bytes fixed and changes the cell count. A cost
  // that grows with the cells is a full repaint of the viewport, and the size
  // of the window is then the only lever the client has.
  const clear = await fixture("clear.bin");

  for (const viewport of [
    { width: 640, height: 400 },
    { width: 1000, height: 600 },
    { width: 1600, height: 900 },
  ]) {
    const stub = server();
    stub.reset();

    await withClient(
      async (page) => {
        await instrument(page);
        const { cols, rows } = await size(page);
        const filled = filledScreen(rows);

        const samples: Budget[] = [];
        for (let run = 0; run < REPEATS; run += 1) {
          samples.push(
            await sample(page, stub, () => stub.send([{ tag: 0x00, bytes: filled }]), [clear]),
          );
        }
        const paint = median(samples.map((b) => b.drawMs));
        // eslint-disable-next-line no-console
        console.log(
          `  ${`${cols}x${rows}`.padEnd(10)} ${String(cols * rows).padStart(6)} cells  ` +
            `draw ${paint.toFixed(2).padStart(6)} ms  ` +
            `${((paint * 1000) / (cols * rows)).toFixed(3)} us per cell`,
        );
        expect(paint).toBeGreaterThan(0);
      },
      { viewport },
    );
  }
}, 180_000);

test("a state dump costs what its bytes cost", async () => {
  // The server sends a dump when a socket opens and after it drops a backlog.
  // A dump of a full screen is far more bytes than the event that made it, so
  // its parse is the part to measure.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await instrument(page);
    const { rows } = await size(page);
    const filled = filledScreen(rows);

    const samples: Budget[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await resetTimings(page);
      stub.send([{ tag: 0x01, bytes: filled }]);
      await idle(SETTLE_MS);
      samples.push(await budget(page, filled.length));
    }
    report("dump of one screen", samples);

    await waitFor(
      () => canvasSignature(page),
      (hash) => hash !== -1,
      "a canvas to read",
    );
    expect(samples.length).toBe(REPEATS);
  });
}, 120_000);
