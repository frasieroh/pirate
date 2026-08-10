//! Measure the server stages of the two reported latency symptoms.
//!
//! `bench_server` measures one fixture at a time. This binary measures the two
//! events that a user reported, and it splits each one into the four stages
//! that the server holds:
//!
//! 1. **pty read** — the `read` calls on the PTY master, at the 8192-byte
//!    buffer of `session.rs`.
//! 2. **parse** — `ScreenTerminal::write`, which is the replica VT.
//! 3. **encode** — `ServerFrame::encode`, which is the tag byte and the copy.
//! 4. **transport** — a WebSocket between two tasks of this process, from the
//!    send to the receipt. See [`Loopback`].
//!
//! Run it:
//!
//! ```text
//! cargo run --release -p pirate-bench --bin bench_symptoms
//! ```
//!
//! # The two symptoms
//!
//! **Symptom 1** is a slow resize that flickers. The scenario sends a burst of
//! `RESIZE` frames of the kind that a window drag produces, against a child
//! that repaints the whole screen on `SIGWINCH`. The report gives the count of
//! messages, the bytes per message, the count of dumps, and the time from the
//! last resize frame to the last byte at the client.
//!
//! **Symptom 2** is a slow return from a full-screen program. The scenario
//! fills the primary screen, paints a full screen on the alternate screen, and
//! then replays the leave sequence of vim. The report gives the bytes and the
//! messages that the server emits for that leave.
//!
//! # What each number holds
//!
//! CAUTION: The `pty read` row holds the wait for the writer of the PTY, and
//! not the cost of the `read` call alone. Read it as the upper bound of that
//! stage. `parse`, `encode`, and `transport` hold no wait for a producer.
//!
//! CAUTION: The `pty read` row and the `transport` row are models, and not
//! measurements of pirate. The writer of [`pty_read`] is a thread that writes
//! [`READ_CHUNK`] bytes per call, so the read sizes of that row belong to that
//! writer and not to the child of the scenario. [`Loopback`] is a second
//! WebSocket server, so the `transport` row is the cost of the wire for the
//! measured message sizes and not the cost of the send path of pirate. The
//! `bytes`, `msgs`, and `dumps` columns of the two symptom tables are the only
//! numbers that come from a real pirate server.
//!
//! Every stage row is the total for the whole scenario, so the four rows add up
//! and compare directly.
//!
//! NOTE: This binary prints numbers and asserts nothing about a duration. The
//! unit tests below check byte counts and message counts only.
//!
//! # Verdicts
//!
//! The numbers below come from four runs of 2026-08-09 on an Apple M-series
//! laptop. Run the command again for the numbers of another machine.
//!
//! **Symptom 1, the slow resize.** H1 is not supported. The server turns 40
//! resize frames into 204280 bytes, and the tail from the last resize frame to
//! the last byte stays between 0.25 ms and 4.7 ms. H2 is not supported on the
//! server. A flood of 40 resize frames with no gap gives 1 to 15 messages, 2
//! repaints, and no dump, so the queue never overflows under a flood. H3 is
//! weakly supported and it is not the cause. One resync dump fired in one of
//! the four drag rows, and none fired in the other 15 rows, so a drag can
//! overflow `CLIENT_QUEUE` but it rarely does. The bytes come from the child:
//! one `SIGWINCH` gives one full repaint of 5107 bytes, and a drag of 40 steps
//! gives 40 of them. The message count of a drag varies by a factor of 2
//! between runs, because the scheduler governs how much output the join finds
//! in the queue. The `msgs` column is a median over [`RUNS`] runs, and the
//! `tail p95` column beside it gives the spread.
//!
//! **Symptom 2, the slow return from a full-screen program.** H1 is not
//! supported. The leave sequence is 123 bytes in one message, and the parse,
//! the encode, and the wire hold about 0.03 ms of it. H2 does not apply: the
//! scenario sends no resize frame. H3 holds a fault, but not one that costs
//! time on the server: `dump()` carries the active screen only, so a client
//! that resyncs after the leave gets 9674 bytes of the primary screen, and it
//! gets them in 0.2 ms to 0.6 ms.
//!
//! **Does the wire protocol hold a meaningful part of the 300 ms of symptom
//! 2?** No. The program prints the share of [`REPORTED_SYMPTOM_TWO`] that the
//! measured stages hold. That share stayed under 0.1 percent in every run.
//!
//! CAUTION: The server evidence excludes the server. It does not exclude the
//! child process, the `exec` of the shell, the redraw of the prompt, or the
//! time before the child writes the leave sequence at all. This binary starts
//! its clock when the leave sequence reaches the PTY.

use std::io::Write as _;
use std::net::SocketAddr;
use std::os::fd::AsFd as _;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as ServerMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt as _, StreamExt as _};
use pirate::protocol::{ClientFrame, ServerFrame};
use pirate::session::{CLIENT_QUEUE, OUTPUT_BATCH};
use pirate::terminal::ScreenTerminal;
use pirate_bench::harness::{
    connect, fixture_dir, next_frame, send, start, write_script, BoxError,
};
use pirate_bench::stats::{median, ms3, quantile, total};
use tokio::io::AsyncReadExt as _;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// The size that the fixtures were recorded at.
const COLS: u16 = 200;
const ROWS: u16 = 50;

