/**
 * The whole path, end to end: a real browser on a real pirate server.
 *
 * # Why this file exists
 *
 * Three benchmarks landed before this one. `bench/latency.spec.ts` and
 * `bench/altscreen.spec.ts` drive the client from `tests/stub-server.ts`, so no
 * pirate process runs in them. `crates/pirate-bench/src/bin/bench_server.rs`
 * drives the server with a WebSocket client, so no browser runs in it. The two
 * halves, added, hold under 10 ms for symptom 2, and the report of symptom 2 is
 * about 300 ms. This file measures the join.
 *
 * # What it measures
 *
 * Symptom 2. A full-screen program on the alternate screen, a full primary
 * screen behind it, one real key that quits the program, and the paint that
 * shows the primary screen again.
 *
 * Symptom 1. A resize storm on a real window, against a real child that
 * redraws on `SIGWINCH`.
 *
 * # How to run it
 *
 * This file needs the compiled server and the built client, so it stays out of
 * `bun run test`. Its name ends in `.e2e.ts`, which the file pattern of
 * `bun test` does not take.
 *
 * ```text
 * cargo xtask build
 * cd web && bun run build
 * cd web && PIRATE_E2E=1 bun test ./bench/whole-path.e2e.ts --timeout 600000
 * ```
 *
 * # The graphics stack
 *
 * The command above starts a headless browser on the software rasterizer.
 * `PIRATE_GPU=1` starts a headed browser on the hardware graphics stack of the
 * machine instead:
 *
 * ```text
 * cd web && PIRATE_E2E=1 PIRATE_GPU=1 bun test ./bench/whole-path.e2e.ts --timeout 600000
 * ```
 *
 * Read `child + wire` and `main stall` to compare the two paths. The software
 * rasterizer adds its time there.
 *
 * Do not read `long task` for this comparison. The browser reports a long task
 * only above 50 ms, so the row is a step and not a measurement. It reads
 * 0.0 ms on both paths on an idle machine, and it jumps to about 55 ms on a
 * busy one. The rasterizer runs off the main thread, and a long task counts
 * main thread time alone.
 *
 * Each report prints the renderer string of the run. Read that string before
 * you read the numbers.
 *
 * # The stages
 *
 * | Stage | What it holds |
 * |---|---|
 * | `client` | the key to the send, or the last resize to the send |
 * | `child+wire` | the send to the first frame back |
 * | `stream` | the first frame to the end of the last parse |
 * | `parse` | time inside `term.write`, a part of `stream` |
 * | `paint` | the end of the last parse to the end of the paint |
 *
 * The page cannot split `child+wire` further, because it sees one arrival and
 * not three events. Two other measurements split it. The `wire floor` test
 * below sends one byte to a `cat` child and takes the echo, which is the
 * server and the socket with no think time. `bench_child` of `pirate-bench`
 * starts the same child on a bare PTY and reports the think time with no
 * pirate in the path.
 *
 * # Assertions
 *
 * This file asserts on correctness and never on a duration. A threshold on a
 * latency number makes a test that fails on a loaded machine, so CI must never
 * hold one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  childPath,
  closeBrowser,
  idle,
  queryChildPath,
  counts,
  join,
  quantile,
  renderer,
  reset,
  stages,
  table,
  trace,
  waitForQuiet,
  waitForScreen,
  waitForSend,
  wire,
  type Child,
  type Join,
  type Row,
  type Stages,
} from "./whole-path";

/** Measured events per report. */
const RUNS = 7;

/** Round trips of the wire floor report. */
const TRIPS = 20;

/** Silence that ends one measured event, in milliseconds. */
const QUIET_MS = 150;

/** The tag of an input frame, from `crates/pirate/src/protocol.rs`. */
const INPUT = 0x00;

/** The tag of a resize frame. */
const RESIZE = 0x01;

/** The first line that a full-screen child draws on the alternate screen. */
const ALT_MARK = "file 0001";

/** The line that the child prints after the alternate screen is gone. */
const GONE = "EDITOR-GONE";

/**
 * The settle time of symptom 1 that `bench/resize-storm.spec.ts` reported.
 *
 * That benchmark drives the stub server, so its number holds the client alone.
 * The verdict line below compares the whole path against it.
 */
const REPORTED_SYMPTOM_1_MS = 108;

/** The questions that `children/queries.sh` prints, one per line of input. */
const QUERIES = ["da1", "da2", "dsr", "cpr", "kitty", "bg", "sync"];

/** The wait for one answer of the client, in milliseconds. */
const ANSWER_WAIT_MS = 400;

/** The sizes of the resize storm, in pixels. */
const STORM_STEPS = 12;
const STORM_WIDE = 1000;
const STORM_NARROW = 760;

/**
 * Report of symptom 2 for one child.
 *
 * With `traced` true, the last run prints every frame of the event.
 */
