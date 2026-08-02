# Latency

This file holds the latency measurements of pirate, and the changes that the
measurements caused. Every number here comes from one of the two benchmarks
below. Both are in the repository, and both replay recorded byte streams from a
real terminal.

## Where the measurement code lives

No measurement code sits with the code that ships. The `pirate` crate holds the
server, and the `pirate-bench` crate holds everything that measures it.

| Path | What it holds |
|---|---|
| `crates/pirate-bench/src/bin/record_fixtures.rs` | Records the fixtures from a real PTY |
| `crates/pirate-bench/src/bin/bench_server.rs` | The server half of the measurement |
| `crates/pirate-bench/fixtures/` | The recorded byte streams |
| `web/bench/instrument.ts` | Wraps `term.write` and the renderer, in the page |
| `web/bench/latency.spec.ts` | The browser half of the measurement |
| `docs/latency.md` | This file |

`web/tests/harness.ts` starts the browser and the stub server for every browser
test. The benchmark imports it, and nothing in `web/tests` imports the benchmark.

Two words carry a fixed meaning in this file. A **frame** is one unit of the
protocol in `crates/pirate/src/protocol.rs`: a tag byte and a payload. A
**message** is one binary WebSocket message on the wire. One message can carry
one frame, and the server joins many output frames into one message.

## How to measure

```text
cargo run --release -p pirate-bench --bin record_fixtures   # record again
cargo run --release -p pirate-bench --bin bench_server      # the server half
cd web && bun test bench/latency.spec.ts                    # the browser half
```

The fixtures are in `crates/pirate-bench/fixtures/`. `record_fixtures` records
them from a real PTY of 200 columns and 50 rows. `source.txt` in that directory
is the file that vim opens, and it is not a fixture.

| Fixture | Bytes | What wrote it |
|---|---|---|
| `clear.bin` | 26 | `clear` |
| `vim-exit.bin` | 123 | vim, on `:q!` |
| `vim-open.bin` | 4098 | vim, on open |
| `flood.bin` | 1488917 | `seq 1 200000` |

The machine of every number below is an Apple M-series laptop, and the browser
is Chromium through Playwright. Read the numbers as ratios, and not as
absolutes.

CAUTION: The browser rows move by a few milliseconds between runs, and the
three split rows of the flood table move by about 10 ms. Do not read a
difference of that size as a result. The differences that this file draws a
conclusion from are larger than the noise, and the text says so each time.

## The path a byte takes

```text
program --> PTY --> reader task --> command queue --> terminal thread
        --> frame queue --> pump --> WebSocket --> browser --> term.write
        --> requestAnimationFrame --> paint
```

## What the first measurement found

Three findings decided the whole plan.

**A screen clear is small.** The whole "close the editor" event is 123 bytes,
and a clear is 26 bytes. Both fit in one PTY read, so no change to the size of a
read or a queue can help them.

**A PTY gives about 1 KB per read.** `session.rs` asks for 8192 bytes. The
measurement shows that a burst of 1.5 MB arrives as 1455 reads, which is 1023
bytes each. The server sent one message per read, so a burst became 1455
messages.

**The browser paint is the largest single cost of a small event.** A clear costs
0.1 ms of parse and 6 to 10 ms of paint. The paint is linear in the cells of the
viewport, at 1.2 to 2.0 microseconds per cell, because a clear makes every row
dirty.

## The changes

1. **The terminal thread joins its queue.** After it takes one output command,
   it takes every output command that is already waiting, up to 64 KB. One
   parse and one frame then cover them all. `session.rs`, `run_terminal`.
2. **The pump joins its queue, and flushes once.** The socket is the slowest
   stage, so its queue is the longest one. The pump joins the output frames of
   that queue into one message, under the same 64 KB cap. The messages that
   remain go out under one flush, which is one syscall and not one for each
   message. `ws.rs`, `drain`.
3. **The listener sets `TCP_NODELAY`.** Nothing in the repository set it before.
   `lib.rs`, `NoDelay`.

A join never waits for more bytes. It takes only what a queue already holds, so
it cannot add latency to an event that arrives alone.

## The server: before and after

From `bench_server`, median of the runs. `first` is the time to the first
message, and `last` is the time to the last one.

| Fixture | Messages before | Messages after | `last` before | `last` after |
|---|---|---|---|---|
| `clear.bin` | 1 | 1 | 4.15 ms | 5.22 ms |
| `vim-exit.bin` | 1 | 1 | 4.28 ms | 3.95 ms |
| `vim-open.bin` | 5 | 1 | 5.13 ms | 4.33 ms |
| `flood.bin` | 1455 | 27 | 24.74 ms | 21.58 ms |

Both columns come from the same fixtures and the same listener. The `before`
column is the code without the two joins, so the table shows the joins alone.

The join of the terminal thread alone brings the flood to about 813 messages.
The join of the pump brings it to about 26.

CAUTION: The rows of a small fixture are noise. Each one holds a round trip
through the socket, the PTY, the scheduler, and an `exec` of `cat`. The `one
byte` row measures that floor at 4 to 6 ms, which is larger than the whole cost
of the event under test.