/// Measurements per scenario. Nine samples put p95 on the largest one.
const RUNS: usize = 9;

/// Silence that ends one measurement.
const QUIET: Duration = Duration::from_millis(400);

/// Silence that ends the start of a scenario, before the clock runs.
const SETTLE: Duration = Duration::from_millis(300);

/// Resize frames in one burst.
///
/// A window drag of half a second at 60 Hz gives about this many.
const BURST: usize = 40;

/// The gap between two resize frames of a drag, at 60 Hz.
const DRAG_GAP: Duration = Duration::from_millis(16);

/// The gap between two resize frames of a flood. A flood has no gap.
const FLOOD_GAP: Duration = Duration::ZERO;

/// The buffer size of `read_pty_output` in `session.rs`.
const READ_CHUNK: usize = 8192;

/// The columns that a drag steps down to, from [`COLS`].
const DRAG_STEP: u16 = 40;

/// The sequence that the repaint of the test child starts with.
///
/// The count of these in one byte stream is the count of repaints.
const CLEAR: &[u8] = b"\x1b[H\x1b[2J";

/// The characters of one painted row of the test child.
const PAINT_WIDTH: usize = 100;

/// The time that the user reports for symptom 2.
///
/// This value is the report of the user. It is not a measurement, and no test
/// of this crate asserts against it. The report prints the share of it that the
/// measured stages hold.
const REPORTED_SYMPTOM_TWO: Duration = Duration::from_millis(300);

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), BoxError> {
    let dir = std::env::temp_dir().join(format!("pirate-symptoms-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;

    println!(
        "\n  server stage profile, {COLS}x{ROWS}, {RUNS} runs per row, \
         OUTPUT_BATCH {OUTPUT_BATCH} bytes, CLIENT_QUEUE {CLIENT_QUEUE} frames"
    );

    let loopback = Loopback::start().await?;
    symptom_one(&dir, &loopback).await?;
    symptom_two(&dir, &loopback).await?;

    println!();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

// --- Symptom 1: the resize storm --- //

/// What one resize burst cost.
struct Storm {
    /// Messages that arrived.
    messages: usize,
    /// Payload bytes that arrived, over every message.
    bytes: usize,
    /// Dump messages that arrived. Each one is a dropped backlog.
    dumps: usize,
    /// Repaints that the child made, from the count of [`CLEAR`].
    repaints: usize,
    /// Time from the last resize frame to the last byte at the client.
    tail: Duration,
    /// The payload bytes, in the order that they arrived.
    output: Vec<u8>,
    /// The payload size of each message.
    sizes: Vec<usize>,
}

async fn symptom_one(dir: &Path, loopback: &Loopback) -> Result<(), BoxError> {
    println!("\n  symptom 1: a resize burst against a child that repaints on SIGWINCH\n");
    println!("  one repaint of the child is {} bytes\n", paint_bytes());

    // A shell writes one line per call. vim and tmux write one repaint per
    // call. The write size of the child governs what the server has to join,
    // so the report holds both children.
    let per_line = write_script(dir, "winch-line.sh", &winch_script(false))?;
    let per_screen = write_script(dir, "winch-screen.sh", &winch_script(true))?;

    println!(
        "  {:<26} {:>8} {:>6} {:>9} {:>10} {:>6} {:>9} {:>11} {:>11}",
        "burst", "resizes", "msgs", "bytes", "bytes/msg", "dumps", "repaints", "tail", "tail p95"
    );

    let mut drags: Vec<(String, Vec<usize>)> = Vec::new();
    let mut stream = Vec::new();
    for (writer, script) in [("line writer", &per_line), ("screen writer", &per_screen)] {
        for (pace, gap) in [("drag 16 ms", DRAG_GAP), ("flood 0 ms", FLOOD_GAP)] {
            let mut runs = Vec::with_capacity(RUNS);
            for _ in 0..RUNS {
                runs.push(storm(script, gap).await?);
            }
            print_storm(&format!("{writer}, {pace}"), &runs);
            if gap == DRAG_GAP {
                let run = pick_median(runs);
                if stream.is_empty() {
                    stream = run.output.clone();
                }
                drags.push((writer.to_string(), run.sizes));
            }
        }
    }

    // The stage table follows the drag, because a drag is what the user does.
    // Both drags carry the same bytes, so one table holds both.
    let stages = stage_table(
        "symptom 1 stages, for the byte stream of one drag",
        loopback,
        &stream,
        &drags,
        &[],
    )
    .await?;
    for (name, sizes) in &drags {
        print_coalescing(name, stages.read_size, sizes);
    }
    Ok(())
}

/// Send one burst of resize frames and collect everything that comes back.
async fn storm(script: &Path, gap: Duration) -> Result<Storm, BoxError> {
    let addr = start(script.to_path_buf()).await?;
    let mut socket = connect(addr).await?;

    // The first frame of every session is a dump of an empty screen. The child
    // then paints once. Neither one is part of the measurement.
    let _ = next_frame(&mut socket, QUIET).await;
    send(
        &mut socket,
        ClientFrame::Resize {
            cols: COLS,
            rows: ROWS,
        },
    )
    .await?;
    while next_frame(&mut socket, SETTLE).await.is_some() {}

    // A browser reads while it drags, so this reader runs beside the burst.
    let (mut sink, mut stream) = socket.split();
    let reader = tokio::spawn(async move {
        let mut events: Vec<(Instant, Vec<u8>)> = Vec::new();
        loop {
            match tokio::time::timeout(QUIET, stream.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) => {
                    events.push((Instant::now(), bytes.to_vec()))
                }
                Ok(Some(Ok(_))) => {}
                _ => break,
            }
        }
        events
    });

    let mut last = Instant::now();
    for step in 0..BURST {
        let cols = if step % 2 == 0 {
            COLS - DRAG_STEP
        } else {
            COLS
        };
        let frame = ClientFrame::Resize { cols, rows: ROWS }.encode();
        sink.send(Message::binary(frame)).await?;
        last = Instant::now();
        if !gap.is_zero() {
            tokio::time::sleep(gap).await;
        }
    }

    let events = reader.await?;
    let mut storm = Storm {
        messages: 0,
        bytes: 0,
        dumps: 0,
        repaints: 0,
        tail: Duration::ZERO,
        output: Vec::new(),
        sizes: Vec::new(),
    };
    for (at, frame) in &events {
        match ServerFrame::decode(frame) {
            Ok(ServerFrame::Output(bytes)) => {
                storm.output.extend_from_slice(bytes);
                storm.sizes.push(bytes.len());
                storm.bytes += bytes.len();
                storm.messages += 1;
                storm.tail = at.saturating_duration_since(last);
            }
            Ok(ServerFrame::Dump(bytes)) => {
                storm.sizes.push(bytes.len());
                storm.bytes += bytes.len();
                storm.messages += 1;
                storm.dumps += 1;
                storm.tail = at.saturating_duration_since(last);
            }
            Ok(ServerFrame::Exit(_)) | Err(_) => {}
        }
    }
    storm.repaints = count_marks(&storm.output, CLEAR);
    Ok(storm)
}

fn print_storm(name: &str, runs: &[Storm]) {
    let tails: Vec<Duration> = runs.iter().map(|r| r.tail).collect();
    let messages = middle(runs, |r| r.messages);
    let bytes = middle(runs, |r| r.bytes);
    println!(
        "  {:<26} {:>8} {:>6} {:>9} {:>10} {:>6} {:>9} {:>11} {:>11}",
        name,
        BURST,
        messages,
        bytes,
        bytes / messages.max(1),
        middle(runs, |r| r.dumps),
        middle(runs, |r| r.repaints),
        ms3(median(&tails)),
        ms3(quantile(&tails, 0.95)),
    );
}

/// The run whose message count is the median of the list.
///
/// [`print_storm`] prints the median message count, and [`stage_table`] prints
/// the message count of this run. The same key therefore selects both, and the
/// two tables hold the same number.
fn pick_median(mut runs: Vec<Storm>) -> Storm {
    runs.sort_by_key(|r| r.messages);
    runs.swap_remove(runs.len() / 2)
}

/// A child that repaints the whole screen on `SIGWINCH`.
///
/// `stty -opost` keeps the line discipline from rewriting a newline, so the
/// child puts the bytes of the paint on the wire and not a translation of them.
/// The paint therefore carries its own carriage return.
///
/// A signal is not queued. Two `SIGWINCH` that arrive while the shell runs the
/// trap therefore give one repaint, and the count of repaints in the report is
/// the count that the child made and not the count of resize frames.
///
/// `single_write` selects the write size of the repaint. False gives one write
/// per row, which is what a shell loop does. True gives one write for the whole
/// screen, which is what vim and tmux do. Both children put the same bytes on
/// the PTY.
fn winch_script(single_write: bool) -> String {
    let line = "x".repeat(PAINT_WIDTH);
    let paint = if single_write {
        format!(
            "SCREEN=$'\\033[H\\033[2J'\n\
             i=1\n\
             while [ $i -le {ROWS} ]; do SCREEN=\"$SCREEN$LINE\"$'\\r\\n'; i=$((i+1)); done\n\
             paint() {{ printf '%s' \"$SCREEN\"; }}\n"
        )
    } else {
        format!(
            "paint() {{\n\
             \x20 printf '\\033[H\\033[2J'\n\
             \x20 i=1\n\
             \x20 while [ $i -le {ROWS} ]; do printf '%s\\r\\n' \"$LINE\"; i=$((i+1)); done\n\
             }}\n"
        )
    };
    format!(
        "#!/bin/bash\n\
         stty -opost -echo\n\
         LINE='{line}'\n\
         {paint}\
         trap paint WINCH\n\
         paint\n\
         while :; do read -r _ignored; done\n"
    )
}

/// The bytes of one repaint of the child of [`winch_script`].
fn paint_bytes() -> usize {
    CLEAR.len() + usize::from(ROWS) * (PAINT_WIDTH + 2)
}

// --- Symptom 2: the leave of the alternate screen --- //

/// What one leave of the alternate screen cost.
struct AltExit {
    /// Payload bytes that the leave produced.
    bytes: usize,
    /// Messages that the leave produced.
    messages: usize,
    /// Dump messages that the leave produced.
    dumps: usize,
    /// Time from the trigger to the first byte.
    first: Duration,
    /// Time from the trigger to the last byte.
    last: Duration,
    /// The payload size of each message.
    sizes: Vec<usize>,
    /// The bytes of a dump that a client asks for while the program holds the
    /// alternate screen.
    alternate_dump: usize,
    /// The bytes of a dump that a client asks for after the leave.
    primary_dump: usize,
    /// The round trip of that second dump request.
    dump_trip: Duration,
}

async fn symptom_two(dir: &Path, loopback: &Loopback) -> Result<(), BoxError> {
    println!("\n  symptom 2: a full-screen program leaves the alternate screen\n");

    let primary = primary_fill();
    let open = std::fs::read(fixture_dir().join("vim-open.bin"))?;
    let exit = std::fs::read(fixture_dir().join("vim-exit.bin"))?;
    std::fs::write(dir.join("primary.bin"), &primary)?;
    std::fs::write(dir.join("open.bin"), &open)?;
    std::fs::write(dir.join("exit.bin"), &exit)?;

    // The child stays alive after the leave, so that the report can ask for one
    // dump on each of the two screens.
    let script = write_script(
        dir,
        "alt-exit.sh",
        &format!(
            "#!/bin/sh\n\
             stty -opost -echo\n\
             cat {primary}\n\
             cat {open}\n\
             read -r _trigger\n\
             cat {exit}\n\
             exec sleep 30\n",
            primary = dir.join("primary.bin").display(),
            open = dir.join("open.bin").display(),
            exit = dir.join("exit.bin").display(),
        ),
    )?;

    let mut runs = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        runs.push(alt_exit(&script).await?);
    }

    println!(
        "  {:<20} {:>9} {:>9} {:>6} {:>10} {:>6} {:>11} {:>11}",
        "phase", "fed", "bytes out", "msgs", "bytes/msg", "dumps", "first", "last"
    );
    let firsts: Vec<Duration> = runs.iter().map(|r| r.first).collect();
    let lasts: Vec<Duration> = runs.iter().map(|r| r.last).collect();
    let bytes = middle(&runs, |r| r.bytes);
    let messages = middle(&runs, |r| r.messages);
    println!(
        "  {:<20} {:>9} {:>9} {:>6} {:>10} {:>6} {:>11} {:>11}",
        "leave sequence",
        exit.len(),
        bytes,
        messages,
        bytes / messages.max(1),
        middle(&runs, |r| r.dumps),
        ms3(median(&firsts)),
        ms3(median(&lasts)),
    );
    println!(
        "  {:<20} {:>9} {:>9} {:>6} {:>10} {:>6} {:>11} {:>11}",
        "leave sequence p95",
        "",
        "",
        "",
        "",
        "",
        ms3(quantile(&firsts, 0.95)),
        ms3(quantile(&lasts, 0.95)),
    );

    let trips: Vec<Duration> = runs.iter().map(|r| r.dump_trip).collect();
    println!(
        "\n  primary screen behind the program: {} bytes fed before the program started",
        primary.len()
    );
    println!(
        "  dump on the alternate screen:      {} bytes",
        middle(&runs, |r| r.alternate_dump)
    );
    println!(
        "  dump after the leave:              {} bytes, round trip {} median, {} p95",
        middle(&runs, |r| r.primary_dump),
        ms3(median(&trips)),
        ms3(quantile(&trips, 0.95)),
    );

    let profiles = vec![("the leave".to_string(), pick_sizes(&runs))];
    let mut preload = primary.clone();
    preload.extend_from_slice(&open);
    let stages = stage_table(
        "symptom 2 stages, for the leave sequence only",
        loopback,
        &exit,
        &profiles,
        &preload,
    )
    .await?;
    for (name, sizes) in &profiles {
        print_coalescing(name, stages.read_size, sizes);
    }

    // Criterion: a plain answer on the wire protocol. The share is arithmetic
    // over the medians above. It is not a threshold, and nothing asserts it.
    let held = stages.parse + stages.encode + stages.transport;
    let with_resync = held + median(&trips);
    println!(
        "\n  the user reports about {} for symptom 2",
        ms3(REPORTED_SYMPTOM_TWO)
    );
    println!(
        "  parse + encode + wire:             {} = {} of that report",
        ms3(held),
        share(held, REPORTED_SYMPTOM_TWO)
    );
    println!(
        "  the same, plus one resync dump:    {} = {} of that report",
        ms3(with_resync),
        share(with_resync, REPORTED_SYMPTOM_TWO)
    );
    println!("  the wire protocol holds no meaningful part of that report.");
    println!(
        "  CAUTION: this clock starts when the leave sequence reaches the PTY. \
         It excludes the child,\n  the exec, and the redraw of the prompt."
    );
    Ok(())
}

/// Run one leave of the alternate screen through the whole server.
async fn alt_exit(script: &Path) -> Result<AltExit, BoxError> {
    let addr = start(script.to_path_buf()).await?;
    let mut socket = connect(addr).await?;

    let _ = next_frame(&mut socket, QUIET).await;
    send(
        &mut socket,
        ClientFrame::Resize {
            cols: COLS,
            rows: ROWS,
        },
    )
    .await?;
    // The child fills the primary screen and then paints the alternate screen.
    while next_frame(&mut socket, SETTLE).await.is_some() {}

    // What a resync costs while the program holds the alternate screen.
    send(&mut socket, ClientFrame::Dump).await?;
    let alternate_dump = dump_size(&mut socket).await?;
    while next_frame(&mut socket, SETTLE).await.is_some() {}

    let started = Instant::now();
    send(&mut socket, ClientFrame::Input(b"go\n")).await?;

    let mut exit = AltExit {
        bytes: 0,
        messages: 0,
        dumps: 0,
        first: Duration::ZERO,
        last: Duration::ZERO,
        sizes: Vec::new(),
        alternate_dump,
        primary_dump: 0,
        dump_trip: Duration::ZERO,
    };
    while let Some(frame) = next_frame(&mut socket, QUIET).await {
        let at = started.elapsed();
        let payload = match ServerFrame::decode(&frame) {
            Ok(ServerFrame::Output(bytes)) => bytes.len(),
            Ok(ServerFrame::Dump(bytes)) => {
                exit.dumps += 1;
                bytes.len()
            }
            Ok(ServerFrame::Exit(_)) | Err(_) => break,
        };
        if exit.messages == 0 {
            exit.first = at;
        }
        exit.messages += 1;
        exit.bytes += payload;
        exit.sizes.push(payload);
        exit.last = at;
    }

    // What a resync costs after the leave, and how long the answer takes.
    let at = Instant::now();
    send(&mut socket, ClientFrame::Dump).await?;
    exit.primary_dump = dump_size(&mut socket).await?;
    exit.dump_trip = at.elapsed();
    Ok(exit)
}

/// The payload size of the next dump frame.
async fn dump_size(socket: &mut pirate_bench::harness::Socket) -> Result<usize, BoxError> {
    while let Some(frame) = next_frame(socket, QUIET).await {
        if let Ok(ServerFrame::Dump(bytes)) = ServerFrame::decode(&frame) {
            return Ok(bytes.len());
        }
    }
    Err("no dump came back".into())
}

/// A full primary screen, of the kind that a shell leaves behind it.
///
/// The rows carry an explicit carriage return, because the child of this
/// scenario runs with `stty -opost`.
fn primary_fill() -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"\x1b[?1049l\x1b[H\x1b[2J");
    for row in 1..=ROWS {
        let text = format!(
            "{row:>4}  the quick brown fox jumps over the lazy dog, and then it does it again"
        );
        out.extend_from_slice(text.as_bytes());
        if row < ROWS {
            out.extend_from_slice(b"\r\n");
        }
    }
    out
}