async function measureExit(child: Child, traced = false): Promise<Stages[]> {
  const session = await join(childPath(child));
  try {
    const out: Stages[] = [];
    // The first round warms the page: the wasm module, the atlas of the
    // renderer, and the first grid all build inside it.
    for (let run = 0; run <= RUNS; run += 1) {
      await waitForAlternateScreen(session.page, child);
      await reset(session.page);
      await session.page.keyboard.press("q");
      await waitForScreen(
        session.page,
        (lines) => lines.some((line) => line.includes(GONE)),
        `the primary screen of ${child}`,
      );
      await waitForQuiet(session.page, QUIET_MS);
      const record = await wire(session.page);
      const key = record.keys[0];
      expect(key).toBeGreaterThanOrEqual(0);
      if (run > 0) {
        out.push(stages(record, key, INPUT));
      }
      if (traced && run === RUNS) {
        trace(`symptom 2, every frame of one exit, child \`${child}\``, record, key);
      }
      // Ask the child for the next round.
      await session.page.keyboard.press("Enter");
    }
    expect(pageFaults(session)).toEqual([]);
    return out;
  } finally {
    await session.close();
  }
}

/**
 * The page errors that are faults.
 *
 * The client asks `/auth` before it holds a session, and the server answers
 * 401. The browser logs that answer as a console error, and it is the normal
 * first step of the login. Every other error is a fault.
 */
function pageFaults(session: Join): string[] {
  return session.errors.filter((text) => !text.includes("401"));
}

/** Wait until the child drew the alternate screen and the socket is quiet. */
async function waitForAlternateScreen(page: Page, child: Child): Promise<void> {
  await waitForScreen(
    page,
    (lines) => lines.some((line) => line.includes(ALT_MARK)),
    `the alternate screen of ${child}`,
  );
  await waitForQuiet(page, QUIET_MS);
}

/**
 * The rows that every report shares.
 *
 * `first` is the name of the stage before the send: the input path for a key,
 * and the debounce for a resize. `last` is the name of the total.
 */
function stageRows(samples: Stages[], first: string, last: string): Row[] {
  return [
    { name: first, values: samples.map((s) => s.client) },
    { name: "child + wire", values: samples.map((s) => s.childAndWire) },
    { name: "  of that, paint", values: samples.map((s) => s.blocked) },
    { name: "  of that, renderer", values: samples.map((s) => s.renderer) },
    { name: "  of that, long task", values: samples.map((s) => s.longTask) },
    { name: "  of that, main stall", values: samples.map((s) => s.stall) },
    { name: "stream", values: samples.map((s) => s.stream) },
    { name: "  of that, wasm parse", values: samples.map((s) => s.parse) },
    { name: "  of that, frame gap", values: samples.map((s) => s.betweenFrames) },
    { name: "paint", values: samples.map((s) => s.paint) },
    { name: last, values: samples.map((s) => s.total) },
  ];
}

/** The report of symptom 2 names this number, in milliseconds. */
const REPORTED_SYMPTOM_2_MS = 300;

/**
 * Print a plain verdict: does the reported time reproduce, and where is it.
 *
 * The largest stage comes from the medians, so one slow run cannot name it.
 */
function verdict(what: string, samples: Stages[], rows: Row[], reportedMs: number): void {
  const total = quantile(
    samples.map((sample) => sample.total),
    0.5,
  );
  const stages = rows.filter((row) => !row.name.startsWith("  ") && !row.name.startsWith("TOTAL"));
  let widest = stages[0];
  for (const row of stages) {
    if (quantile(row.values, 0.5) > quantile(widest.values, 0.5)) {
      widest = row;
    }
  }
  const reproduces = total >= reportedMs ? "yes" : "no";
  // eslint-disable-next-line no-console
  console.log(
    `  VERDICT ${what}: median ${total.toFixed(1)} ms. ` +
      `The reported ${reportedMs} ms reproduces: ${reproduces}. ` +
      `The largest stage is \`${widest.name}\` at ${quantile(widest.values, 0.5).toFixed(1)} ms.\n`,
  );
}

/** Print one report of symptom 2 and give back the totals. */
function reportExit(child: Child, samples: Stages[]): number[] {
  const rows = stageRows(samples, "client input", "TOTAL key to paint");
  table(`symptom 2, the alternate screen leave, child \`${child}\``, samples.length, rows);
  counts("frames", samples.map((s) => s.frames));
  counts("bytes", samples.map((s) => s.bytes));
  counts("dumps", samples.map((s) => s.dumps));
  verdict(`symptom 2, child \`${child}\``, samples, rows, REPORTED_SYMPTOM_2_MS);
  return samples.map((sample) => sample.total);
}

