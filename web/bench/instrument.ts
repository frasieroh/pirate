/**
 * The latency instrument for the browser half of the measurements.
 *
 * A screen event costs three things in the browser: the parse inside
 * `term.write`, the wait for the next animation frame, and the paint itself.
 * This file records all three, in the page, with `performance.now`. A
 * measurement taken from the test process instead would carry the round trip of
 * the browser protocol, which is larger than the values it would report.
 *
 * `../tests/harness.ts` holds the parts that every browser test shares. Nothing
 * in this directory belongs to the functional tests, and nothing there imports
 * from here.
 */

import type { Page } from "playwright";
import { idle } from "../tests/harness";

/** One call, as the instrument records it. */
interface Span {
  start: number;
  end: number;
}

/** The record that the instrument keeps on the page. */
interface LatencyRecord {
  writes: Span[];
  draws: Span[];
}

/** The latency budget of one screen event, in milliseconds. */
export interface Budget {
  /** Bytes of the event. */
  bytes: number;
  /** Time inside `term.write`. This is the parse. */
  parseMs: number;
  /** Time from the end of the parse to the start of the next paint. */
  waitMs: number;
  /** Time inside the paint that follows the parse. */
  drawMs: number;
  /** The three above, added: the whole client-side cost of the event. */
  totalMs: number;
  /** Paints that ran between the parse and the paint that this row reports. */
  drawsBefore: number;
}

/**
 * The globals of the page that the instrument reaches for.
 *
 * `__pirate` is the handle that `main.ts` publishes for the tests, and
 * `__pirateLatency` is the record that this file adds beside it.
 */
type LatencyWindow = {
  __pirate: { term: unknown };
  __pirateLatency?: LatencyRecord;
};

/**
 * Wrap `term.write` and `renderer.draw` so that each call records its span.
 *
 * The wrapped paint call is `draw`, never `render`. `draw` of
 * `src/render/index.ts` holds the paint work: it reads the cells of the dirty
 * rows, it builds the batch, and it presents the canvas. `render` only submits
 * the frame that `draw` already built, and its cost does not follow the cell
 * count. Measurement, in Chromium with `--enable-unsafe-swiftshader`: 69 by 25
 * gave a `draw` median of 0.100 ms and a `render` median of 0.000 ms, 109 by 38
 * gave 0.100 ms and 0.000 ms, and 176 by 58 gave 0.600 ms and 0.000 ms.
 *
 * CAUTION: Do not point this wrapper back at `render`. Every paint span then
 * reads 0.00 ms, and the scaling test of `latency.spec.ts` fails.
 *
 * Call this once per page, before the first measured event.
 */
export function instrument(page: Page): Promise<void> {
  return page.evaluate(() => {
    const scope = globalThis as unknown as LatencyWindow;
    if (scope.__pirateLatency !== undefined) {
      return;
    }
    const record: LatencyRecord = { writes: [], draws: [] };
    scope.__pirateLatency = record;

    const term = scope.__pirate.term as unknown as {
      write(data: Uint8Array): void;
      renderer: { draw(...args: unknown[]): void };
    };
    const write = term.write.bind(term);
    term.write = (data: Uint8Array): void => {
      const start = performance.now();
      write(data);
      record.writes.push({ start, end: performance.now() });
    };

    // `draw` is a method of the prototype, so it needs its receiver.
    const renderer = term.renderer;
    const draw = renderer.draw.bind(renderer);
    renderer.draw = (...args: unknown[]): void => {
      const start = performance.now();
      draw(...args);
      record.draws.push({ start, end: performance.now() });
    };
  });
}

/** Forget every recorded span. Call this before each measured event. */
export function resetTimings(page: Page): Promise<void> {
  return page.evaluate(() => {
    const record = (globalThis as unknown as LatencyWindow).__pirateLatency;
    if (record !== undefined) {
      record.writes = [];
      record.draws = [];
    }
  });
}

/**
 * The budget of the event that the page just took.
 *
 * The parse is every `write` span, added. The paint is the first `draw` span
 * that starts after the last parse ends. A draw that was already running when
 * the bytes arrived cannot hold them, so it does not count.
 */
export async function budget(page: Page, bytes: number): Promise<Budget> {
  const record = await page.evaluate(() => {
    const value = (globalThis as unknown as LatencyWindow).__pirateLatency;
    return value === undefined ? { writes: [], draws: [] } : value;
  });
  if (record.writes.length === 0) {
    throw new Error("the instrument recorded no write");
  }
  const first = record.writes[0];
  const last = record.writes[record.writes.length - 1];
  const parseMs = record.writes.reduce((sum, span) => sum + (span.end - span.start), 0);

  const after = record.draws.filter((span) => span.start >= last.end);
  if (after.length === 0) {
    throw new Error("the instrument recorded no paint after the write");
  }
  const paint = after[0];
  return {
    bytes,
    parseMs,
    waitMs: paint.start - last.end,
    drawMs: paint.end - paint.start,
    totalMs: paint.end - first.start,
    drawsBefore: record.draws.filter(
      (span) => span.start >= first.start && span.start < last.end,
    ).length,
  };
}

/**
 * The median duration of a paint over a quiet period. This is the floor.
 *
 * The frame loop calls `draw` on every animation frame, so a quiet period still
 * records a span for each frame. A quiet `draw` finds no dirty row, so it reads
 * no cell and presents no canvas, and this value is the cost of that check.
 */
export async function idleDrawMs(page: Page, ms: number): Promise<number> {
  await resetTimings(page);
  await idle(ms);
  const record = await page.evaluate(() => {
    const value = (globalThis as unknown as LatencyWindow).__pirateLatency;
    return value === undefined ? { writes: [], draws: [] } : value;
  });
  const times = record.draws.map((span) => span.end - span.start).sort((a, b) => a - b);
  if (times.length === 0) {
    throw new Error("the instrument recorded no paint while the stream was quiet");
  }
  return times[Math.floor(times.length / 2)];
}

/** One recorded PTY byte stream from `crates/pirate-bench/fixtures`. */
export async function fixture(name: string): Promise<Uint8Array> {
  const path = `${import.meta.dir}/../../crates/pirate-bench/fixtures/${name}`;
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/** Split bytes into chunks of `size`, as a PTY read of that size would. */
export function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
  }
  return out;
}
