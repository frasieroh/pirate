# Benchmark

## How to measure

```text
cargo run --release -p pirate-bench --bin record_fixtures
cargo run --release -p pirate-bench --bin bench_server
cd web && bun test bench/latency.spec.ts
```

## Fixtures

Fixtures are in `crates/pirate-bench/fixtures/`.

| Fixture | Bytes | What wrote it |
|---|---|---|
| `clear.bin` | 26 | `clear` |
| `vim-exit.bin` | 123 | vim, on `:q!` |
| `vim-open.bin` | 4098 | vim, on open |
| `flood.bin` | 1488917 | `seq 1 200000` |

The machine for every number below is an Apple M-series laptop. The browser is Chromium through Playwright.

## The server

From `bench_server`, median of the runs. `last` is the time to the last message.

| Fixture | Messages | `last` |
|---|---|---|
| `clear.bin` | 1 | 5.22 ms |
| `vim-exit.bin` | 1 | 3.95 ms |
| `vim-open.bin` | 1 | 4.33 ms |
| `flood.bin` | 27 | 21.58 ms |

## RTT

One byte to a live PTY, and the echo of the line discipline, 500 times.

| Trips | Median | p95 | p99 |
|---|---|---|---|
| 500 | 0.056 ms | 0.076 ms | 0.092 ms |

## Server processing

| Operation | Cost |
|---|---|
| Parse of the 1.5 MB flood | 7.7 ms |
| Encode of the 1.5 MB flood | 0.045 ms |
| Dump of a full 200x50 screen | 8298 bytes, 0.07 ms |

## Browser

`cd web && bun test bench/latency.spec.ts`, median of five runs, at the default viewport of the test.

| Event | Bytes | Parse | Wait for the paint | Paint | Total |
|---|---|---|---|---|---|
| clear | 26 | 0.2 ms | 5.2 ms | 8.8 ms | 13.0 ms |
| vim opens | 4098 | 0.7 ms | 1.5 ms | 9.4 ms | 10.8 ms |
| vim exits | 123 | 0.2 ms | 4.9 ms | 9.1 ms | 15.3 ms |

The same flood, sent at four message sizes. `paints` counts the full repaints that ran while the bytes were still arriving.

| Messages | Parse | Paints | Total |
|---|---|---|---|
| 1455 | 21.4 ms | 8 | 75.7 ms |
| 182 | 22.2 ms | 7 | 67.6 ms |
| 26 | 24.1 ms | 9 | 81.2 ms |
| 1 | 24.4 ms | 0 | 30.5 ms |
