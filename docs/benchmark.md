# Benchmark

This file is the record of the latency measurements of pirate. It gives the
numbers, the command that prints each number, and the limit of each
measurement.

Two user reports drive most of this file.

- **Symptom 1.** A pane resize is slow and it flickers.
- **Symptom 2.** A full-screen program closes, and the screen behind it comes
  back after about 300 ms.

Three hypotheses were tested against each report.

- **H1.** The byte volume, the framing, or the parse holds the time.
- **H2.** The resize path holds the time.
- **H3.** A feature interaction with the alternate screen holds the time.

Both symptoms reproduce. Neither cause is in the wire protocol. The verdict of
symptom 2 is H3, and the verdict of symptom 1 is H2 plus a second holder in the
browser.

## The machine and the method

| Item | Value |
|---|---|
| Machine | Apple M-series laptop |
| Browser | the Chromium of Playwright 1.57.0, driven as a library |
| Graphics | software WebGL2, `--enable-unsafe-swiftshader` |
| VT engine of the client | `ghostty-web` 0.4.0, which wraps `ghostty-vt.wasm` |
| Editor of the child | nvim 0.12.4, started with `-u NONE` |
| Pager of the child | `less` |

Every time in this file is a median over 5 runs at least. A `p95` column is the
value at the nearest rank of the same samples. Both columns are here where the
spread governs a verdict.

## The rasterizer

The default browser harness runs Chromium with a software rasterizer, the flag
`--enable-unsafe-swiftshader`. This is the default path, and it is headless.

The switch to a real GPU lives in `web/tests/harness.ts`, `web/e2e/browser.ts`
and `web/bench/whole-path.ts`. Set `PIRATE_GPU=1` to select the real GPU, and
run headed. Leave it unset for the default path. The default launch arguments
stay the same, byte for byte, so CI does not move.

```text
cd web && PIRATE_E2E=1 PIRATE_GPU=1 bun test ./bench/whole-path.e2e.ts --timeout 600000
```

Every table in this file that came from the browser holds a software number,
not a GPU number, unless the table says GPU. Each browser table carries the
label **Software** or **GPU**, so a reader never has to guess.

## The toolchain

Run `cargo xtask build` first. That command installs the tools of `mise.toml`,
writes an `xcrun` shim into `.toolchain/shim`, and puts the pinned Zig 0.15.2 in
front of PATH.

With Homebrew Zig 0.16.0 on PATH, a raw `cargo build` of a cold target
directory fails. The error comes from `libghostty-vt-sys` and it names
`std.Io.Dir.readFileAlloc`.

`cargo xtask build` builds the `pirate` package alone. It does not build
`pirate-bench`. The release binaries of `pirate-bench` need the same
environment. A build of them with `mise env` alone, and without the shim, stops
at the link with `undefined symbol: _waitpid` and about twenty more libc
symbols. Take the environment like this:

```text
cargo xtask build
eval "$(mise env -s bash)"
export PATH="$PWD/.toolchain/shim:$PATH"
```

CAUTION: A warm target directory hides both failures. The `build.rs` of
`libghostty-vt-sys` runs `zig build` one time per target directory. After that
build the static library is a cached artifact. A later
`cargo build -p pirate-bench` then links it with no call to Zig. Reproduce
either failure in an empty `CARGO_TARGET_DIR`.

## The commands

`cargo xtask build` and `cd web && bun run build` come before every command in
this table. The Rust binaries also need the environment above.

| Command | What it prints | In CI |
|---|---|---|
| `cargo run --release -p pirate-bench --bin record_fixtures` | writes the fixtures | no |
| `cargo run --release -p pirate-bench --bin bench_server` | the three original server reports | no |
| `cargo run --release -p pirate-bench --bin bench_symptoms` | the server stage profile of both symptoms | no |
| `cargo run --release -p pirate-bench --bin bench_child -- editor 7` | the child alone on a bare PTY | no |
| `cargo run --release -p pirate-bench --bin bench_stage` | the server-side resize and dump cost | no |
| `cd web && bun run test` | the correctness specs, then the three browser spec files | yes |
| `cd web && PIRATE_E2E=1 bun test ./bench/whole-path.e2e.ts --timeout 600000` | the whole path, real browser on real server | no |

