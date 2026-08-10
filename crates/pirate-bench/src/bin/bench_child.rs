//! Measure the child process alone, on a bare PTY, with no pirate in the path.
//!
//! `web/bench/whole-path.e2e.ts` measures the whole path: a real browser, a
//! real pirate server, and the same child. That measurement cannot separate
//! the think time of the child from the cost of pirate, because the browser
//! sees one arrival and not two events. This program supplies the missing
//! half. It opens a PTY, starts the same child, presses the same key, and
//! reports the time until the child writes. Nothing of pirate runs in that
//! path.
//!
//! The difference of the two totals is the cost that pirate adds.
//!
//! Run it:
//!
//! ```text
//! cargo run --release -p pirate-bench --bin bench_child -- editor 7
//! cargo run --release -p pirate-bench --bin bench_child -- pager 7
//! cargo run --release -p pirate-bench --bin bench_child -- minimal 7
//! ```
//!
//! The first argument names the child. `editor` starts a real editor, `pager`
//! starts a real pager, and `minimal` is a shell script that leaves the
//! alternate screen at once. The second argument is the number of runs.
//!
//! # The two reports
//!
//! **exit** presses the key that closes the full-screen program. This is
//! symptom 2.
//!
//! **resize** changes the size of the PTY, which sends `SIGWINCH` to the
//! child. This is the child half of symptom 1.
//!
//! Each report holds two times. `think` is the time from the key to the first
//! byte that the child writes. `burst` is the time from the key to the last
//! byte of the answer, where the end of the answer is `QUIET` of silence.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// The size of the PTY. It matches the viewport of the browser benchmark.
const COLS: u16 = 109;
const ROWS: u16 = 38;

/// The second size of the resize report.
const NARROW_COLS: u16 = 96;
const NARROW_ROWS: u16 = 32;

/// Silence that ends one measurement.
const QUIET: Duration = Duration::from_millis(150);

/// The limit of one measurement. A child that says nothing ends the program.
const PATIENCE: Duration = Duration::from_secs(20);

/// The limit of the resize measurement.
///
/// A child that ignores `SIGWINCH` writes nothing here, and that is a result.
/// This limit is short, so the report arrives.
const RESIZE_PATIENCE: Duration = Duration::from_secs(6);

/// Runs per report, when the command line gives no count.
const DEFAULT_RUNS: usize = 7;

/// The mark that the child draws on the alternate screen.
///
/// A wait for silence is not enough. A full-screen program asks the terminal
/// several questions at startup, and it then stays quiet until the answers
/// arrive. This mark is the first line of the file that the child shows.
const ALT_READY: &[u8] = b"file 0001";

/// The line that the child prints after the full-screen program is gone.
const GONE: &[u8] = b"EDITOR-GONE";

/// What one measured event cost.
#[derive(Clone, Copy)]
struct Sample {
    /// Time from the trigger to the first byte that the child wrote.
    think: Duration,
    /// Time from the trigger to the last byte of the answer.
    burst: Duration,
    /// Bytes of the answer.
    bytes: usize,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let child = args.next().unwrap_or_else(|| "editor".to_string());
    let runs: usize = match args.next() {
        Some(text) => text.parse()?,
        None => DEFAULT_RUNS,
    };
    let script = script_path(&child)?;

    let home = std::env::temp_dir().join(format!("pirate-bench-child-{}", std::process::id()));
    std::fs::create_dir_all(&home)?;

    println!(
        "\n  child: {} on a bare PTY, no pirate in the path\n",
        child
    );
    println!(
        "{:<10} {:>6} {:>12} {:>12} {:>12} {:>12} {:>10}",
        "event", "runs", "think med", "think p95", "burst med", "burst p95", "bytes med"
    );

    let exit = measure(&script, &home, runs, Trigger::Key).await?;
    report("exit", &exit);
    let resize = measure(&script, &home, runs, Trigger::Resize).await?;
    report("resize", &resize);
    if resize.is_empty() {
        println!("\n  the child of `{child}` writes nothing on SIGWINCH.");
    }
    println!();

    std::fs::remove_dir_all(&home).ok();
    Ok(())
}

/// What starts one measured event.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Trigger {
    /// Press the key that closes the full-screen program.
    Key,
    /// Change the size of the PTY, which sends `SIGWINCH`.
    Resize,
}