/// The message sizes of the run whose byte count is the median.
fn pick_sizes(runs: &[AltExit]) -> Vec<usize> {
    let mut sorted: Vec<&AltExit> = runs.iter().collect();
    sorted.sort_by_key(|r| r.bytes);
    sorted[sorted.len() / 2].sizes.clone()
}

// --- The four stages --- //

/// The medians of one stage table.
struct Stages {
    /// Bytes per read that the PTY gave for this byte stream.
    read_size: usize,
    /// The median of the parse stage.
    parse: Duration,
    /// The median of the encode stage.
    encode: Duration,
    /// The median of the transport stage of the first profile.
    transport: Duration,
}

/// Print one stage table, and give back its medians.
async fn stage_table(
    title: &str,
    loopback: &Loopback,
    stream: &[u8],
    profiles: &[(String, Vec<usize>)],
    preload: &[u8],
) -> Result<Stages, BoxError> {
    let mut reads = Vec::with_capacity(RUNS);
    let mut chunks: Vec<usize> = Vec::new();
    for _ in 0..RUNS {
        let (time, sizes_of_reads) = pty_read(stream).await?;
        reads.push(time);
        chunks = sizes_of_reads;
    }

    let pieces = split(stream, &chunks);
    let mut parse = Vec::with_capacity(RUNS);
    let mut encode = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let mut terminal = ScreenTerminal::new(COLS, ROWS)?;
        terminal.write(preload);

        let at = Instant::now();
        for piece in &pieces {
            terminal.write(piece);
        }
        parse.push(at.elapsed());

        let at = Instant::now();
        for piece in &pieces {
            std::hint::black_box(ServerFrame::Output(piece).encode());
        }
        encode.push(at.elapsed());
    }

    let mut transports = Vec::with_capacity(profiles.len());
    for (name, sizes) in profiles {
        let mut samples = Vec::with_capacity(RUNS);
        for _ in 0..RUNS {
            samples.push(loopback.time(sizes).await?);
        }
        transports.push((name, sizes, samples));
    }

    println!("\n  {title}\n");
    println!(
        "  {:<26} {:>9} {:>7} {:>11} {:>11}",
        "stage", "bytes", "calls", "median", "p95"
    );
    let mean = if chunks.is_empty() {
        0
    } else {
        stream.len() / chunks.len()
    };
    row("pty read", stream.len(), chunks.len(), &reads);
    row("parse", stream.len(), pieces.len(), &parse);
    row("encode", stream.len(), pieces.len(), &encode);
    for (name, sizes, samples) in &transports {
        row(
            &format!("transport, {name}"),
            sizes.iter().sum(),
            sizes.len(),
            samples,
        );
    }
    println!("  the PTY gave {mean} bytes per read");
    Ok(Stages {
        read_size: mean,
        parse: median(&parse),
        encode: median(&encode),
        transport: transports
            .first()
            .map_or(Duration::ZERO, |(_, _, samples)| median(samples)),
    })
}

