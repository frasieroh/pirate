//! Measure what the server adds between a PTY byte and a WebSocket byte.
//!
//! The browser tests in `web/bench/latency.spec.ts` measure the other half.
//! This example measures this half, through the real path: a real listener, a
//! real WebSocket, a real PTY, and the real terminal thread.
//!
//! Run it after the recorder:
//!
//! ```text
//! cargo run --release -p pirate-bench --bin record_fixtures
//! cargo run --release -p pirate-bench --bin bench_server
//! ```
//!
//! # The three reports
//!
//! **Pipeline** is the processor cost of the server itself: the parse into the
//! server-side terminal, and the encode of one frame. It uses no PTY and no
//! socket, so it holds no scheduler noise.
//!
//! **Round trip** sends one byte to a live PTY and waits for the echo of the
//! line discipline. It starts no process, so it is the cost of the wire itself.
//!
//! **End to end** replays a fixture through everything. The child of the PTY is
//! a script that waits for one line, and then writes one fixture with `cat`.
//! The clock starts when the client sends that line.
//!
//! CAUTION: The `first` column of the second report holds one round trip
//! through the socket, the PTY, the process scheduler, and an `exec` of `cat`.
//! That `exec` is milliseconds on its own, and it is not a cost of pirate. Read
//! the `one byte` row as the floor of that column, and read the `pipeline`
//! report for the cost that pirate adds.

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use pirate::protocol::{ClientFrame, ServerFrame};
use pirate::terminal::ScreenTerminal;
use pirate::{router, AppState};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Silence that ends one measurement.
const QUIET: Duration = Duration::from_millis(400);

/// Measurements per scenario. The report gives the median.
const REPEATS: usize = 5;

/// The size that the fixtures were recorded at.
const COLS: u16 = 200;
const ROWS: u16 = 50;

/// Bytes that one read of a real PTY gives back.
///
/// `session.rs` asks for 8192. The end-to-end report shows that a PTY on this
/// system gives about an eighth of that, so the pipeline report uses the size
/// that the measurement found and not the size that the code asks for.
const PTY_CHUNK: usize = 1024;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What one replay of one fixture cost.
struct Sample {
    /// Bytes that the fixture holds.
    sent: usize,
    /// Bytes that arrived, over every frame.
    received: usize,
    /// Frames that arrived.
    frames: usize,
    /// Dump frames that arrived. Each one is a dropped backlog.
    dumps: usize,
    /// Time from the trigger to the first frame.
    first: Duration,
    /// Time from the trigger to the last frame.
    last: Duration,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("pirate-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;

    // A one-byte fixture. Its row is the cost of the round trip itself, and
    // every other row includes that cost.
    std::fs::write(dir.join("one-byte.bin"), b"x")?;

    let mut scenarios: Vec<(String, PathBuf)> =
        vec![("one byte".to_string(), dir.join("one-byte.bin"))];
    for name in ["clear.bin", "vim-exit.bin", "vim-open.bin", "flood.bin"] {
        let path = fixture_dir().join(name);
        if !path.is_file() {
            return Err(format!(
                "{} is missing. Run `cargo run --release -p pirate-bench --bin record_fixtures` first.",
                path.display()
            )
            .into());
        }
        scenarios.push((name.trim_end_matches(".bin").to_string(), path));
    }

    pipeline_report(&scenarios)?;
    round_trip_report().await?;

    println!("\n  end to end: a real PTY, a real socket, and one `exec` per row\n");
    println!(
        "  {:<12} {:>10} {:>10} {:>8} {:>9} {:>7} {:>11} {:>11}",
        "scenario", "sent", "received", "frames", "bytes/fr", "dumps", "first", "last"
    );

    for (name, path) in &scenarios {
        let mut samples = Vec::with_capacity(REPEATS);
        for _ in 0..REPEATS {
            samples.push(replay(&dir, name, path).await?);
        }
        print_row(name, &samples);
    }

    println!();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// The processor cost that the server itself adds, with no PTY and no socket.
///
/// Each fixture goes in at [`PTY_CHUNK`] bytes per pass, because that is the
/// size that a real PTY delivers. A chunked parse costs more than one large
/// parse, so this is the honest number.
fn pipeline_report(scenarios: &[(String, PathBuf)]) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n  pipeline: the processor cost inside the server, with no PTY and no socket\n");
    println!(
        "  {:<12} {:>10} {:>7} {:>11} {:>11} {:>11} {:>11}",
        "scenario", "bytes", "chunks", "parse", "encode", "dump bytes", "dump"
    );

    for (name, path) in scenarios {
        let bytes = std::fs::read(path)?;
        let chunks: Vec<&[u8]> = bytes.chunks(PTY_CHUNK).collect();
        let mut parse = Vec::with_capacity(REPEATS);
        let mut encode = Vec::with_capacity(REPEATS);
        let mut dumped = Vec::with_capacity(REPEATS);
        let mut dump_size = 0;

        for _ in 0..REPEATS {
            // A fresh terminal each pass, so every pass starts from one screen.
            let mut terminal = ScreenTerminal::new(COLS, ROWS)?;

            let at = Instant::now();
            for chunk in &chunks {
                terminal.write(chunk);
            }
            parse.push(at.elapsed());

            let at = Instant::now();
            for chunk in &chunks {
                std::hint::black_box(ServerFrame::Output(chunk).encode());
            }
            encode.push(at.elapsed());

            let at = Instant::now();
            let dump = terminal.dump()?;
            dumped.push(at.elapsed());
            dump_size = dump.len();
        }

        println!(
            "  {:<12} {:>10} {:>7} {:>11} {:>11} {:>11} {:>11}",
            name,
            bytes.len(),
            chunks.len(),
            millis(&parse),
            millis(&encode),
            dump_size,
            millis(&dumped),
        );
    }
    Ok(())
}

/// Keystrokes that the round trip report sends.
const ROUND_TRIPS: usize = 500;

/// The cost of one keystroke, with no `exec` and no program in the path.
///
/// One byte goes to the PTY master. The line discipline of the kernel sends it
/// back, and it returns over the same socket. The path therefore holds the
/// WebSocket both ways, the PTY both ways, the reader task, the terminal
/// thread, and the pump. It holds no process start.
///
/// This value is the floor of every event in the report above it, and it is the
/// only number that shows what the wire itself costs.
async fn round_trip_report() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n  round trip: one byte to the PTY and back, with no `exec`\n");