/// The path of one child script.
fn script_path(child: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // A third child. PIRATE_BENCH_CHILD_SCRIPT names a program of your own,
    // and the two reports then hold the think time of that program.
    if let Some(path) = std::env::var_os("PIRATE_BENCH_CHILD_SCRIPT") {
        return Ok(PathBuf::from(path));
    }
    let name = match child {
        "editor" => "altscreen-editor.sh",
        "pager" => "altscreen-pager.sh",
        "minimal" => "altscreen-minimal.sh",
        other => {
            return Err(
                format!("unknown child `{other}`. Use `editor`, `pager`, or `minimal`.").into(),
            )
        }
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("children")
        .join(name);
    if !path.exists() {
        return Err(format!("no child script at {}", path.display()).into());
    }
    Ok(path)
}

/// Run one report.
///
/// The child loops. Each run therefore starts the full-screen program again,
/// and one PTY serves every run of one report.
async fn measure(
    script: &PathBuf,
    home: &PathBuf,
    runs: usize,
    trigger: Trigger,
) -> Result<Vec<Sample>, Box<dyn std::error::Error>> {
    let (pty, pts) = pty_process::open()?;
    pty.resize(pty_process::Size::new(ROWS, COLS))?;
    let mut child = pty_process::Command::new(script)
        .env("TERM", "xterm-256color")
        .env("HOME", home)
        .kill_on_drop(true)
        .spawn(pts)?;
    let (mut read, mut write) = pty.into_split();

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        // Wait for the alternate screen, then for silence. The child is now
        // idle inside the full-screen program.
        wait_for(&mut read, &mut write, ALT_READY).await?;
        drain(&mut read, &mut write).await?;

        let start = Instant::now();
        match trigger {
            Trigger::Key => write.write_all(b"q").await?,
            Trigger::Resize => {
                write.resize(pty_process::Size::new(NARROW_ROWS, NARROW_COLS))?;
            }
        }
        let patience = match trigger {
            Trigger::Key => PATIENCE,
            Trigger::Resize => RESIZE_PATIENCE,
        };
        let Some((first, last, bytes)) = answer(&mut read, &mut write, patience).await? else {
            // The child ignores the trigger. The report says so.
            break;
        };
        samples.push(Sample {
            think: first.duration_since(start),
            burst: last.duration_since(start),
            bytes,
        });

        if trigger == Trigger::Resize {
            // Put the size back and let the redraw finish, so the next run
            // starts from the same screen.
            write.resize(pty_process::Size::new(ROWS, COLS))?;
            drain(&mut read, &mut write).await?;
            // The full-screen program is still up. Close it, so that the loop
            // of the child reaches the next round.
            write.write_all(b"q").await?;
            wait_for(&mut read, &mut write, GONE).await?;
            drain(&mut read, &mut write).await?;
        }
        // Ask the child for the next round.
        write.write_all(b"\n").await?;
    }

    child.start_kill().ok();
    Ok(samples)
}

/// Read until the tail of the stream holds `needle`.
async fn wait_for(
    read: &mut pty_process::OwnedReadPty,
    write: &mut pty_process::OwnedWritePty,
    needle: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let mut seen: Vec<u8> = Vec::new();
    let mut buf = vec![0_u8; 8192];
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or("the child wrote nothing that this benchmark waits for")?;
        let n = tokio::time::timeout(left, read.read(&mut buf)).await??;
        if n == 0 {
            return Err("the child closed the PTY".into());
        }
        reply(write, &buf[..n]).await?;
        seen.extend_from_slice(&buf[..n]);
        if seen.windows(needle.len()).any(|window| window == needle) {
            return Ok(());
        }
        // Hold only what a split needle needs.
        let keep = needle.len().saturating_sub(1);
        if seen.len() > keep {
            seen.drain(..seen.len() - keep);
        }
    }
}

/// Read until the child says nothing for `QUIET`.
async fn drain(
    read: &mut pty_process::OwnedReadPty,
    write: &mut pty_process::OwnedWritePty,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut buf = vec![0_u8; 8192];
    loop {
        match tokio::time::timeout(QUIET, read.read(&mut buf)).await {
            Err(_) => return Ok(()),
            Ok(Ok(0)) => return Ok(()),
            Ok(Ok(n)) => reply(write, &buf[..n]).await?,
            Ok(Err(e)) if e.kind() == ErrorKind::Interrupted => {}
            Ok(Err(e)) => return Err(e.into()),
        }
    }
}