fn row(name: &str, bytes: usize, calls: usize, values: &[Duration]) {
    println!(
        "  {:<26} {:>9} {:>7} {:>11} {:>11}",
        name,
        bytes,
        calls,
        ms3(median(values)),
        ms3(quantile(values, 0.95)),
    );
}

/// State whether the two joins fired, and whether they reached their limit.
///
/// The join at `session.rs:480` and the join at `ws.rs:146` both collect until
/// the frame holds [`OUTPUT_BATCH`] bytes. One PTY read is the smallest frame
/// that either join can emit, so a message that is larger than one read proves
/// that a join fired. A message that reaches [`OUTPUT_BATCH`] proves that a
/// join ran to its limit.
///
/// `read_size` is the bytes per read of the same byte stream, from
/// [`pty_read`]. `sizes` are the message sizes of a real pirate server.
fn print_coalescing(name: &str, read_size: usize, sizes: &[usize]) {
    let messages = sizes.len();
    let bytes: usize = sizes.iter().sum();
    let largest = sizes.iter().copied().max().unwrap_or(0);
    let (fired, at_limit) = coalescing_verdict(read_size, sizes);
    println!(
        "  coalescing, {name}: {messages} messages, {} bytes each, largest {largest} bytes, \
         one pty read is {read_size} bytes",
        bytes / messages.max(1)
    );
    println!(
        "  coalescing, {name}: the join fires: {fired}; \
         the join reaches its {OUTPUT_BATCH}-byte limit: {at_limit}"
    );
}

