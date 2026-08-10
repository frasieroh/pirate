/**
 * The cost of the exit from the alternate screen.
 *
 * The report calls this symptom 2: a full-screen program ends, a shell full of
 * content sits behind it, and the primary screen comes back late.
 *
 * Two byte streams can bring that screen back, and this file measures both:
 *
 * - The plain output path. The program sends `ESC [ ? 1049 l`, and the VT
 *   engine of the browser holds the primary screen already. The server sends
 *   those bytes as a `0x00` frame.
 * - The dump path. The server sends a `0x01` frame that starts with
 *   `LEAVE_ALTERNATE` and carries every cell of the primary screen again.
 *   `crates/pirate/src/terminal.rs` builds that frame for a new socket and
 *   after a queue overflow.
 *
 * Each measurement splits the event into these parts. The four time stages add
 * up to `total`:
 *
 * - `bytes` and `msgs` are what the socket carried.
 * - `arrive` is the time between the first byte and the last byte, less the
 *   parse. It is the transport and the event loop.
 * - `parse` is the time inside `term.write`, which is the WebAssembly parser.
 * - `wait` is the time from the end of the parse to the start of the paint.
 *   The loop of `src/terminal.ts` paints on `requestAnimationFrame`, so this
 *   value is one frame of the display at most.
 * - `draw` is the time inside `draw` of `src/render/index.ts`.
 *
 * The paint that this file reports is the paint that shows the primary screen:
 * the first paint after the last byte that wrote a row while the VT engine was
 * off the alternate screen. `rows` is `lastDrawnRows` of that paint.
 *
 * These tests print a table and assert correctness only. No assertion reads a
 * duration. A tight assertion on a time is a flaky assertion, because the
 * machine that runs it varies. The numbers are the product.
 */

import { expect, test } from "bun:test";
import { idle, server, size, viewportText, withClient } from "../tests/harness";
import type { Stub } from "../tests/stub-server";
import { chunked, fixture } from "./instrument";
import type { Page } from "playwright";

/** Measurements per scenario. The report gives the median and the p95. */
const REPEATS = 9;

/** Frames of quiet that one event gets before the instrument is read. */
const SETTLE_MS = 250;

/**
 * Bytes per WebSocket message of the split dump.
 *
 * `session.rs` asks the PTY for 8192 bytes, and a PTY gives back about 1024.
 * This size is therefore one message per PTY read, the split that the server
 * produced before it joined its queue.
 */
const READ_SIZE = 1024;

/**
 * Screens of content in the large dump.
 *
 * `SCROLLBACK` of `crates/pirate/src/terminal.rs` keeps lines behind the
 * viewport. This count gives a frame of 45219 bytes at 109 by 38 cells, which
 * is 3.8 times the dump of one screen. The report prints both byte counts.
 *
 * The content is one screen, written eight times over the same rows. The frame
 * therefore carries the byte volume of a scrollback dump, not its row count.
 */
const SCROLLBACK_SCREENS = 8;

/** The prefix that `terminal.rs` puts before a dump of the primary screen. */
const LEAVE_ALTERNATE = "\x1b[?1049l\x1b[H\x1b[2J";

/** The prefix that `terminal.rs` puts before a dump of the alternate screen. */
const ENTER_ALTERNATE = "\x1b[?1049h\x1b[H\x1b[2J";

const encoder = new TextEncoder();

/** One paint, as the page recorded it. */
interface Paint {
  start: number;
  end: number;
  /** The count of rows that this paint wrote. `lastDrawnRows` of the renderer. */
  rows: number;
  /** True when the VT engine was on the alternate screen at this paint. */
  alternate: boolean;
}

/**
 * The record that this file keeps on the page.
 *
 * The name is not `Record`. TypeScript gives that name to a utility type.
 */
interface Trace {
  writes: { start: number; end: number }[];
  paints: Paint[];
}

/** The VT engine, as this file uses it. */
interface Vt {
  isAlternateScreen(): boolean;
}

/**
 * The globals that this file reaches for. `main.ts` publishes `__pirate`.
 *
 * `__pirateVt` is the VT engine. The bridge of `main.ts` does not publish it,
 * and `draw` takes it as its first argument, so the paint wrapper below keeps
 * the handle that it receives.
 */
