/**
 * The settle latency of a resize storm.
 *
 * A window drag and a tmux pane drag both give the same input: a burst of size
 * changes over about half a second, against a program that repaints the whole
 * screen for each SIGWINCH. This file reproduces that burst and reports where
 * the time goes.
 *
 * The drive is `page.setViewportSize`, one call per step. Each step changes the
 * cell count, so each step is a size change that the client must answer. The
 * stub answers every `0x01` resize frame with a full-screen redraw built for
 * the size in that frame. A recorded fixture cannot do this, because a fixture
 * holds one size and a redraw follows the size.
 *
 * CAUTION: `trip` measures this harness, not the pirate server. The stub
 * answers the resize frame at once, and the answer that follows an inbound
 * frame that closely waits about 40 ms on the loopback socket. Measurement,
 * same page and same bytes: a reply sent 200 ms after the last client frame
 * arrives 1.0 ms after the send, a reply sent at once arrives 65 ms after it,
 * and a reply held for 60 ms arrives 12 ms after it. Read the `local` column,
 * which is the settle without the trip, for the cost of the client. The
 * `crates/pirate-bench` report holds the trip of the real server.
 *
 * The stages of one storm, in order:
 *
 * - `debounce` is the last size change to the `fit` that follows it.
 *   `RESIZE_DEBOUNCE_MS` of `src/main.ts` holds this wait at 100 ms.
 * - `fit` is `fit` of the renderer, plus the resize of the VT and of the grid.
 * - `trip` is the resize frame to the first byte of the redraw that answers it.
 * - `output` is the first byte of the redraw to the last byte of it, and
 *   `parse` is the part of it that ran inside the wasm VT.
 * - `wait` is the last byte to the start of the paint, one frame at most.
 * - `draw` is that paint.
 *
 * The six add up to `settle`, the time from the last size change of the drag to
 * the paint that shows the new size.
 *
 * This file asserts no time. A threshold on a duration fails on a busy
 * machine, and CI must never fail on a latency number. The assertions cover
 * behavior alone: the client paints after the drag, and the size that it sent
 * is the size of the viewport.
 */

import { expect, test } from "bun:test";
import { idle, server, size, withClient } from "../tests/harness";
import type { Stub } from "../tests/stub-server";
import {
  instrument,
  resetTimings,
  stormBudget,
  type StormBudget,
  timeOrigin,
} from "./instrument";
import type { Page } from "playwright";

/** Storms per scenario. The report gives the median and the p95 of these. */
const REPEATS = 7;

/** Size changes in one drag. */
const STEPS = 12;

/**
 * The debounce of the client, in milliseconds.
 *
 * This is a copy of `RESIZE_DEBOUNCE_MS` of `src/main.ts`. The bench holds its
 * own copy, because the bench must fail when the product value changes under
 * it without a new measurement.
 */
const RESIZE_DEBOUNCE_MS = 100;

/**
 * Milliseconds between two steps of a fast drag.
 *
 * A drag of the window frame gives one size change per frame of the display,
 * which is 16 ms at 60 Hz. `setViewportSize` costs more than that, so 40 ms is
 * the shortest step that this harness holds. The value is less than the
 * debounce, which is the case that matters.
 */
const FAST_STEP_MS = 40;

/**
 * Milliseconds between two steps of a slow drag.
 *
 * The value is more than the debounce, so each step reaches the server. This
 * is the drag of an operator that moves the mouse in small pushes.
 */
const SLOW_STEP_MS = 160;

/** The viewport that each drag starts from. */
const START = { width: 1200, height: 760 };

/** Pixels that one step takes off the width and off the height. */
const STEP_WIDTH = 24;
const STEP_HEIGHT = 16;

/** Quiet time after a drag, for the debounce, the round trip, and the paint. */
const SETTLE_MS = 600;

/**
 * Milliseconds between two polls of the stub for a new resize frame.
 *
 * The stub gives no callback, so the responder polls. The poll adds its own
 * wait to `trip`, and the report names that bias.
 */
const POLL_MS = 2;

/** The median of a list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The 95th percentile by nearest rank. With 7 samples this is the largest. */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * A full-screen redraw for a terminal of `cols` by `rows`.
 *
 * vim, tmux, and less all answer SIGWINCH this way: a clear, then every row,
 * then the cursor. The byte count follows the new size, as it does for a real
 * program.
 */
function sigwinchRedraw(cols: number, rows: number): Uint8Array {
  let text = "\x1b[H\x1b[2J";
  for (let row = 1; row <= rows; row += 1) {
    const line = `${row} redraw of ${cols} columns `.repeat(cols).slice(0, cols);
    text += `\x1b[${row};1H\x1b[3${(row % 7) + 1}m${line}\x1b[0m`;
  }
  text += `\x1b[${rows};1H`;
  return new TextEncoder().encode(text);
}

/**
 * A redraw of one row, for the control run.
 *
 * The bytes of the answer are the only difference against `sigwinchRedraw`.
 * The control therefore reports what the byte count of the redraw costs, and
 * what the transport of the harness costs below that count.
 */