/// Whether a join fired, and whether a join reached [`OUTPUT_BATCH`].
///
/// The verdict is a function of the message sizes of the server run and of the
/// size of one PTY read. It uses no count from another scenario.
fn coalescing_verdict(read_size: usize, sizes: &[usize]) -> (&'static str, &'static str) {
    let largest = sizes.iter().copied().max().unwrap_or(0);
    let fired = if sizes.is_empty() {
        "unknown, because no message arrived"
    } else if read_size == 0 {
        "unknown, because no pty read was measured"
    } else if largest > read_size {
        "yes"
    } else {
        "no, because no message is larger than one pty read"
    };
    let at_limit = if largest >= OUTPUT_BATCH { "yes" } else { "no" };
    (fired, at_limit)
}

/// The share of `whole` that `part` holds, as a percentage.
fn share(part: Duration, whole: Duration) -> String {
    if whole.is_zero() {
        return "n/a".to_string();
    }
    let percent = part.as_secs_f64() / whole.as_secs_f64() * 100.0;
    format!("{percent:.3} percent")
}

/// The time inside the `read` calls of a PTY master, for one byte stream.
///
/// A thread writes the stream into the slave as fast as the buffer takes it,
/// and this function reads the master into a buffer of [`READ_CHUNK`] bytes,
/// which is the buffer of `read_pty_output`.
///
/// CAUTION: The result holds the wait for that writer. It is the upper bound of
/// this stage and not the cost of the `read` call alone.
///
/// A child holds the slave open and runs `stty` on it, so that the line
/// discipline puts the bytes of the stream on the master and not a translation
/// of them. That child then writes one marker byte and sleeps: a PTY master
/// reports the end of the output when the last process of the terminal ends,
/// so the child must outlive the measurement.
async fn pty_read(stream: &[u8]) -> Result<(Duration, Vec<usize>), BoxError> {
    let (pty, pts) = pty_process::open()?;
    pty.resize(pty_process::Size::new(ROWS, COLS))?;

    let slave = std::fs::File::from(pts.as_fd().try_clone_to_owned()?);
    let _child = pty_process::Command::new("/bin/sh")
        .args(["-c", "stty -opost -echo; printf R; exec sleep 30"])
        .kill_on_drop(true)
        .spawn(pts)?;

    let (mut master, _write) = pty.into_split();

    // The marker says that `stty` is applied. The clock starts after it.
    let mut mark = [0_u8; 1];
    loop {
        if master.read(&mut mark).await? == 1 && mark[0] == b'R' {
            break;
        }
    }

    let bytes = stream.to_vec();
    let writer = std::thread::spawn(move || {
        let mut slave = slave;
        for chunk in bytes.chunks(READ_CHUNK) {
            if slave.write_all(chunk).is_err() {
                return;
            }
        }
        let _ = slave.flush();
    });

    let mut buf = vec![0_u8; READ_CHUNK];
    let mut sizes = Vec::new();
    let mut times = Vec::new();
    let mut seen = 0;
    while seen < stream.len() {
        let at = Instant::now();
        let n = master.read(&mut buf).await?;
        times.push(at.elapsed());
        if n == 0 {
            break;
        }
        sizes.push(n);
        seen += n;
    }
    let _ = writer.join();
    Ok((total(&times), sizes))
}