/// Answer every terminal question that `bytes` holds.
///
/// A real terminal answers these questions, and the pirate client answers them
/// in `web/src/terminal.ts`. A bare PTY answers nothing, and a full-screen
/// program that waits for an answer then draws late or not at all. This
/// function puts the bare PTY on the same footing as the browser.
async fn reply(
    write: &mut pty_process::OwnedWritePty,
    bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let answer = answers(bytes);
    if !answer.is_empty() {
        write.write_all(&answer).await?;
    }
    Ok(())
}

/// The answers to the terminal questions in `bytes`.
fn answers(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != 0x1b {
            at += 1;
            continue;
        }
        let rest = &bytes[at..];
        // The kitty keyboard flags.
        if rest.starts_with(b"\x1b[?u") {
            out.extend_from_slice(b"\x1b[?0u");
            at += 4;
            continue;
        }
        // Primary device attributes.
        if rest.starts_with(b"\x1b[c") {
            out.extend_from_slice(b"\x1b[?62;22c");
            at += 3;
            continue;
        }
        // Device status: the terminal is fine.
        if rest.starts_with(b"\x1b[5n") {
            out.extend_from_slice(b"\x1b[0n");
            at += 4;
            continue;
        }
        // The position of the cursor.
        if rest.starts_with(b"\x1b[6n") {
            out.extend_from_slice(b"\x1b[1;1R");
            at += 4;
            continue;
        }
        // The name and the version of the terminal.
        if rest.starts_with(b"\x1b[>q") {
            out.extend_from_slice(b"\x1bP>|pirate-bench\x1b\\");
            at += 4;
            continue;
        }
        // The background color.
        if rest.starts_with(b"\x1b]11;?") {
            out.extend_from_slice(b"\x1b]11;rgb:1616/1616/1e1e\x1b\\");
            at += 6;
            continue;
        }
        // A mode question: ESC [ ? <digits> $ p. The answer is `reset`.
        if rest.starts_with(b"\x1b[?") {
            let mut end = 3;
            while end < rest.len() && rest[end].is_ascii_digit() {
                end += 1;
            }
            if end > 3 && rest.len() > end + 1 && rest[end] == b'$' && rest[end + 1] == b'p' {
                out.extend_from_slice(b"\x1b[?");
                out.extend_from_slice(&rest[3..end]);
                out.extend_from_slice(b";2$y");
                at += end + 2;
                continue;
            }
        }
        at += 1;
    }
    out
}

/// Read one answer: the first byte, the last byte, and the byte count.
///
/// The answer is `None` when the child wrote nothing inside `patience`.
async fn answer(
    read: &mut pty_process::OwnedReadPty,
    write: &mut pty_process::OwnedWritePty,
    patience: Duration,
) -> Result<Option<(Instant, Instant, usize)>, Box<dyn std::error::Error>> {
    let mut buf = vec![0_u8; 8192];
    let mut first: Option<Instant> = None;
    let mut last = Instant::now();
    let mut bytes = 0_usize;
    let deadline = Instant::now() + patience;
    loop {
        let wait = if first.is_none() {
            match deadline.checked_duration_since(Instant::now()) {
                Some(left) => left,
                None => return Ok(None),
            }
        } else {
            QUIET
        };
        match tokio::time::timeout(wait, read.read(&mut buf)).await {
            Err(_) if first.is_some() => break,
            Err(_) => return Ok(None),
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                let now = Instant::now();
                first.get_or_insert(now);
                last = now;
                bytes += n;
                reply(write, &buf[..n]).await?;
            }
            Ok(Err(e)) if e.kind() == ErrorKind::Interrupted => {}
            Ok(Err(e)) => return Err(e.into()),
        }
    }
    let Some(first) = first else {
        return Ok(None);
    };
    Ok(Some((first, last, bytes)))
}

/// Print one row of the report.
fn report(name: &str, samples: &[Sample]) {
    let think: Vec<u128> = samples.iter().map(|s| s.think.as_micros()).collect();
    let burst: Vec<u128> = samples.iter().map(|s| s.burst.as_micros()).collect();
    let bytes: Vec<u128> = samples.iter().map(|s| s.bytes as u128).collect();
    println!(
        "{:<10} {:>6} {:>12} {:>12} {:>12} {:>12} {:>10}",
        name,
        samples.len(),
        ms(quantile(&think, 0.5)),
        ms(quantile(&think, 0.95)),
        ms(quantile(&burst, 0.5)),
        ms(quantile(&burst, 0.95)),
        quantile(&bytes, 0.5),
    );
}