type BenchWindow = {
  __pirate: { term: unknown };
  __pirateAlt?: Trace;
  __pirateVt?: Vt;
};

/** One row of the report. */
interface Restore {
  bytes: number;
  msgs: number;
  arriveMs: number;
  parseMs: number;
  waitMs: number;
  drawMs: number;
  totalMs: number;
  /** Paints between the first byte and the paint that shows the screen. */
  paints: number;
  /** Rows that the paint which shows the primary screen wrote. */
  rows: number;
}

/**
 * Wrap `term.write` and `renderer.draw` so that each call records its span.
 *
 * This wrapper keeps the row count and the screen of each paint, which
 * `instrument.ts` does not hold. The paint call is `draw`, never `render`, for
 * the reason that `instrument.ts` states.
 *
 * Call this once per page, before the first measured event.
 */
function watch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const scope = globalThis as unknown as BenchWindow;
    if (scope.__pirateAlt !== undefined) {
      return;
    }
    const record: Trace = { writes: [], paints: [] };
    scope.__pirateAlt = record;

    const term = scope.__pirate.term as unknown as {
      write(data: Uint8Array): void;
      renderer: { draw(...args: unknown[]): void; lastDrawnRows: readonly number[] };
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
      const vt = args[0] as Vt;
      scope.__pirateVt = vt;
      const start = performance.now();
      draw(...args);
      const end = performance.now();
      // The two reads come after the span. A read inside the span would add
      // its own cost to the paint.
      record.paints.push({
        start,
        end,
        rows: renderer.lastDrawnRows.length,
        alternate: vt.isAlternateScreen(),
      });
    };
  });
}

/** Forget every recorded span. */
function resetWatch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const record = (globalThis as unknown as BenchWindow).__pirateAlt;
    if (record !== undefined) {
      record.writes = [];
      record.paints = [];
    }
  });
}

/** Read the record of the page. */
function readWatch(page: Page): Promise<Trace> {
  return page.evaluate(() => {
    const value = (globalThis as unknown as BenchWindow).__pirateAlt;
    return value === undefined ? { writes: [], paints: [] } : value;
  });
}

/** The count of viewport rows that carry shell content. */
function shellRows(lines: string[]): number {
  return lines.filter((line) => /^shell row \d{3}/.test(line)).length;
}

/** The median of a list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The p95 of a list of numbers, by the nearest rank. */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/** Print the median row and the p95 row of one scenario. */
function report(name: string, samples: Restore[]): void {
  const line = (label: string, pick: (values: number[]) => number): string => {
    const of = (get: (r: Restore) => number): string =>
      pick(samples.map(get)).toFixed(2).padStart(7);
    return (
      `  ${name.padEnd(26)} ${label.padEnd(7)} ` +
      `${String(samples[0].bytes).padStart(7)} B in ${String(samples[0].msgs).padStart(3)} msg  ` +
      `arrive ${of((r) => r.arriveMs)} ms  ` +
      `parse ${of((r) => r.parseMs)} ms  ` +
      `wait ${of((r) => r.waitMs)} ms  ` +
      `draw ${of((r) => r.drawMs)} ms  ` +
      `total ${of((r) => r.totalMs)} ms  ` +
      `paints ${of((r) => r.paints)}  ` +
      `rows ${of((r) => r.rows)}`
    );
  };
  // eslint-disable-next-line no-console
  console.log(line("median", median));
  // eslint-disable-next-line no-console
  console.log(line("p95", p95));
}

/**
 * The stages of one restore, from the record of the page.
 *
 * The paint that shows the primary screen is the first paint that starts after
 * the last byte, that wrote at least one row, and that ran while the VT engine
 * was off the alternate screen. A paint that was already running when the
 * bytes arrived cannot hold them, and a paint that wrote no row shows nothing
 * new.
 */