`bench_child` also takes `pager` and `minimal` in place of `editor`.

`cd web && bun run test` is `vite build && bun test tests bench`. It runs the
correctness specs of `web/tests/` and these three benchmark files:
`bench/latency.spec.ts`, `bench/altscreen.spec.ts` and
`bench/resize-storm.spec.ts`. Those three files drive the stub server of
`web/tests/stub-server.ts`, so no pirate process runs in them.

`bench/whole-path.e2e.ts` stays out of that run. It needs the compiled server
and the built client. Its name ends in `.e2e.ts`, which the file pattern of
`bun test` does not take.

## What the benchmarks assert

Every assertion of these benchmarks covers correctness. The client paints. The
size that it sent is the size of the viewport. The screen holds the expected
rows.

No benchmark asserts a threshold on a duration. CI never fails on a latency
number. A threshold on a latency number fails on a loaded machine and passes
on an idle one. It reports the load and not the code. The numbers are the
product of these files, and a human reads them.

Four assertions compare a duration. Each one is an invariant of the
instrument, not a threshold. `bench/latency.spec.ts` holds the median paint at
more than 0 ms. `bench/whole-path.e2e.ts` holds the median round trip at more
than 0 ms.

`bench/resize-storm.spec.ts` holds each stage of a settle at 0 ms or more. It
also holds the parse inside the output. A load on the machine makes each of
these four values larger, so no load can fail them.

## The whole-path stage profile

Five stages carry one screen event from the child to the pixel. This table puts
both symptoms beside each other. No single program measures all five, so the
last column names the source of each cell.

| Stage | Symptom 2, editor | Symptom 1, resize storm | Source |
|---|---|---|---|
| PTY read | 0.026 ms, a model | 1.659 ms, a model | `bench_symptoms` |
| server framing and encode | 0.001 ms parse, 0.000 ms encode | 0.176 ms parse, 0.005 ms encode | `bench_symptoms` |
| WebSocket transport, in process | 0.024 ms, a model | 1.9 to 14.5 ms, a model | `bench_symptoms` |
| WebSocket transport, real wire | 3.5 to 6.5 ms | 3.5 to 6.5 ms | `whole-path.e2e.ts`, the wire floor |
| wasm VT parse | 0.0 ms | 0.0 ms | `whole-path.e2e.ts` |
| render | 1.7 to 2.0 ms | 2.5 to 7.8 ms | `whole-path.e2e.ts` |
| the stage that holds the time | 1045 to 1055 ms, the gap between two server frames | 105 ms debounce, plus 47 to 58 ms in one browser task | `whole-path.e2e.ts` |
| TOTAL | 1013 to 1065 ms | 159 to 175 ms | `whole-path.e2e.ts` |

**Software.** The `whole-path.e2e.ts` cells came from the default rasterizer.
The `bench_symptoms` cells hold no browser and no rasterizer.

CAUTION: the two `TOTAL` cells are ranges of the median across three
independent runs of this track. They are not settled numbers. Read the shape,
which is one stage that holds almost the whole event.

CAUTION: the three cells marked `a model` are not measurements of pirate. The
`pty read` row holds the wait for the writer of the PTY, so read it as an upper
bound. The in-process transport is an equivalent loopback WebSocket in the same
process, and not the send instant inside pirate. The `real wire` row is the
number that a user pays, and it is 150 to 270 times the in-process number. Both
rows are right. They measure different spans.

The `bench_symptoms` cells of symptom 1 hold the whole 204280-byte drag. The
`whole-path.e2e.ts` cells of symptom 1 hold one 2467-byte redraw.

## Symptom 2: a full-screen program closes

The report said about 300 ms. It reproduces, and it is larger than the report.

Command:
`cd web && PIRATE_E2E=1 bun test ./bench/whole-path.e2e.ts --timeout 600000`

### The whole path, key to paint

Real browser, real pirate server, real child. 7 runs per row.