/// Microseconds as a string in milliseconds.
fn ms(micros: u128) -> String {
    format!("{:.1} ms", micros as f64 / 1000.0)
}

/// The value at `fraction` of a sorted copy of `values`.
fn quantile(values: &[u128], fraction: f64) -> u128 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let last = sorted.len() - 1;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(last)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantile_reads_the_ends_and_the_middle() {
        let values = [10_u128, 20, 30, 40, 50];
        assert_eq!(quantile(&values, 0.0), 10);
        assert_eq!(quantile(&values, 0.5), 30);
        assert_eq!(quantile(&values, 1.0), 50);
    }

    #[test]
    fn quantile_of_nothing_is_zero() {
        assert_eq!(quantile(&[], 0.5), 0);
    }

    #[test]
    fn the_responder_answers_the_questions_of_a_full_screen_program() {
        assert_eq!(answers(b"\x1b[c"), b"\x1b[?62;22c");
        assert_eq!(answers(b"\x1b[5n"), b"\x1b[0n");
        assert_eq!(answers(b"\x1b[?u"), b"\x1b[?0u");
        assert_eq!(answers(b"\x1b[?2026$p"), b"\x1b[?2026;2$y");
        // Two questions in one chunk give two answers, in order.
        assert_eq!(answers(b"\x1b[?u\x1b[c"), b"\x1b[?0u\x1b[?62;22c");
    }

    #[test]
    fn the_responder_answers_nothing_to_plain_output() {
        assert!(answers(b"hello\r\n\x1b[2J\x1b[H").is_empty());
    }

    #[test]
    fn both_child_scripts_exist_and_run() {
        for child in ["editor", "pager", "minimal"] {
            let path = script_path(child).expect("the script path");
            let text = std::fs::read_to_string(&path).expect("the script");
            assert!(text.starts_with("#!/bin/sh"), "{child} needs a shebang");
        }
    }

    /// The query child must ask its question after the client answered one.
    ///
    /// An answer of the terminal reaches the input queue of the child with no
    /// line feed after it. The line that `read` gives back is therefore the
    /// answer and the next name joined. A child that misses that line prints
    /// no question, and the report of `web/bench/whole-path.e2e.ts` then says
    /// `no answer` for a question that the client does answer.
    #[tokio::test]
    async fn the_query_child_asks_after_an_answer_of_the_terminal() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("children")
            .join("queries.sh");
        let (pty, pts) = pty_process::open().unwrap();
        pty.resize(pty_process::Size::new(ROWS, COLS)).unwrap();
        let mut child = pty_process::Command::new(&script)
            .env("TERM", "xterm-256color")
            .kill_on_drop(true)
            .spawn(pts)
            .unwrap();
        let (mut read, mut write) = pty.into_split();

        // Ask for DSR, then answer it as the client does. The answer carries
        // no line feed, so it stays in the input queue of the child.
        write.write_all(b"dsr\n").await.unwrap();
        let mut buf = vec![0_u8; 8192];
        let mut seen: Vec<u8> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut answered = false;
        let asked_cpr = loop {
            let left = match deadline.checked_duration_since(Instant::now()) {
                Some(left) => left,
                None => break false,
            };
            let Ok(Ok(n)) = tokio::time::timeout(left, read.read(&mut buf)).await else {
                break false;
            };
            if n == 0 {
                break false;
            }
            seen.extend_from_slice(&buf[..n]);
            if !answered && seen.windows(4).any(|w| w == b"\x1b[5n") {
                answered = true;
                write.write_all(b"\x1b[0n").await.unwrap();
                write.write_all(b"cpr\n").await.unwrap();
                seen.clear();
            }
            if answered && seen.windows(4).any(|w| w == b"\x1b[6n") {
                break true;
            }
        };
        child.start_kill().ok();
        assert!(
            asked_cpr,
            "the child must ask CPR on the line that follows an answered question"
        );
    }

    /// The product server wraps its listener in `pirate::NoDelay`. This test
    /// proves what that type does, so the whole-path measurement holds for a
    /// link that is not loopback.
    #[tokio::test]
    async fn the_no_delay_listener_turns_off_nagle() {
        use axum::serve::Listener as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut listener = pirate::NoDelay(listener);
        let client = tokio::spawn(async move { tokio::net::TcpStream::connect(addr).await });
        let (stream, _) = listener.accept().await;
        assert!(stream.nodelay().unwrap(), "TCP_NODELAY must be on");
        client.await.unwrap().unwrap();
    }
}