/// Cut a byte stream at the sizes that the PTY gave.
fn split<'a>(stream: &'a [u8], sizes: &[usize]) -> Vec<&'a [u8]> {
    let mut out = Vec::with_capacity(sizes.len());
    let mut at = 0;
    for size in sizes {
        let end = (at + size).min(stream.len());
        out.push(&stream[at..end]);
        at = end;
    }
    if at < stream.len() {
        out.push(&stream[at..]);
    }
    out
}

// --- The transport stage --- //

/// The send times of the loopback server, in the order that it sent them.
#[derive(Default)]
struct Sent(Mutex<Vec<Instant>>);

/// One WebSocket server that answers a size with a message of that size.
///
/// This server and its client are in one process, so one clock stamps the send
/// and the receipt. The client asks for one message at a time, so no message
/// waits behind another one.
struct Loopback {
    addr: SocketAddr,
    sent: Arc<Sent>,
}

impl Loopback {
    async fn start() -> Result<Self, BoxError> {
        let sent = Arc::new(Sent::default());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let app = Router::new()
            .route("/ws", any(upgrade))
            .with_state(Arc::clone(&sent));
        tokio::spawn(async move {
            let _ = axum::serve(pirate::NoDelay(listener), app).await;
        });
        Ok(Self { addr, sent })
    }