| Child | Frames | Bytes | Dumps | Median | p95 |
|---|---|---|---|---|---|
| `minimal`, a shell script | 1 | 30 | 0 | 10.4 ms | 15.8 ms |
| `pager`, `less` | 2 | 42 | 0 | 13.3 ms | 17.3 ms |
| `editor`, nvim 0.12.4 | 4 | 255 | 0 | 1013 to 1065 ms | 1056 to 1077 ms |

**Software.**

The editor row measured 1013 ms, 1054 ms and 1065 ms as the median in three
independent runs of the track. The p95 stayed between 1056 ms and 1077 ms. Read
this row as a range and not as a settled number. The DA1 timeout of the editor
governs it, and that timeout is about 1 second.

### The stage that holds the time

The editor row, split into the stages of `whole-path.ts`.

| Stage | Median | p95 |
|---|---|---|
| client input, the key to the send | 0.1 ms | 0.1 to 0.2 ms |
| child + wire, the send to the first frame back | 4.1 to 4.7 ms | 6.8 to 7.9 ms |
| stream, the first frame to the end of the last parse | 1045 to 1055 ms | 1050 to 1072 ms |
| of that, wasm VT parse | 0.0 ms | 0.1 to 0.2 ms |
| of that, the gap between two frames | 1045 to 1055 ms | 1050 to 1072 ms |
| paint | 1.7 to 2.0 ms | 5.9 to 7.3 ms |
| TOTAL | 1013 to 1065 ms | 1056 to 1077 ms |

**Software.**

One gap between two server frames holds the whole event. Every other stage is
under 8 ms.

### The cause

The editor writes DA1, the primary device attributes query, while it tears down
the alternate screen. The client never answers. The editor waits out its own
timeout of about 1 second, and it then writes `ESC [ ? 1049 l`.

The frame that carries the query ends with the bytes
`1b 5b 63 1b 5b 3f 32 35 68`. That is DA1, `ESC [ c`, followed by DECTCEM
show-cursor. The client sends zero frames during the gap that follows.

`ghostty-vt.wasm` 0.4.0 produces no response for DA1. This is not a drop in the
client. The drain at `web/src/terminal.ts:518` works, and the answers that the
engine does produce travel it and reach the socket. The query table of
`whole-path.e2e.ts`:

| Question | Answer | Bytes |
|---|---|---|
| DA1, `ESC [ c` | no answer | |
| DA2, `ESC [ > c` | no answer | |
| DSR, `ESC [ 5 n` | 0.1 to 0.3 ms | `1b 5b 30 6e` |
| CPR, `ESC [ 6 n` | 0.1 to 0.2 ms | `1b 5b 35 3b 31 52` |
| kitty keyboard, `ESC [ ? u` | no answer | |
| OSC 11, the background color | no answer | |
| DECRQM, `ESC [ ? 2026 $ p` | no answer | |

**Software.**

The single-variable proof runs on a bare PTY with no pirate in the path, with
the same editor. The command argument sets the run count, and row 1 above is
7 runs.

| Responder | Time to the last byte | Backed by a command |
|---|---|---|
| answers DA1 | 5.1 to 5.7 ms | yes |
| answers everything except DA1 | about 1009 ms | no |
| answers DSR only, exactly as the client does | about 1010 ms | no |

The first row is the default responder of `bench_child`. Command:
`cargo run --release -p pirate-bench --bin bench_child -- editor 7`.

CAUTION: no committed command prints row 2 or row 3. `bench_child` holds one
responder, the `answers` function, and it answers DA1. A run of the two other
responders needs a change to that function. Treat both numbers as a record of
one past experiment. Row 1 carries the finding on its own. A responder that
answers DA1 costs 5 ms. A responder that does not costs about 1 second.

### The verdicts

| Hypothesis | Verdict | The number that proves it |
|---|---|---|
| H1, bytes or parse | refuted | the whole event is 255 bytes in 4 frames, 0 dumps, wasm parse 0.0 ms |
| H2, the resize path | not involved | no resize takes part in this event |
| H3, the alternate screen | supported | the query handshake around the buffer holds 1045 to 1055 ms of a 1013 to 1065 ms total |

**Software.**

The symptom is program-dependent. `less` and the shell control ask no query,
and both are under 14 ms through the same browser.

### A second fault of the alternate screen