describe("the whole path, a real browser on a real pirate server", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  test("symptom 2: the minimal child, which holds no think time", async () => {
    const samples = await measureExit("minimal");
    expect(samples.length).toBe(RUNS);
    const totals = reportExit("minimal", samples);
    // Correctness, not latency: every run painted the primary screen.
    expect(totals.every((value) => value > 0)).toBe(true);
    expect(samples.every((sample) => sample.frames > 0)).toBe(true);
  });

  test("symptom 2: a real pager on the alternate screen", async () => {
    const samples = await measureExit("pager", true);
    expect(samples.length).toBe(RUNS);
    const totals = reportExit("pager", samples);
    expect(totals.every((value) => value > 0)).toBe(true);
  });

  test("symptom 2: a real editor on the alternate screen", async () => {
    const samples = await measureExit("editor", true);
    expect(samples.length).toBe(RUNS);
    const totals = reportExit("editor", samples);
    expect(totals.every((value) => value > 0)).toBe(true);
  });

  test("symptom 1: a resize storm against a real child", async () => {
    const session = await join(childPath("pager"));
    try {
      const samples: Stages[] = [];
      for (let run = 0; run <= RUNS; run += 1) {
        await waitForAlternateScreen(session.page, "pager");
        await reset(session.page);
        // A window drag gives one resize event for each frame of the drag.
        //
        // Each run ends at the other width. The client sends a resize frame
        // only when the cell count changes, so a run that ends at the width of
        // the run before it sends nothing and measures nothing.
        const endWide = run % 2 === 1;
        for (let step = 0; step < STORM_STEPS; step += 1) {
          const wide = (step % 2 === 1) === endWide;
          await session.page.setViewportSize({
            width: wide ? STORM_WIDE : STORM_NARROW,
            height: 600 - step,
          });
        }
        await waitForSend(session.page, RESIZE);
        await waitForQuiet(session.page, QUIET_MS);
        const record = await wire(session.page);
        const send = record.sends.find((frame) => frame.tag === RESIZE);
        expect(send).toBeDefined();
        const before = record.resizes.filter((at) => at <= send!.t);
        expect(before.length).toBeGreaterThan(0);
        const last = Math.max(...before);
        if (run > 0) {
          samples.push(stages(record, last, RESIZE));
        }
        if (run === RUNS) {
          trace("symptom 1, every frame of one storm", record, last);
        }
      }
      expect(samples.length).toBe(RUNS);
      const rows = stageRows(samples, "debounce", "TOTAL last resize to paint");
      const stack = await renderer(session.page);
      table(
        `symptom 1, a resize storm, child \`pager\`, renderer \`${stack}\``,
        samples.length,
        rows,
      );
      counts("frames", samples.map((s) => s.frames));
      counts("bytes", samples.map((s) => s.bytes));
      verdict("symptom 1, a resize storm", samples, rows, REPORTED_SYMPTOM_1_MS);
      expect(samples.every((sample) => sample.total > 0)).toBe(true);
      expect(pageFaults(session)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("the questions of a full-screen program that the client answers", async () => {
    const session = await join(queryChildPath());
    try {
      const rows: string[] = [];
      for (const name of QUERIES) {
        await reset(session.page);
        await session.page.keyboard.type(name);
        await session.page.keyboard.press("Enter");
        await idle(ANSWER_WAIT_MS);
        const record = await wire(session.page);
        // A typed key is printable. Every answer of a terminal starts with
        // the escape character, so this test needs no other mark.
        const answer = record.sends.find((frame) => frame.head.startsWith("00 1b"));
        const asked = record.recvs.find((frame) => frame.head.includes("1b"));
        const delay =
          answer === undefined || asked === undefined ? 0 : answer.t - asked.t;
        rows.push(
          `${name.padEnd(8)}${(answer === undefined ? "no answer" : `${delay.toFixed(1)} ms`).padStart(12)}` +
            `  ${answer === undefined ? "" : answer.head}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        [
          "",
          `  the questions of a full-screen program, wait ${ANSWER_WAIT_MS} ms each`,
          "",
          `${"question".padEnd(8)}${"answer".padStart(12)}  bytes`,
          ...rows,
          "",
        ].join("\n"),
      );
      expect(rows.length).toBe(QUERIES.length);
      expect(pageFaults(session)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("wire floor: one byte to a child that answers at once", async () => {
    const session = await join("/bin/cat");
    try {
      const trips: number[] = [];
      for (let trip = 0; trip <= TRIPS; trip += 1) {
        await reset(session.page);
        await session.page.keyboard.press("x");
        await waitForQuiet(session.page, QUIET_MS);
        const record = await wire(session.page);
        const send = record.sends.find((frame) => frame.tag === INPUT);
        const back = record.recvs.find((frame) => send !== undefined && frame.t >= send.t);
        expect(send).toBeDefined();
        expect(back).toBeDefined();
        if (trip > 0) {
          trips.push(back!.t - send!.t);
        }
      }
      table("wire floor: send to echo, no think time", trips.length, [
        { name: "send to first frame", values: trips },
      ]);
      expect(trips.length).toBe(TRIPS);
      expect(quantile(trips, 0.5)).toBeGreaterThan(0);
      expect(pageFaults(session)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