    /// The total one-way time for a list of message sizes.
    async fn time(&self, sizes: &[usize]) -> Result<Duration, BoxError> {
        self.sent
            .0
            .lock()
            .map_err(|_| "the clock is poisoned")?
            .clear();
        let mut socket = connect(self.addr).await?;
        let mut received = Vec::with_capacity(sizes.len());
        for size in sizes {
            let request = u32::try_from(*size)?.to_be_bytes().to_vec();
            socket.send(Message::binary(request)).await?;
            if next_frame(&mut socket, Duration::from_secs(5))
                .await
                .is_none()
            {
                return Err("the loopback server sent nothing".into());
            }
            received.push(Instant::now());
        }
        let sent = self.sent.0.lock().map_err(|_| "the clock is poisoned")?;
        let mut times = Vec::with_capacity(received.len());
        for (at, start) in received.iter().zip(sent.iter()) {
            times.push(at.saturating_duration_since(*start));
        }
        Ok(total(&times))
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(sent): State<Arc<Sent>>) -> Response {
    ws.on_upgrade(move |socket| answer(socket, sent))
}

async fn answer(mut socket: WebSocket, sent: Arc<Sent>) {
    while let Some(Ok(message)) = socket.recv().await {
        let ServerMessage::Binary(request) = message else {
            continue;
        };
        let Ok(size) = <[u8; 4]>::try_from(&request[..]) else {
            continue;
        };
        let payload = vec![0_u8; u32::from_be_bytes(size) as usize];
        {
            let Ok(mut times) = sent.0.lock() else { return };
            times.push(Instant::now());
        }
        if socket
            .send(ServerMessage::Binary(payload.into()))
            .await
            .is_err()
        {
            return;
        }
    }
}

// --- Small helpers --- //

/// The median of one count over a list of runs.
fn middle<T>(runs: &[T], pick: fn(&T) -> usize) -> usize {
    let mut values: Vec<usize> = runs.iter().map(pick).collect();
    values.sort_unstable();
    values[values.len() / 2]
}

/// The count of one marker in a byte stream.
fn count_marks(stream: &[u8], mark: &[u8]) -> usize {
    if mark.is_empty() || stream.len() < mark.len() {
        return 0;
    }
    stream.windows(mark.len()).filter(|w| *w == mark).count()
}

#[cfg(test)]
mod tests {
    use super::{
        coalescing_verdict, count_marks, paint_bytes, primary_fill, share, split, winch_script,
        CLEAR, COLS, PAINT_WIDTH, REPORTED_SYMPTOM_TWO, ROWS,
    };
    use pirate::session::OUTPUT_BATCH;
    use pirate_bench::harness::fixture_dir;
    use std::time::Duration;