function stages(record: Trace, bytes: number, msgs: number): Restore {
  if (record.writes.length === 0) {
    throw new Error("the instrument recorded no write");
  }
  const first = record.writes[0];
  const last = record.writes[record.writes.length - 1];
  const parseMs = record.writes.reduce((sum, span) => sum + (span.end - span.start), 0);

  const paint = record.paints.find(
    (span) => span.start >= last.end && span.rows > 0 && !span.alternate,
  );
  if (paint === undefined) {
    throw new Error("the instrument recorded no paint of the primary screen");
  }
  return {
    bytes,
    msgs,
    arriveMs: last.end - first.start - parseMs,
    parseMs,
    waitMs: paint.start - last.end,
    drawMs: paint.end - paint.start,
    totalMs: paint.end - first.start,
    paints: record.paints.filter((span) => span.start >= first.start && span.start < paint.start)
      .length,
    rows: paint.rows,
  };
}

/**
 * The cells of a full screen of shell content, one styled run per row.
 *
 * This is the content that sits behind the program. Each row carries a marker,
 * and the correctness assertions count those markers.
 */
function shellCells(cols: number, rows: number): string {
  let text = "";
  for (let row = 1; row <= rows; row += 1) {
    const label = `shell row ${String(row).padStart(3, "0")} `;
    const fill = "-".repeat(Math.max(0, cols - label.length));
    text += `\x1b[${row};1H\x1b[3${(row % 7) + 1}m${label}${fill}\x1b[0m`;
  }
  return text;
}

/** A full primary screen, from a clear. */
function primaryScreen(cols: number, rows: number): string {
  return `\x1b[?1049l\x1b[H\x1b[2J${shellCells(cols, rows)}`;
}

/**
 * A full-screen program on the alternate screen.
 *
 * Every cell of the alternate screen carries a glyph, as a full-screen text
 * program paints it.
 */
function alternateScreen(cols: number, rows: number): string {
  let text = ENTER_ALTERNATE;
  for (let row = 1; row <= rows; row += 1) {
    const label = ` tui ${String(row).padStart(3, "0")} `;
    const fill = "#".repeat(Math.max(0, cols - label.length));
    text += `\x1b[${row};1H\x1b[7m${label}${fill}\x1b[0m`;
  }
  return text;
}

/**
 * A model of the `0x01` dump that `terminal.rs` builds for a primary screen.
 *
 * The Rust formatter runs with every option on, so the frame carries the
 * palette, the modes, the scrolling region, the tabstops, one styled run per
 * cell group, and a trailing CUP. This function writes the same parts in the
 * same order. It is a model, not a recording: no fixture of a dump exists, and
 * this file adds none.
 *
 * The model carries the byte volume of the real frame. Measurement, against
 * `ScreenTerminal::dump` of the Rust crate on a screen of the same shape: the
 * real dump is 10516 bytes at 109 by 38 cells and 16690 bytes at 200 by 50,
 * and this model gives 12032 bytes at 109 by 38.
 *
 * `prefix` is `LEAVE_ALTERNATE` for a primary dump and `ENTER_ALTERNATE` for a
 * dump taken while a program holds the alternate screen.
 */
function dumpFrame(prefix: string, cols: number, rows: number, content: string): Uint8Array {
  let text = prefix;
  // The palette: 256 indexed colors, then the foreground, the background, and
  // the cursor color.
  for (let index = 0; index < 256; index += 1) {
    const value = (index * 7) & 0xff;
    const pair = value.toString(16).padStart(2, "0");
    text += `\x1b]4;${index};rgb:${pair}${pair}/${pair}${pair}/${pair}${pair}\x1b\\`;
  }
  text += "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\\x1b]11;rgb:1616/1616/1e1e\x1b\\";
  text += "\x1b]12;rgb:c0c0/caca/f5f5\x1b\\";
  // The modes and the scrolling region.
  text += "\x1b[?7h\x1b[?12l\x1b[?25h\x1b[?1049l\x1b[4l\x1b[20l";
  text += `\x1b[1;${rows}r`;
  // The tabstops: a clear, then one stop every eight columns.
  text += "\x1b[3g";
  for (let column = 9; column <= cols; column += 8) {
    text += `\x1b[${column}G\x1bH`;
  }
  // The cells.
  text += content;
  // The cursor, last. The tabstop program moved it.
  text += `\x1b[${rows};1H`;
  return encoder.encode(text);
}