`dump()` at `crates/pirate/src/terminal.rs:150` carries the active screen
only. A client that joins while a program holds the alternate screen gets an
alternate-screen dump of 9625 bytes. That client has no primary screen behind
it. When the program ends, that client shows 2 rows of text where 38 belong.

This is a wrong screen and not a slow one. It costs 0.2 ms.
`bench/altscreen.spec.ts` prints the row count, and `bench_symptoms` prints the
byte count.

## Symptom 1: a pane resize that is slow and flickers

### The whole path, last resize to paint

Command:
`cd web && PIRATE_E2E=1 bun test ./bench/whole-path.e2e.ts --timeout 600000`.
Child `pager`, 12 size changes per storm, 7 runs.

| Stage | Median | p95 |
|---|---|---|
| debounce, the last size change to the fit | 104.8 to 105.0 ms | 106.0 to 107.0 ms |
| child + wire, the send to the first frame back | 51.3 to 63.0 ms | 55.7 to 68.5 ms |
| of that, one browser main-thread task | 47.4 to 58.0 ms | 53.6 to 67.0 ms |
| of that, `term.write`, `draw`, `render` and `fit` together | under 1.0 ms | 1.3 ms |
| stream | 0.1 ms | 0.1 to 0.2 ms |
| of that, wasm VT parse | 0.0 to 0.1 ms | 0.1 to 0.2 ms |
| paint | 2.5 to 7.8 ms | 6.0 to 8.6 ms |
| TOTAL | 159 to 175 ms | 167 to 182 ms |

CAUTION: do not compare the `one browser main-thread task` row with a figure
of another graphics stack. The `long task` row of the harness report measured
it, and that row counts main thread time alone. The software rasterizer works
on the raster thread and the compositor thread, and this row holds none of
that work. These values sit above the 50 ms threshold of the browser, so the
threshold does not make them zero. The `0 ms` cell of the canvas-area sweep
below is the other case. This row is main thread time that the browser
observed. It is not a complete account of the cost. Read "The GPU path" for
the limits of the row.

**Software.**

The settle measured 158.6 ms, 166.8 ms and 175.1 ms as the median across three
runs of the track. The debounce is the stable part of it. The browser task and
the paint carry the spread.

### The two holders

**The debounce holds 104 to 107 ms.** `RESIZE_DEBOUNCE_MS` is 50 at
`web/src/main.ts:33`, and `scheduleFit` at `web/src/main.ts:302` applies it.

**One browser main-thread task holds 47 to 62 ms.** This task is outside
`term.write`, `renderer.draw`, `renderer.render` and `renderer.fit`. All four
are wrapped, and all four read under 1 ms. A CPU profile puts about 5 ms in
JavaScript and in wasm. The rest is engine-internal work that the canvas resize
starts.

The `long task` row of the harness report measured this task, under the
software rasterizer. Read the CAUTION under the table of "The whole path, last
resize to paint" before you compare this figure with another graphics stack.

The task scales with the canvas area.

| Canvas | Widest long task | Backed by a command |
|---|---|---|
| 400 x 300 | 0 ms | no |
| 1000 x 600 | 64 ms | no |
| 1600 x 1000 | 152 ms | no |

CAUTION: no committed command prints this table. `whole-path.e2e.ts` reports
the long task at one canvas size alone. No benchmark sweeps the canvas area.
This table is a record of one past experiment. Rebuild the sweep before anyone
sizes the work from it.

CAUTION: this table comes from software WebGL2. No sweep of the canvas area
has run on a real GPU yet. Read "The GPU path" below for the first GPU number
of this task, at one canvas size.

CAUTION: do not compare these three figures with a figure of another path or
another harness. The `long task` row measured them, and "The GPU path" below
gives the limits of that row. The 50 ms threshold of the browser makes the
`0 ms` cell of the 400 x 300 canvas a threshold artifact. That cell means less
than 50 ms, and it does not mean no cost. This document holds no replacement
figure for the sweep.

**Software.**

### The GPU path

Command:
`cd web && PIRATE_E2E=1 PIRATE_GPU=1 bun test ./bench/whole-path.e2e.ts --timeout 600000`.
Child `pager`, 12 size changes per storm, 7 runs. Both runs sat within one
minute of each other, at a 1-minute load average of 2.29 and 2.12.