    #[test]
    fn the_coalescing_verdict_reads_the_message_sizes_and_not_a_foreign_count() {
        // The screen writer of symptom 1: 189 messages of about 1080 bytes,
        // against a pty read of 1021 bytes. The join fires, and it stays far
        // from its limit.
        let sizes = vec![1080_usize; 189];
        assert_eq!(coalescing_verdict(1021, &sizes), ("yes", "no"));

        // The same server behavior, judged against a larger read. The join
        // did not gather more than one read, so the verdict must say no.
        assert_eq!(
            coalescing_verdict(2048, &sizes).0,
            "no, because no message is larger than one pty read"
        );

        // The line writer: every message is smaller than one pty read.
        assert_eq!(
            coalescing_verdict(1021, &vec![264_usize; 773]).0,
            "no, because no message is larger than one pty read"
        );
    }

    #[test]
    fn the_coalescing_verdict_holds_at_the_edges() {
        assert_eq!(
            coalescing_verdict(1021, &[]).0,
            "unknown, because no message arrived"
        );
        assert_eq!(
            coalescing_verdict(0, &[10]).0,
            "unknown, because no pty read was measured"
        );
        // A message that reaches the batch limit ran the join to its end.
        assert_eq!(coalescing_verdict(1021, &[OUTPUT_BATCH]), ("yes", "yes"));
        assert_eq!(coalescing_verdict(1021, &[OUTPUT_BATCH - 1]), ("yes", "no"));
    }

    #[test]
    fn the_share_of_the_reported_time_is_a_percentage() {
        assert_eq!(
            share(Duration::from_millis(3), REPORTED_SYMPTOM_TWO),
            "1.000 percent"
        );
        assert_eq!(
            share(Duration::from_micros(50), REPORTED_SYMPTOM_TWO),
            "0.017 percent"
        );
        assert_eq!(share(Duration::from_millis(1), Duration::ZERO), "n/a");
    }

    #[test]
    fn the_marker_count_finds_every_repaint() {
        let mut stream = Vec::new();
        for _ in 0..3 {
            stream.extend_from_slice(CLEAR);
            stream.extend_from_slice(b"some rows");
        }
        assert_eq!(count_marks(&stream, CLEAR), 3);
        assert_eq!(count_marks(b"", CLEAR), 0);
        assert_eq!(count_marks(b"ab", CLEAR), 0);
    }

    #[test]
    fn one_repaint_of_the_child_is_the_size_that_the_report_states() {
        // 7 bytes of clear, then one row of PAINT_WIDTH characters and a
        // carriage return pair, for each row.
        assert_eq!(paint_bytes(), 7 + usize::from(ROWS) * (PAINT_WIDTH + 2));
    }

    #[test]
    fn both_children_paint_every_row_and_trap_the_signal() {
        for single_write in [false, true] {
            let script = winch_script(single_write);
            assert!(script.contains("trap paint WINCH"), "{script}");
            assert!(script.contains(&format!("-le {ROWS}")), "{script}");
            assert!(script.contains("stty -opost -echo"), "{script}");
        }
    }

    #[test]
    fn the_two_children_differ_in_the_write_size_only() {
        let per_line = winch_script(false);
        let per_screen = winch_script(true);
        assert!(
            per_line.contains("printf '%s\\r\\n'"),
            "the line writer writes one row per call: {per_line}"
        );
        assert!(
            per_screen.contains("printf '%s' \"$SCREEN\""),
            "the screen writer writes the whole screen in one call: {per_screen}"
        );
    }

    #[test]
    fn the_primary_fill_covers_the_screen_and_leaves_the_alternate_one() {
        let fill = primary_fill();
        assert!(fill.starts_with(b"\x1b[?1049l"));
        assert_eq!(
            count_marks(&fill, b"\r\n"),
            usize::from(ROWS) - 1,
            "one line break between the rows, and none after the last row"
        );
        assert!(
            fill.len() > usize::from(ROWS) * usize::from(COLS) / 4,
            "the fill must carry text on every row"
        );
    }

    #[test]
    fn the_two_fixtures_of_symptom_two_hold_the_alternate_screen_switch() {
        let open = std::fs::read(fixture_dir().join("vim-open.bin")).unwrap();
        let exit = std::fs::read(fixture_dir().join("vim-exit.bin")).unwrap();
        assert!(
            count_marks(&open, b"\x1b[?1049h") == 1,
            "vim-open.bin must enter the alternate screen one time"
        );
        assert!(
            count_marks(&exit, b"\x1b[?1049l") == 1,
            "vim-exit.bin must leave the alternate screen one time"
        );
    }

    #[test]
    fn the_split_keeps_every_byte_and_the_chunk_sizes() {
        let stream = b"abcdefghij";
        let pieces = split(stream, &[3, 3]);
        assert_eq!(pieces, vec![&b"abc"[..], &b"def"[..], &b"ghij"[..]]);
        let joined: Vec<u8> = pieces.concat();
        assert_eq!(joined, stream);
    }
}