/** Send the frames of one setup and let the client paint them. */
async function setup(stub: Stub, page: Page, frames: Uint8Array[]): Promise<void> {
  stub.send(frames.map((bytes) => ({ tag: 0x00, bytes })));
  await idle(SETTLE_MS);
  await resetWatch(page);
}

/** Run one restore and give back its stages. */
async function restore(
  page: Page,
  stub: Stub,
  tag: number,
  messages: Uint8Array[],
): Promise<Restore> {
  stub.send(messages.map((bytes) => ({ tag, bytes })));
  await idle(SETTLE_MS);
  const bytes = messages.reduce((sum, message) => sum + message.length, 0);
  return stages(await readWatch(page), bytes, messages.length);
}

test("the exit from the alternate screen, stage by stage", async () => {
  const stub = server();
  stub.reset();

  // The recorded exit of vim, from a real PTY of 200 columns and 50 rows. The
  // stream ends with `ESC [ ? 1049 l`, the cursor show, and the shell prompt.
  const vimExit = await fixture("vim-exit.bin");

  await withClient(async (page) => {
    await watch(page);
    const { cols, rows } = await size(page);
    const primary = encoder.encode(primaryScreen(cols, rows));
    const alternate = encoder.encode(alternateScreen(cols, rows));
    const dump = dumpFrame(LEAVE_ALTERNATE, cols, rows, shellCells(cols, rows));
    // A dump of the same screen with the scrollback of `SCROLLBACK_SCREENS`
    // screens in front of it. `terminal.rs` keeps a scrollback, and this frame
    // holds the byte volume that a dump of one carries.
    const bigDump = dumpFrame(
      LEAVE_ALTERNATE,
      cols,
      rows,
      shellCells(cols, rows).repeat(SCROLLBACK_SCREENS),
    );

    // The count of client frames before the runs. The client sends one resize
    // frame when it starts, and that frame is not part of any scenario.
    const framesBefore = stub.received.length;

    // eslint-disable-next-line no-console
    console.log(`\n  grid ${cols} by ${rows} cells, ${REPEATS} runs per scenario\n`);

    // 1. The output path. The program leaves the alternate screen, and the VT
    //    engine of the browser holds the primary screen already.
    const outputs: Restore[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await setup(stub, page, [primary, alternate]);
      outputs.push(await restore(page, stub, 0x00, [vimExit]));
    }
    report("output leave", outputs);

    // The output path is the path that the operator takes, so its result is
    // the answer to symptom 2. The screen must hold the shell content.
    expect(shellRows(await viewportText(page))).toBeGreaterThan(rows - 3);
    expect(await onAlternate(page)).toBe(false);
    // The leave switches the screen, so the VT engine asks for a full redraw
    // and the paint writes every row.
    expect(median(outputs.map((r) => r.rows))).toBe(rows);

    // 2. The dump path. One `0x01` frame that starts with `LEAVE_ALTERNATE`
    //    and carries every cell again.
    const dumps: Restore[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await setup(stub, page, [primary, alternate]);
      dumps.push(await restore(page, stub, 0x01, [dump]));
    }
    report("dump of the primary", dumps);

    expect(shellRows(await viewportText(page))).toBeGreaterThan(rows - 3);
    expect(await onAlternate(page)).toBe(false);
    expect(median(dumps.map((r) => r.rows))).toBe(rows);

    // 3. The same dump, one message per PTY read. The bytes and the parse do
    //    not change, so the difference is the price of the message count. This
    //    is the measurement of the streaming protocol.
    const split: Restore[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await setup(stub, page, [primary, alternate]);
      split.push(await restore(page, stub, 0x01, chunked(dump, READ_SIZE)));
    }
    report(`dump in ${chunked(dump, READ_SIZE).length} messages`, split);

    expect(shellRows(await viewportText(page))).toBeGreaterThan(rows - 3);

    // 4. A larger dump, in one message. The stages must follow the bytes, and
    //    this row gives the slope.
    const larges: Restore[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await setup(stub, page, [primary, alternate]);
      larges.push(await restore(page, stub, 0x01, [bigDump]));
    }
    report(`dump of ${SCROLLBACK_SCREENS} screens`, larges);

    expect(shellRows(await viewportText(page))).toBeGreaterThan(rows - 3);

    // 5. The same larger dump, one message per PTY read.
    const largeSplit: Restore[] = [];
    for (let run = 0; run < REPEATS; run += 1) {
      await setup(stub, page, [primary, alternate]);
      largeSplit.push(await restore(page, stub, 0x01, chunked(bigDump, READ_SIZE)));
    }
    report(`the same in ${chunked(bigDump, READ_SIZE).length} messages`, largeSplit);

    expect(shellRows(await viewportText(page))).toBeGreaterThan(rows - 3);

    // The client sent no resize frame during the five scenarios. The resize
    // debounce therefore has no part in this event.
    const during = stub.received.slice(framesBefore);
    expect(during.filter((frame) => frame.length > 0 && frame[0] === 0x01).length).toBe(0);

    // The two parse medians against their byte counts. The parse of a dump
    // holds a fixed part, the palette and the mode program, so the extra bytes
    // of the larger dump can cost nothing that this instrument can see.
    const smallParse = median(dumps.map((r) => r.parseMs));
    const largeParse = median(larges.map((r) => r.parseMs));
    const extraMs = largeParse - smallParse;
    const slope =
      extraMs > 0
        ? `${((bigDump.length - dump.length) / extraMs / 1024).toFixed(0)} KB per extra ms`
        : "the extra bytes cost no extra parse";
    // eslint-disable-next-line no-console
    console.log(
      `\n  bytes: output ${vimExit.length} B, dump ${dump.length} B, ` +
        `ratio ${(dump.length / vimExit.length).toFixed(0)}x\n` +
        `  parse: ${dump.length} B in ${smallParse.toFixed(2)} ms, ` +
        `${bigDump.length} B in ${largeParse.toFixed(2)} ms, ${slope}\n`,
    );
  });
}, 300_000);