| Stage | Default path, headless | GPU path, headed |
|---|---|---|
| renderer | ANGLE (Google, Vulkan 1.3.0 SwiftShader Device) | ANGLE (Apple, ANGLE Metal Renderer: Apple M5) |
| debounce | 53.0 ms, p95 54.6 ms | 52.0 ms, p95 52.8 ms |
| child + wire | 51.4 ms, p95 56.7 ms | 9.0 ms, p95 16.2 ms |
| stream | 0.1 ms | 0.1 ms |
| paint | 3.7 ms, p95 7.1 ms | 4.4 ms, p95 7.0 ms |
| TOTAL | 108.5 ms, p95 117.0 ms | 66.8 ms, p95 75.9 ms |

**Software** for the first column, **GPU** for the second.

The real GPU removes 41.7 ms of the total, 108.5 ms down to 66.8 ms. One stage
carries that difference. `child + wire` falls from 51.4 ms to 9.0 ms, which is
42.4 ms. The other three stages move 1 ms or less each. These two rows are the
whole evidence of this section. No other row separates the two paths.

A column of this table does not sum to its `TOTAL`. The stages tile the
measured window per run, at `web/bench/whole-path.ts:542-556`. Each cell is an
independent median over the 7 runs, and `TOTAL` is the median of the 7 run
totals. The default column sums to 108.2 ms against a 108.5 ms median total.
The GPU column sums to 65.5 ms against a 66.8 ms median total.

CAUTION: this table gives no `long task` row. Do not use the `long task` row of
the harness report to compare these two paths. The browser reports a long task
only above a 50 ms threshold, and it counts main thread time alone. The
software rasterizer works on the raster thread and the compositor thread. On an
idle machine this row reads 0.0 ms on both paths, and the row is bimodal with
machine load. A full trace of a default-path storm held zero long task events.
The observer is live on both paths:
`PerformanceObserver.supportedEntryTypes` holds `longtask`, and `observe()` is
accepted.

The `main stall` row is not independent evidence. `widestGap` in
`web/bench/whole-path.ts:576` seeds its marks with the window edges, so
`main stall` is always equal to or less than `child + wire`.

About 42 ms of every headless figure in this document is an artifact of the
software rasterizer, and not a cost that the operator pays.

On the GPU the largest single stage is the debounce, 52.0 ms of a 66.8 ms
total.

### The flicker

Command: `cd web && bun run test`, file `bench/resize-storm.spec.ts`. The
`trip` column of that file measures the stub harness and not the pirate server.
Read the `local` column for the cost of the client.

The flicker has two shapes.

| Drag | Size changes | Resize frames | Redraws | Bytes | Paints before the fit | Paints |
|---|---|---|---|---|---|---|
| faster than the debounce | 12 | 1 | 1 | 4145 | 0 | 2 |
| a 160 ms step | 12 | 11 to 12 | 11 to 12 | 60000 to 66217 | 0 to 1 | 19 to 21 |

**Software.**

A drag faster than the debounce paints zero times during the drag. The canvas
holds the old grid and it mis-scales. A drag at a 160 ms step lets every step
through, and every step gives a full redraw.

### The verdicts

| Hypothesis | Verdict | The number that proves it |
|---|---|---|
| H1, bytes or parse | refuted | a 56-byte redraw and a 4145-byte redraw give the same client settle, `local` 120.9 to 122.6 ms and 116.3 to 122.5 ms. Parse is 0.1 ms |
| H2, the resize path | supported | the debounce holds 105 ms and the canvas-area task holds 47 to 58 ms of a 159 to 175 ms total |
| H3, the alternate screen | refuted | alternate minus normal was +0.2, +0.6, -0.8, +2.4, -4.7, -2.5, -3.6 and -0.5 ms, so the sign changes and it is noise |

The canvas-area task of the H2 row comes from the `long task` row, which "The
GPU path" withdraws for a comparison across graphics stacks. The `child + wire`
rows of "The GPU path" carry the same verdict without that row. The verdict
stays.

**Software.**

