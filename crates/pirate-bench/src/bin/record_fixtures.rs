//! Record real PTY byte streams, for the latency benchmarks.
//!
//! Each fixture is the exact byte stream that one screen event puts on a PTY
//! of 200 columns and 50 rows. The benchmarks replay these bytes through a real
//! PTY, so a measurement needs no vim, no shell configuration, and no human.
//!
//! Run this binary to make the fixtures again:
//!
//! ```text
//! cargo run --release -p pirate-bench --bin record_fixtures
//! ```
//!
//! The recorder starts one `bash` with no configuration, drives it, and cuts
//! the stream at each prompt. Each fixture therefore starts with the echo of
//! the command that made it, because the line discipline of a real PTY echoes
//! that command. A browser sees those bytes also.
//!
//! NOTE: The recorder overwrites the files in `fixtures`. A fixture is an
//! input of a measurement, so a new recording makes the old numbers invalid.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// The size of the recorded terminal.
///
/// This is about one full screen of a laptop browser window. A larger screen
/// makes a larger repaint, so the size is part of every fixture.
const COLS: u16 = 200;
const ROWS: u16 = 50;

/// Silence that ends one recording.
///
/// The recorder cuts a fixture when the PTY sends nothing for this long. A
/// screen event on a local PTY takes a few milliseconds, so this value is far
/// longer than any gap inside one event.
const QUIET: Duration = Duration::from_millis(500);

/// Bytes per read. This value affects the recording only, and never a fixture.
const READ_CHUNK: usize = 65536;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures = fixture_dir();
    std::fs::create_dir_all(&fixtures)?;

    std::fs::write(fixtures.join("source.txt"), sample_text())?;

    let mut recorder = Recorder::start(&fixtures)?;

    // The prompt of the shell that starts. No fixture holds it.
    recorder.quiet().await?;

    // 1. vim paints a full screen. 2. vim gives the screen back, and the shell
    //    paints its prompt on top of what returns.
    //
    // The name is relative, because the shell starts in the fixture directory.
    // vim writes the name it opened into its status line, so an absolute name
    // would put the path of this machine into the fixture.
    recorder.command("vim -u NONE -N -n source.txt\n").await?;
    write_fixture(&fixtures, "vim-open.bin", &recorder.quiet().await?)?;
    recorder.send(b":q!\r").await?;
    write_fixture(&fixtures, "vim-exit.bin", &recorder.quiet().await?)?;

    // A screen clear. This is a small number of bytes and a full repaint, so it
    // separates the cost of the wire from the cost of the renderer.
    recorder.command("clear\n").await?;
    write_fixture(&fixtures, "clear.bin", &recorder.quiet().await?)?;

    // A flood that scrolls. This is the case that fills the client queue and
    // makes the server drop a backlog.
    recorder.command("seq 1 200000\n").await?;
    write_fixture(&fixtures, "flood.bin", &recorder.quiet().await?)?;

    recorder.finish().await;
    Ok(())
}

/// One shell on one PTY, and the bytes that it sends.
struct Recorder {
    read: pty_process::OwnedReadPty,
    write: pty_process::OwnedWritePty,
    child: tokio::process::Child,
}

impl Recorder {
    /// Start a shell with no configuration, on a PTY of the fixture size.
    fn start(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let (pty, pts) = pty_process::open()?;
        pty.resize(pty_process::Size::new(ROWS, COLS))?;

        // --norc and --noprofile keep the recording free of the configuration
        // of the machine that records it. PS1 fixes the prompt for the same
        // reason: a prompt with a path or a git branch differs by machine. The
        // working directory does the same for the name that vim shows.
        let child = pty_process::Command::new("/bin/bash")
            .args(["--norc", "--noprofile", "-i"])
            .current_dir(dir)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("PS1", "pirate$ ")
            .kill_on_drop(true)
            .spawn(pts)?;

        let (read, write) = pty.into_split();
        Ok(Self { read, write, child })
    }

    /// Send bytes to the shell.
    async fn send(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.write.write_all(bytes).await
    }

    /// Send a command, and wait for the shell to read it.
    ///
    /// The short wait keeps the echo of the command inside the fixture that
    /// follows it, and not inside the one before it.
    async fn command(&mut self, line: &str) -> std::io::Result<()> {
        self.send(line.as_bytes()).await
    }

    /// Read until the PTY is silent for [`QUIET`], then give back the bytes.
    async fn quiet(&mut self) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut buf = vec![0_u8; READ_CHUNK];
        loop {
            match tokio::time::timeout(QUIET, self.read.read(&mut buf)).await {
                // The silence ended the event.
                Err(_) => return Ok(out),
                Ok(Ok(0)) | Ok(Err(_)) => return Ok(out),
                Ok(Ok(n)) => out.extend_from_slice(&buf[..n]),
            }
        }
    }

    /// End the shell.
    async fn finish(mut self) {
        let _ = self.send(b"exit\n").await;
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

/// Write one fixture and report its size.
fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(dir.join(name), bytes)?;
    println!("{name:<16} {:>9} bytes", bytes.len());
    Ok(())
}

/// `crates/pirate-bench/fixtures`, from the manifest directory of this crate.
fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// The file that vim opens.
///
/// The text fills more than one screen, so vim paints every row and the exit
/// gives back a screen that holds content.
fn sample_text() -> String {
    let mut text = String::new();
    for line in 1..=400 {
        text.push_str(&format!(
            "{line:>4}  the quick brown fox jumps over the lazy dog, and then it does it again\n"
        ));
    }
    text
}