## The wire, with no process start

The `exec` above hides the wire. The round trip report removes it. It sends one
byte to a live PTY and waits for the echo of the line discipline, 500 times.

| Trips | Median | p95 | p99 |
|---|---|---|---|
| 500 | 0.056 ms | 0.076 ms | 0.092 ms |

That path holds the WebSocket both ways, the PTY both ways, the reader task, the
terminal thread, and the pump. The whole wire is therefore 56 microseconds on
loopback, which is 0.4% of the 15 ms that an editor exit costs the browser.

The protocol adds one tag byte to a message, and neither side copies to read it.
`ws.rs` gives the socket a `Vec` that it owns, and the browser takes a subarray,
which is a view. A denser wire format therefore has nothing to win. The bytes on
the wire are the PTY bytes themselves, and no format makes those smaller.

The processor cost inside the server is small, and the join did not change it.
A parse of the whole 1.5 MB flood costs 7.7 ms, an encode of it costs 0.045 ms,
and a dump of a full screen is 8298 bytes and 0.07 ms.

## The browser

`cd web && bun test bench/latency.spec.ts`, median of five runs, at the default
viewport of the test.

| Event | Bytes | Parse | Wait for the paint | Paint | Total |
|---|---|---|---|---|---|
| clear | 26 | 0.2 ms | 5.2 ms | 8.8 ms | 13.0 ms |
| vim opens | 4098 | 0.7 ms | 1.5 ms | 9.4 ms | 10.8 ms |
| vim exits | 123 | 0.2 ms | 4.9 ms | 9.1 ms | 15.3 ms |

The parse is under 1% of the cost of a small event. Of the rest, two thirds is
the paint and one quarter is the wait for the next animation frame. Neither is
code of pirate: the paint is the canvas renderer of ghostty-web, and the wait is
the frame cadence of the browser.

The same flood, sent at four message sizes. `paints` counts the full repaints
that ran while the bytes were still arriving.

| Messages | Parse | Paints | Total |
|---|---|---|---|
| 1455 | 21.4 ms | 8 | 75.7 ms |
| 182 | 22.2 ms | 7 | 67.6 ms |
| 26 | 24.1 ms | 9 | 81.2 ms |
| 1 | 24.4 ms | 0 | 30.5 ms |

The paint count is the finding. A split burst costs seven to nine full repaints
of 3.2 ms each, and all but the last show a screen that the next one replaces.
The count does not follow the message count, because the browser paints at its
own cadence of about 60 per second. It follows the time that the burst takes.

CAUTION: The one-message row is not a fair comparison. The clock starts when the
browser takes the first message, so with one message the whole transfer is
already complete. Read the first three rows against each other, and read the
last one as the floor.

## What the measurement rejected

The first plan held four more changes. The numbers removed all four.

**Send the frame before the server parses it.** The parse of a 123-byte event
costs 0.002 ms. There is nothing to win.

**Remove one of the two copies per chunk.** The encode of the whole 1.5 MB flood
costs 0.045 ms. There is nothing to win.

**Raise `READ_CHUNK` above 8192.** The PTY gives about 1 KB per read, and the
size of the read is not the bound. The join already removes the cost of the
count.

**Trim the dump.** A dump of a full 200x50 screen is 8298 bytes and 0.07 ms.
It is smaller than one joined message.

## The two parses

The word "parse" names two different things, and only one of them is large.

The **protocol** parse is one tag byte. It does not appear in any measurement,
because it costs less than the resolution of the clock.

The **VT** parse reads the escape sequences and builds the screen. It happens
twice: once in the server, and once in the browser. The server parses 1.5 MB in
7.7 ms, which is 5.3 microseconds per KB. The browser parses the same bytes in
22 ms, which is 15 microseconds per KB, because it runs as WebAssembly.

## Where the time goes

The wire is 0.4% of a small event. Everything else is in the browser.

**A small event costs 11 to 15 ms**, and the paint is 9 ms of it. The wait for
the animation frame is 2 to 5 ms, and the parse is 0.2 ms. The paint is a full
repaint at 1.2 to 2.0 microseconds per cell, because a clear and an editor exit
dirty every row.

**A flood of 1.5 MB costs 70 to 80 ms**, and it splits three ways. The parse in
WebAssembly is 21 to 24 ms. The repaints during the burst are 22 to 29 ms. The
rest is the arrival of the bytes and the turns of the event loop.

## What is left

The paint code is `CanvasRenderer` in ghostty-web, which pirate pins at 0.4.0.
That version is the newest one on the registry, so no upgrade is available.
Nothing in pirate can make one repaint cheaper.

The flood is the case that pirate can still change, and it already holds the
parts. The server parses every byte into its own terminal, and it can send the
screen instead of the stream. A dump of a full screen is 8298 bytes, against the
1.5 MB that made it. That removes the parse and every repaint but one.

CAUTION: A dump replaces the screen. The lines that scrolled off do not reach
the browser, so the user loses the scrollback of that burst. Today the server
sends a dump only after a client falls 512 KB behind, and that is the same
trade. A wider rule needs a decision about scrollback first.