The server is not slow here. The tail from the last resize frame to the last
byte stays between 0.25 ms and 6.4 ms.

## The server, both symptoms

Command: `cargo run --release -p pirate-bench --bin bench_symptoms`, 200x50,
9 runs per row.

CAUTION: in this program the `pty read` row and the `transport` row are models
and not measurements of pirate. The transport is an equivalent loopback
WebSocket in the same process, and not the send instant inside pirate. The
bytes, the message count and the dump count of the two symptom tables come from
a real pirate server.

### Symptom 2, the leave sequence

123 bytes in one message.

| Stage | Bytes | Calls | Median | p95 | Kind |
|---|---|---|---|---|---|
| pty read | 123 | 1 | 0.023 to 0.026 ms | 0.043 to 0.045 ms | model |
| parse | 123 | 1 | 0.001 ms | 0.002 ms | measurement |
| encode | 123 | 1 | 0.000 ms | 0.000 ms | measurement |
| transport | 123 | 1 | 0.023 to 0.024 ms | 0.024 to 0.050 ms | model |

Parse plus encode plus wire is 0.024 to 0.026 ms. That is under 0.01 percent of
the 300 ms of the report. With one resync dump beside it, the total is 0.540 to
0.554 ms, or under 0.19 percent.

The dump on the alternate screen is 9625 bytes. The dump after the leave is
9674 bytes, at 0.43 to 0.53 ms median.

### Symptom 1, the resize burst

One repaint of the child is 5107 bytes. 40 resize frames per burst.

| Burst | Messages | Bytes | Bytes per message | Dumps | Repaints | Tail | Tail p95 |
|---|---|---|---|---|---|---|---|
| line writer, drag 16 ms | 1264 to 1759 | 204280 | 116 to 161 | 0 | 40 | 0.84 to 2.19 ms | 2.37 ms |
| line writer, flood 0 ms | 6 to 22 | 10214 | 464 to 1702 | 0 | 2 | 1.39 to 4.01 ms | 4.59 ms |
| screen writer, drag 16 ms | 170 to 214 | 204280 | 954 to 1201 | 0 | 40 | 0.37 to 0.84 ms | 0.88 ms |
| screen writer, flood 0 ms | 1 to 5 | 10214 | 2042 to 10214 | 0 | 2 | 2.88 to 5.28 ms | 6.40 ms |

CAUTION: the `messages` column and the `bytes per message` column are
load-dependent. They move with the coalescing of the PTY reads, in the way that
the `flood.bin` row further down describes. Read no regression signal into
either column. The `bytes`, the `dumps` and the `repaints` columns are stable.

The message count depends on how the child writes. A child that writes one row
per call gives about 120 to 160 bytes per message. The join at
`crates/pirate/src/session.rs:480` then often does not fire, because the queue
is empty at each PTY read. A child that writes a whole screen per call gives
about 950 to 1700 bytes per message, and the join fires.

A flood of 40 resize frames with no gap gives 1 to 22 messages, 2 repaints and
0 resync dumps. The client queue never overflowed, except in 1 of 16 drag rows.

### The server-side terminal

Command: `cargo run --release -p pirate-bench --bin bench_stage`. 109 columns,
38 rows, 21 repeats per row, 3 runs.

| History | Resize median | Dump median | Dump bytes |
|---|---|---|---|
| 0 lines | 0.01 to 0.02 ms | 0.01 ms | 5626 |
| 100 lines | 0.03 to 0.04 ms | 0.04 ms | 11426 |
| 400 lines | 0.09 to 0.10 ms | 0.14 ms | 28826 |
| 2000 lines | 0.15 to 0.16 ms | 0.23 to 0.24 ms | 45936 |

No PTY and no socket runs in this program, so these numbers hold no scheduler
noise.

### The wire floor

The in-process transport number above is 0.024 ms. That is not the number a
user pays.

The `wire floor` test of `whole-path.e2e.ts` sends one byte to a `cat` child
over a real TLS WebSocket and a real PTY, and takes the echo. It measures 3.5
to 6.5 ms median, and 7.4 to 8.5 ms p95.

The real wire is 150 to 270 times the in-process number. Both numbers are
right. They measure different spans.