    let addr = start(PathBuf::from("/bin/cat")).await?;
    let mut socket = connect(addr).await?;
    // The first frame of a session is the dump. Take it before the clock runs.
    next_frame(&mut socket, Duration::from_secs(5)).await;

    let mut samples = Vec::with_capacity(ROUND_TRIPS);
    for _ in 0..ROUND_TRIPS {
        let at = Instant::now();
        send(&mut socket, ClientFrame::Input(b"x")).await?;
        if next_frame(&mut socket, Duration::from_secs(5))
            .await
            .is_none()
        {
            return Err("the echo never came back".into());
        }
        samples.push(at.elapsed());
    }

    let mut micros: Vec<u128> = samples.iter().map(Duration::as_micros).collect();
    micros.sort_unstable();
    #[allow(clippy::cast_precision_loss)]
    let at = |q: f64| -> String {
        let index = ((micros.len() as f64 - 1.0) * q).round() as usize;
        format!("{:.3} ms", micros[index] as f64 / 1000.0)
    };
    println!(
        "  {:<12} {:>11} {:>11} {:>11}",
        "trips", "median", "p95", "p99"
    );
    println!(
        "  {:<12} {:>11} {:>11} {:>11}",
        ROUND_TRIPS,
        at(0.5),
        at(0.95),
        at(0.99)
    );
    Ok(())
}

/// The median of a list of durations, as a string in milliseconds.
fn millis(values: &[Duration]) -> String {
    let mut micros: Vec<u128> = values.iter().map(Duration::as_micros).collect();
    micros.sort_unstable();
    #[allow(clippy::cast_precision_loss)]
    let ms = micros[micros.len() / 2] as f64 / 1000.0;
    format!("{ms:.3} ms")
}