test("a client that joins on the alternate screen gets no primary screen back", async () => {
  // `dump` of `crates/pirate/src/terminal.rs` carries the active screen only,
  // and its header states that limit. A client that already holds the primary
  // screen keeps it, because the dump of the alternate screen writes no cell
  // of the primary screen. A client that joins while a program holds the
  // alternate screen has no primary screen at all, and the exit of the program
  // therefore gives it an empty screen.
  //
  // This test is the control for H3. It shows the one state where the
  // alternate screen loses content, and that state is a wrong screen, not a
  // late screen.
  const stub = server();
  stub.reset();

  const vimExit = await fixture("vim-exit.bin");

  // The first client reports the grid size. The dump of the second client must
  // carry that size, and the stub sends it when the socket opens.
  const grid = await withClient((page) => size(page));
  const altDump = dumpFrame(
    ENTER_ALTERNATE,
    grid.cols,
    grid.rows,
    alternateScreen(grid.cols, grid.rows),
  );
  stub.setOnOpen([{ tag: 0x01, bytes: altDump }]);

  await withClient(async (page) => {
    await watch(page);
    await idle(SETTLE_MS);
    expect(await onAlternate(page)).toBe(true);

    // The program ends.
    stub.send([{ tag: 0x00, bytes: vimExit }]);
    await idle(SETTLE_MS);

    expect(await onAlternate(page)).toBe(false);
    const text = await viewportText(page);
    // eslint-disable-next-line no-console
    console.log(`\n  rows of text after the exit of a joined client: ${text.length}\n`);
    // The prompt of the exit stream is the only text left.
    expect(shellRows(text)).toBe(0);
    expect(text.length).toBeLessThan(3);
  });
}, 300_000);

/**
 * True when the VT engine of the page is on the alternate screen.
 *
 * The handle comes from the paint wrapper, so `watch` must run first and one
 * paint must have run.
 */
function onAlternate(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const vt = (globalThis as unknown as BenchWindow).__pirateVt;
    if (vt === undefined) {
      throw new Error("no paint gave the VT engine handle");
    }
    return vt.isAlternateScreen();
  });
}