## Fixtures and the original reports

Fixtures are in `crates/pirate-bench/fixtures/`.
`cargo run --release -p pirate-bench --bin record_fixtures` writes them.

| Fixture | Bytes | What wrote it |
|---|---|---|
| `clear.bin` | 26 | `clear` |
| `vim-exit.bin` | 123 | vim, on `:q!` |
| `vim-open.bin` | 4098 | vim, on open |
| `flood.bin` | 1488917 | `seq 1 200000` |

### Pipeline: the processor cost inside the server

No PTY and no socket runs in this report. 5 runs.

| Scenario | Bytes | Parse | Encode | Dump bytes | Dump |
|---|---|---|---|---|---|
| one byte | 1 | 0.000 ms | 0.000 ms | 5737 | 0.011 ms |
| clear | 26 | 0.003 ms | 0.000 ms | 5744 | 0.008 ms |
| vim-exit | 123 | 0.001 ms | 0.000 ms | 5744 | 0.010 ms |
| vim-open | 4098 | 0.011 ms | 0.000 ms | 9625 | 0.027 ms |
| flood | 1488917 | 5.70 to 9.29 ms | 0.034 to 0.051 ms | 8298 | 0.052 to 0.079 ms |

### Round trip

One byte to a live PTY, and the echo of the line discipline, 500 times. No
process starts in this path.

| Trips | Median | p95 | p99 |
|---|---|---|---|
| 500 | 0.053 ms | 0.072 ms | 0.104 ms |

This number is the loopback of the process. The `wire floor` above is the
number that a user pays.

### End to end: a real PTY, a real socket, and one `exec` per row

5 runs.

| Fixture | Frames | Bytes per frame | Dumps | `first` | `last` |
|---|---|---|---|---|---|
| one byte | 1 | 1 | 0 | 22.6 to 23.6 ms | the same |
| `clear.bin` | 1 | 26 | 0 | 21.3 to 24.3 ms | the same |
| `vim-exit.bin` | 1 | 123 | 0 | 22.4 to 24.5 ms | the same |
| `vim-open.bin` | 1 | 4098 | 0 | 23.0 to 24.8 ms | the same |
| `flood.bin` | 26 to 1033 | 1454 to 57266 | 0 | 23.1 to 25.3 ms | 37.0 to 40.7 ms |

CAUTION: the `first` column holds one round trip. That trip covers the socket,
the PTY, the process scheduler, and an `exec` of `cat`. That `exec` is
milliseconds on its own, and it is not a cost of pirate. Read the `one byte`
row as the floor of that column. This track superseded the earlier figures of
3.95 ms to 5.22 ms in this table. Those figures came from a different clock.

CAUTION: the frame count of the `flood.bin` row is bimodal. On an idle machine
it measured 26, 26, 26, 26, 26, 26, 27, 27 and 27 frames. On a loaded machine it
measured 958, 976, 992, 1005, 1006 and 1024 frames. Earlier runs of the same row
gave 940, 1007 and 1033. The cause is the join at
`crates/pirate/src/session.rs:480`. The join takes what the queue already holds.
A queue that drains as fast as it fills holds nothing. Read no regression signal
into this row. The byte count, 1488917, is stable, and so is the dump count.

### The client budget

`cd web && bun run test`, file `bench/latency.spec.ts`, median of 5 runs. The
stub sends the fixture, so no pirate process runs here.

| Event | Bytes | Parse | Wait for the paint | Paint | Total |
|---|---|---|---|---|---|
| clear | 26 | 0.00 ms | 2.6 ms | 0.4 ms | 3.3 ms |
| vim opens | 4098 | 0.30 ms | 3.1 ms | 0.5 ms | 4.4 ms |
| vim exits | 123 | 0.10 ms | 4.9 ms | 0.4 ms | 5.2 ms |
| dump of one screen | 2003 | 0.10 ms | 4.4 ms | 0.6 ms | 5.1 ms |

**Software.**

This track superseded the earlier figures of 10.8 ms to 15.3 ms in this table.

The exit of vim here is 5.2 ms, because the stub sends the leave sequence at
once. The whole path with a real editor is 1013 to 1065 ms. The difference is the DA1
timeout above.