function oneRowRedraw(cols: number, rows: number): Uint8Array {
  return new TextEncoder().encode(`\x1b[${rows};1H\x1b[32m${"row ".repeat(cols).slice(0, 40)}\x1b[0m`);
}

/** What the responder sent while one storm ran. */
interface Replies {
  /** Redraws that the responder sent. */
  count: number;
  /** Bytes of those redraws. */
  bytes: number;
  /** Bytes of the last redraw. */
  lastBytes: number;
  /** `Date.now` of the test process when it sent the last redraw. */
  lastAt: number;
}

/**
 * Answer every `0x01` resize frame with a redraw of the new size.
 *
 * The returned function stops the responder. The caller resets `replies`
 * before each measured storm.
 */
function respondToResizes(
  stub: Stub,
  replies: Replies,
  build: (cols: number, rows: number) => Uint8Array,
): () => void {
  let seen = 0;
  const timer = setInterval(() => {
    const frames = stub.received;
    for (; seen < frames.length; seen += 1) {
      const frame = frames[seen];
      if (frame.length !== 5 || frame[0] !== 0x01) {
        continue;
      }
      const bytes = build((frame[1] << 8) | frame[2], (frame[3] << 8) | frame[4]);
      if (!stub.open) {
        continue;
      }
      stub.send([{ tag: 0x00, bytes }]);
      replies.count += 1;
      replies.bytes += bytes.length;
      replies.lastBytes = bytes.length;
      replies.lastAt = Date.now();
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}

/**
 * Run one drag and give back its budget.
 *
 * The viewport goes back to the start size first. The wait after that keeps the
 * paint of the start size out of the measurement.
 */
async function storm(page: Page, replies: Replies, stepMs: number): Promise<StormBudget> {
  await page.setViewportSize(START);
  await idle(SETTLE_MS);
  replies.count = 0;
  replies.bytes = 0;
  replies.lastBytes = 0;
  replies.lastAt = 0;
  await resetTimings(page);

  for (let step = 1; step <= STEPS; step += 1) {
    const at = Date.now();
    await page.setViewportSize({
      width: START.width - step * STEP_WIDTH,
      height: START.height - step * STEP_HEIGHT,
    });
    const left = stepMs - (Date.now() - at);
    if (left > 0) {
      await idle(left);
    }
  }
  await idle(SETTLE_MS);

  return stormBudget(page, replies.lastBytes);
}

/** Two rows of the report: the median and the p95 of one scenario. */
function report(name: string, samples: StormBudget[], redraws: number[], bytes: number[]): void {
  const row = (label: string, pick: (values: number[]) => number): void => {
    const of = (get: (b: StormBudget) => number): string =>
      pick(samples.map(get)).toFixed(1).padStart(7);
    // eslint-disable-next-line no-console
    console.log(
      `  ${label.padEnd(28)}` +
        `debounce ${of((b) => b.debounceMs)} ms  ` +
        `fit ${of((b) => b.fitMs)} ms  ` +
        `trip ${of((b) => b.roundTripMs)} ms  ` +
        `output ${of((b) => b.outputMs)} ms  ` +
        `parse ${of((b) => b.parseMs)} ms  ` +
        `wait ${of((b) => b.waitMs)} ms  ` +
        `stall ${of((b) => b.stallMs)} ms  ` +
        `draw ${of((b) => b.drawMs)} ms  ` +
        `settle ${of((b) => b.settleMs)} ms  ` +
        // The settle without the trip. The trip of this harness is not the
        // trip of the server, so this column is the client-side cost alone.
        `local ${of((b) => b.settleMs - b.roundTripMs)} ms`,
    );
  };
  row(`${name} median`, median);
  row(`${name} p95`, p95);
  const last = samples[samples.length - 1];
  // eslint-disable-next-line no-console
  console.log(
    `  ${`${name} counts`.padEnd(28)}` +
      `size changes ${String(median(samples.map((b) => b.resizeEvents))).padStart(3)}  ` +
      `resize frames sent ${String(median(samples.map((b) => b.resizeFrames))).padStart(3)}  ` +
      `redraws ${String(median(redraws)).padStart(3)}  ` +
      `bytes ${String(median(bytes)).padStart(7)}  ` +
      `paints ${String(median(samples.map((b) => b.paints))).padStart(3)}  ` +
      `paints before the fit ${String(median(samples.map((b) => b.paintsDuringWait))).padStart(3)}  ` +
      `frames during the trip ${String(median(samples.map((b) => b.tripFrames))).padStart(3)}  ` +
      `final ${last.cols}x${last.rows}`,
  );
}

/**
 * Split the round trip at the stub.
 *
 * `up` is the resize frame of the page to the answer of the stub. It holds the
 * wire time to the stub and the poll wait of the responder. `down` is that
 * answer to the arrival of it in the page. Both come from the same wall clock:
 * `timeOrigin` of the page plus a time of `StormBudget` gives a `Date.now`.
 */
function wireReport(name: string, ups: number[], downs: number[]): void {
  // eslint-disable-next-line no-console
  console.log(
    `  ${`${name} trip`.padEnd(28)}` +
      `up ${median(ups).toFixed(1).padStart(6)} ms (p95 ${p95(ups).toFixed(1)})  ` +
      `down ${median(downs).toFixed(1).padStart(6)} ms (p95 ${p95(downs).toFixed(1)})\n`,
  );
}

test("a resize storm settles one debounce after the drag stops", async () => {
  const stub = server();
  stub.reset();
  const replies: Replies = { count: 0, bytes: 0, lastBytes: 0, lastAt: 0 };

  await withClient(
    async (page) => {
      await instrument(page);
      const origin = await timeOrigin(page);

      for (const drag of [
        { name: "fast drag 40 ms", stepMs: FAST_STEP_MS, redraw: sigwinchRedraw },
        { name: "slow drag 160 ms", stepMs: SLOW_STEP_MS, redraw: sigwinchRedraw },
        // The control. The drag is the fast one, and the answer of the server
        // is one row instead of a screen.
        { name: "fast drag, 1 row", stepMs: FAST_STEP_MS, redraw: oneRowRedraw },
      ]) {
        const stop = respondToResizes(stub, replies, drag.redraw);
        try {
          const samples: StormBudget[] = [];
          const counts: number[] = [];
          const bytes: number[] = [];
          const ups: number[] = [];
          const downs: number[] = [];
          for (let run = 0; run < REPEATS; run += 1) {
            const budget = await storm(page, replies, drag.stepMs);
            samples.push(budget);
            counts.push(replies.count);
            bytes.push(replies.bytes);
            ups.push(replies.lastAt - (origin + budget.sendAt));
            downs.push(origin + budget.arrivalAt - replies.lastAt);
          }
          report(drag.name, samples, counts, bytes);
          wireReport(drag.name, ups, downs);

          // The size that the client sent last is the size that the terminal
          // holds now. A drag that ends on a stale size is a defect.
          const last = samples[samples.length - 1];
          const now = await size(page);
          expect({ cols: last.cols, rows: last.rows }).toEqual(now);

          // Every storm reached a paint. `stormBudget` throws when it finds
          // none, so a full sample list is that proof.
          expect(samples.length).toBe(REPEATS);

          if (drag.stepMs < RESIZE_DEBOUNCE_MS) {
            // The debounce swallows the drag. One drag of 12 size changes
            // gives far fewer frames than 12.
            expect(median(samples.map((b) => b.resizeFrames))).toBeLessThan(STEPS);
            // Nothing paints while the debounce waits. The canvas holds the
            // grid of the old size for the whole drag.
            expect(median(samples.map((b) => b.paintsDuringWait))).toBe(0);
          } else {
            // A step that is longer than the debounce reaches the server.
            expect(median(samples.map((b) => b.resizeFrames))).toBeGreaterThan(1);
          }
        } finally {
          stop();
        }
      }
    },
    { viewport: START },
  );
}, 600_000);

test("the alternate screen does not change the settle of a resize storm", async () => {
  // Hypothesis 3 says that the alternate screen holds the time. The two runs
  // below take the same drag, the same redraws, and the same instrument. The
  // only difference is the buffer that the client paints into.
  const stub = server();
  stub.reset();
  const replies: Replies = { count: 0, bytes: 0, lastBytes: 0, lastAt: 0 };
  const stop = respondToResizes(stub, replies, sigwinchRedraw);

  const settles: Record<string, number> = {};
  try {
    for (const screen of ["normal", "alternate"]) {
      await withClient(
        async (page) => {
          await instrument(page);
          if (screen === "alternate") {
            // `ESC [ ? 1049 h` enters the alternate screen, as vim does.
            stub.send([{ tag: 0x00, bytes: new TextEncoder().encode("\x1b[?1049h") }]);
            await idle(200);
          }

          const samples: StormBudget[] = [];
          const counts: number[] = [];
          const bytes: number[] = [];
          for (let run = 0; run < REPEATS; run += 1) {
            samples.push(await storm(page, replies, FAST_STEP_MS));
            counts.push(replies.count);
            bytes.push(replies.bytes);
          }
          report(`${screen} screen`, samples, counts, bytes);
          // The comparison takes the settle without the trip. The trip of this
          // harness holds tens of milliseconds that belong to no client.
          settles[screen] = median(samples.map((b) => b.settleMs - b.roundTripMs));

          const last = samples[samples.length - 1];
          const now = await size(page);
          expect({ cols: last.cols, rows: last.rows }).toEqual(now);
        },
        { viewport: START },
      );
    }
  } finally {
    stop();
  }

  // eslint-disable-next-line no-console
  console.log(
    `  alternate minus normal: ${(settles.alternate - settles.normal).toFixed(1)} ms ` +
      `of settle without the trip\n`,
  );
  expect(Object.keys(settles).length).toBe(2);
}, 600_000);