/// Replay one fixture through the whole server, once.
async fn replay(
    dir: &Path,
    name: &str,
    fixture: &Path,
) -> Result<Sample, Box<dyn std::error::Error>> {
    // `-opost` keeps the line discipline from rewriting a newline, so the
    // replay puts the recorded bytes on the wire and not a translation of them.
    // `-echo` keeps the trigger line out of the output.
    let script = write_script(
        dir,
        &format!("replay-{name}.sh"),
        &format!(
            "#!/bin/sh\nstty -opost -echo\nread -r _trigger\nexec cat {}\n",
            fixture.display()
        ),
    )?;

    let addr = start(script).await?;
    let mut socket = connect(addr).await?;

    // The first frame of every session is the dump of an empty screen. It is
    // not part of any measurement.
    let _ = next_frame(&mut socket, QUIET).await;
    send(
        &mut socket,
        ClientFrame::Resize {
            cols: COLS,
            rows: ROWS,
        },
    )
    .await?;

    // Give the script time to reach its `read`. A trigger that arrives before
    // it would measure the start of a shell instead of the replay.
    tokio::time::sleep(Duration::from_millis(250)).await;

    let started = Instant::now();
    send(&mut socket, ClientFrame::Input(b"go\n")).await?;

    let mut sample = Sample {
        sent: std::fs::metadata(fixture)?.len() as usize,
        received: 0,
        frames: 0,
        dumps: 0,
        first: Duration::ZERO,
        last: Duration::ZERO,
    };

    while let Some(frame) = next_frame(&mut socket, QUIET).await {
        let at = started.elapsed();
        match ServerFrame::decode(&frame) {
            Ok(ServerFrame::Output(bytes)) => {
                if sample.frames == 0 {
                    sample.first = at;
                }
                sample.frames += 1;
                sample.received += bytes.len();
                sample.last = at;
            }
            Ok(ServerFrame::Dump(bytes)) => {
                if sample.frames == 0 {
                    sample.first = at;
                }
                sample.frames += 1;
                sample.dumps += 1;
                sample.received += bytes.len();
                sample.last = at;
            }
            // The shell ended after `cat`. Nothing follows it.
            Ok(ServerFrame::Exit(_)) | Err(_) => break,
        }
    }

    Ok(sample)
}

/// Print the median of every column.
fn print_row(name: &str, samples: &[Sample]) {
    let median = |mut values: Vec<u128>| -> u128 {
        values.sort_unstable();
        values[values.len() / 2]
    };
    let micros = |pick: fn(&Sample) -> Duration| -> String {
        let value = median(samples.iter().map(|s| pick(s).as_micros()).collect());
        #[allow(clippy::cast_precision_loss)]
        let ms = value as f64 / 1000.0;
        format!("{ms:.2} ms")
    };
    let count = |pick: fn(&Sample) -> usize| -> u128 {
        median(samples.iter().map(|s| pick(s) as u128).collect())
    };

    let frames = count(|s| s.frames);
    let received = count(|s| s.received);
    println!(
        "  {:<12} {:>10} {:>10} {:>8} {:>9} {:>7} {:>11} {:>11}",
        name,
        samples[0].sent,
        received,
        frames,
        received / frames.max(1),
        count(|s| s.dumps),
        micros(|s| s.first),
        micros(|s| s.last),
    );
}

// --- The server and the socket --- //

async fn start(shell: PathBuf) -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let state = Arc::new(AppState::plain(None, shell));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(pirate::NoDelay(listener), router(state)).await;
    });
    Ok(addr)
}

/// Open one WebSocket to `/ws`.
///
/// `/ws` answers 403 when the `Origin` header is absent, and `connect_async` on
/// a URL sends no such header. This function therefore builds the request, with
/// the five WebSocket headers that tungstenite writes from the map.
async fn connect(addr: SocketAddr) -> Result<Socket, Box<dyn std::error::Error>> {
    let request = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws"))
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", format!("http://{addr}"))
        .body(())?;
    let (socket, _) = tokio_tungstenite::connect_async(request).await?;
    Ok(socket)
}

async fn send(
    socket: &mut Socket,
    frame: ClientFrame<'_>,
) -> Result<(), Box<dyn std::error::Error>> {
    socket.send(Message::binary(frame.encode())).await?;
    Ok(())
}

/// The next binary frame, or None when the stream stays quiet for `quiet`.
async fn next_frame(socket: &mut Socket, quiet: Duration) -> Option<Vec<u8>> {
    loop {
        match tokio::time::timeout(quiet, socket.next()).await {
            Err(_) | Ok(None) | Ok(Some(Err(_))) => return None,
            Ok(Some(Ok(Message::Binary(bytes)))) => return Some(bytes.to_vec()),
            Ok(Some(Ok(_))) => {}
        }
    }
}

fn write_script(dir: &Path, name: &str, body: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    std::fs::write(&path, body)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

/// `crates/pirate-bench/fixtures`, from the manifest directory of this crate.
fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}