The same flood, sent at four message sizes. `paints` counts the full repaints
that ran while the bytes were still arriving.

| Messages | Parse | Paints | Total |
|---|---|---|---|
| 1455 | 26.2 ms | 10 | 550.7 ms |
| 182 | 26.7 ms | 10 | 538.8 ms |
| 26 | 22.2 ms | 11 | 576.6 ms |
| 1 | 35.9 ms | 0 | 39.3 ms |

**Software.**

The parse holds 4 to 7 percent of each split total. The rest is the event loop
and the repaints between the messages.

Draw cost by grid size:

| Grid | Cells | Draw | Per cell |
|---|---|---|---|
| 69x25 | 1725 | 0.4 ms | 0.232 us |
| 109x38 | 4142 | 0.4 ms | 0.097 us |
| 176x58 | 10208 | 0.7 ms | 0.069 us |

**Software.**

### The client, from `bench/altscreen.spec.ts`

109 columns, 38 rows, 9 runs per scenario, 2 runs of the file.

| Scenario | Bytes | Messages | Parse | Total |
|---|---|---|---|---|
| output leave | 123 | 1 | 0.3 ms | 3.9 to 7.6 ms |
| dump of the primary | 12032 | 1 | 10.1 to 10.3 ms | 11.1 to 11.7 ms |
| dump in 12 messages | 12032 | 12 | 5.9 to 9.1 ms | 10.2 to 12.3 ms |
| dump of 8 screens | 45219 | 1 | 10.6 to 10.9 ms | 11.6 to 11.8 ms |
| the same in 45 messages | 45219 | 45 | 6.1 to 10.9 ms | 13.2 to 60.3 ms |

**Software.**

A dump is 98 times the bytes of the plain output leave. The parse takes one
extra millisecond per 54 KB to 81 KB. That figure is the difference of two
parse medians that are under 1 ms apart, so it carries a wide error. Three runs
of the track gave 54 KB, 65 KB and 81 KB.

CAUTION: the `total` of a split scenario carries the `arrive` stage, which is
the loopback socket of the stub harness. That stage measured 1.2 ms and 54.2 ms
in two runs of the same row. Read the `parse` and `draw` columns for the cost
of the client.

## Follow-ups

This track produced these items. They are a list and not a design.

1. **Answer DA1 in the client.** `ghostty-vt.wasm` 0.4.0 makes no DA1
   response, so the client must answer it. The place is beside `pumpResponse`
   at `web/src/terminal.ts:518`. A VT220-class terminal sends
   `ESC [ ? 62 ; 22 c`. This is the cause of symptom 2.
2. **The canvas-area long task.** One browser main-thread task holds 47 to
   62 ms after a canvas resize, and it scales with the canvas area. The
   `long task` row measured it under software WebGL2. That row cannot give the
   GPU number, for the reason in "The GPU path". A sweep of the canvas area
   needs a measurement that holds on both paths first.
3. **`dump()` carries the active screen only.**
   `crates/pirate/src/terminal.rs:150`. A client that joins while a program
   holds the alternate screen shows 2 rows where 38 belong, after the program
   ends.
4. **The join does not fire for a small writer.**
   `crates/pirate/src/session.rs:480`. A child that writes one row per call
   gives 1264 to 1753 messages for 204280 bytes. The queue is empty at each PTY
   read, so the join takes nothing.
5. **A stamp that splits framing from transport.**
   `crates/pirate/src/session.rs:494-497` needs a hook for it. Gate it on an
   environment variable and keep it off by default. The `transport` row of
   `bench_symptoms` is a model until this hook exists.
6. **The binary path of the end-to-end server.** `web/e2e/server.ts:23` holds
   `target/debug/pirate` as a constant. Take it from an environment variable.
   A release measurement of the whole path needs this change.
7. **A wrapper landmine in the harness.** `countFits` and `countRenders` of
   `web/tests/harness.ts` install a wrapper on the renderer. Each one then
   removes that wrapper with `delete` on an own property. The call works only
   while the method stays on the prototype. A method that moves to the instance
   makes the same call remove the instrument, with no error.
