//! One PTY, one shell, one browser client.
//!
//! Every WebSocket connection gets its own PTY and its own shell. There is no
//! shared session. A user who wants two views of one shell runs tmux or screen
//! inside the terminal, which is the tool that already does that well.
//!
//! When the browser goes away, the shell goes away with it. `Session::shutdown`
//! sends SIGHUP to the process group of the child, waits a short time, and then
//! sends SIGKILL. Only after that does it close the PTY master. A closed master
//! signals the foreground process group only, so the explicit signal comes
//! first and a background job cannot outlive its browser.
//!
//! # The PTY crate
//!
//! pirate uses `pty-process`. Two crates were candidates.
//!
//! `pty-process` has one dependency at run time, `rustix`, and it is Unix only.
//! Windows is out of scope for pirate, so that costs nothing. Its `async`
//! feature makes the master a tokio `AsyncRead` and `AsyncWrite`, which removes
//! a blocking reader thread from this design. It also does the parts that are
//! easy to get wrong: `setsid`, `TIOCSCTTY`, and the size ioctl.
//!
//! `portable-pty` is the other candidate. It supports Windows through ConPTY,
//! and it brings eight more crates for that support, one of which is two major
//! versions behind. pirate does not need the support and does not want the
//! crates in a binary that ships as one file.
//!
//! # Threads
//!
//! `libghostty_vt::Terminal` is neither `Send` nor `Sync`, so one thread owns
//! the server-side terminal for the whole life of the session. Every other part
//! is a tokio task. The thread and the tasks talk over channels.
//!
//! ```text
//!  PTY master --> reader task --> commands --> terminal thread --> frames -->
//!  WebSocket
//! ```

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rustix::process::{Pid, Signal};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use crate::protocol::ServerFrame;
use crate::terminal::ScreenTerminal;

/// Bytes that one client can hold before the server calls it slow.
///
/// A client that is this far behind has a backlog that is larger than the
/// screen it would end on. Therefore the server drops the backlog and sends one
/// dump, which is both smaller and correct. This value also caps the memory
/// that one slow client can hold.
const CLIENT_BACKLOG: usize = 512 * 1024;

/// Bytes of PTY output that one frame carries, at most.
///
/// The terminal thread joins the output that is already in its queue into one
/// frame. A burst from a full-screen program arrives as many small reads, and
/// `examples/bench_server.rs` measures the cost of the frame count: the same
/// bytes in one frame cost less than the same bytes in many. This cap keeps one
/// frame smaller than the dump that would replace it.
///
/// The pump in `ws.rs` joins output frames again, under the same cap, because
/// the socket is slower than the parse and it therefore holds more.
pub const OUTPUT_BATCH: usize = 64 * 1024;

/// Frames that one client can hold before the server calls it slow.
///
/// Each frame carries at most [`OUTPUT_BATCH`] bytes, so this count holds the
/// queue to [`CLIENT_BACKLOG`].
pub const CLIENT_QUEUE: usize = CLIENT_BACKLOG / OUTPUT_BATCH;

/// Bytes per read from the PTY master.
const READ_CHUNK: usize = 8192;

/// Time that the process group gets after SIGHUP, and again after SIGKILL.
const HANGUP_GRACE: Duration = Duration::from_millis(500);

/// Time that the reader task waits for an exit status after the output stops.
const STATUS_WAIT: Duration = Duration::from_millis(500);

/// Columns of a session that no client has sized yet.
pub const DEFAULT_COLS: u16 = 80;
/// Rows of a session that no client has sized yet.
pub const DEFAULT_ROWS: u16 = 24;

/// A message for the terminal thread.
enum Command {
    /// Bytes that the PTY produced.
    Output(Vec<u8>),
    /// A new window size for the server-side terminal.
    Resize { cols: u16, rows: u16 },
    /// Send a fresh dump and clear the behind flag.
    ///
    /// Two callers send this command: a client that fell behind and dropped its
    /// backlog, and a client that asked for a dump.
    Resync,
    /// The child process ended with this status.
    Exited(i32),
    /// The session is over. Stop the thread.
    Stop,
}

/// One PTY session with one shell.
pub struct Session {
    commands: Option<std::sync::mpsc::Sender<Command>>,
    pty: Option<pty_process::OwnedWritePty>,
    /// The process group of the child. The child is a session leader, so this
    /// value is the process identifier of the child.
    pgid: Option<Pid>,
    status: watch::Receiver<Option<i32>>,
    terminal_thread: Option<std::thread::JoinHandle<()>>,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    wait_task: Option<tokio::task::JoinHandle<()>>,
}

impl Session {
    /// Open a PTY, start the shell, and start the server-side terminal.
    ///
    /// The second value is the frame stream for the one client of this session.
    pub fn spawn(
        shell: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, Frames), Box<dyn std::error::Error + Send + Sync>> {
        let cols = cols.max(1);
        let rows = rows.max(1);

        let (pty, pts) = pty_process::open().map_err(to_io)?;
        pty.resize(pty_process::Size::new(rows, cols))
            .map_err(to_io)?;

        // TERM tells the shell which sequences it can emit. Without it, most
        // programs fall back to a terminal with no color and no cursor keys.
        let child = pty_process::Command::new(shell)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            // The last guard against a leaked shell. `shutdown` is the first.
            .kill_on_drop(true)
            .spawn(pts)
            .map_err(to_io)?;

        let pgid = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(Pid::from_raw);

        let (read_pty, write_pty) = pty.into_split();
        // The command channel has no bound, and it does not need one. The
        // terminal thread parses each chunk and then calls try_send, which
        // never waits. Therefore this channel drains at parse speed, which is
        // much faster than a PTY, and a slow client cannot make it grow. The
        // bound that matters is CLIENT_QUEUE, on the channel after it.
        //
        // `Session::request_dump` is the second writer, and the browser drives
        // it. The pump in `ws.rs` holds that writer to one send per
        // `ws::DUMP_INTERVAL`, so a client that asks in a loop cannot make this
        // channel grow either.
        let (commands, command_rx) = std::sync::mpsc::channel::<Command>();
        let (frame_tx, frame_rx) = mpsc::channel::<Vec<u8>>(CLIENT_QUEUE);
        let resync = Arc::new(AtomicBool::new(false));

        let terminal_thread = std::thread::Builder::new()
            .name("pirate-terminal".to_string())
            .spawn({
                let resync = Arc::clone(&resync);
                move || run_terminal(&command_rx, frame_tx, &resync, cols, rows)
            })?;

        let (status_tx, status) = watch::channel(None);
        let wait_task = tokio::spawn(wait_for_child(child, status_tx));
        let reader_task = tokio::spawn(read_pty_output(read_pty, commands.clone(), status.clone()));

        let frames = Frames {
            rx: frame_rx,
            resync,
            commands: commands.clone(),
        };
        let session = Self {
            commands: Some(commands),
            pty: Some(write_pty),
            pgid,
            status,
            terminal_thread: Some(terminal_thread),
            reader_task: Some(reader_task),
            wait_task: Some(wait_task),
        };
        Ok((session, frames))
    }

    /// Write client input to the PTY master.
    pub async fn input(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        match self.pty.as_mut() {
            Some(pty) => pty.write_all(bytes).await,
            None => Err(std::io::Error::other("the session is closed")),
        }
    }

    /// Apply a new window size.
    ///
    /// The PTY and the server-side terminal take the size here, in one place.
    /// Therefore the two cannot drift.
    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if let Some(pty) = self.pty.as_mut() {
            // pty_process::Size takes rows first, then columns.
            pty.resize(pty_process::Size::new(rows, cols))
                .map_err(to_io)?;
        }
        if let Some(commands) = self.commands.as_ref() {
            let _ = commands.send(Command::Resize { cols, rows });
        }
        Ok(())
    }

    /// Ask the terminal thread for a full-state dump.
    ///
    /// The dump arrives on the frame stream, as the same `0x01` frame that the
    /// thread sends when the session starts.
    pub fn request_dump(&self) {
        if let Some(commands) = self.commands.as_ref() {
            // A send error means that the thread is gone, and a closed session
            // needs no dump.
            let _ = commands.send(Command::Resync);
        }
    }

    /// The exit status of the child, when the child has ended.
    pub fn exit_status(&self) -> Option<i32> {
        *self.status.borrow()
    }

    /// End the session and make sure that no process survives it.
    ///
    /// Both a clean disconnect and a dropped connection take this path.
    pub async fn shutdown(&mut self) {
        // 1. Hang up the process group of the child. The child is a session
        //    leader, so this signal reaches the shell and its jobs.
        self.signal_group(Signal::HUP);

        // 2. Give the group a short time, then escalate. A process that
        //    ignores SIGHUP must not outlive the browser that started it.
        if !self.wait_for_exit(HANGUP_GRACE).await {
            self.signal_group(Signal::KILL);
            self.wait_for_exit(HANGUP_GRACE).await;
        }

        // 3. Stop the reader, then close the master. The signal comes first,
        //    because a close alone reaches the foreground group only.
        if let Some(task) = self.reader_task.take() {
            task.abort();
            let _ = task.await;
        }
        drop(self.pty.take());

        // 4. Reap the child. tokio::process::Child::wait does that.
        if let Some(task) = self.wait_task.take() {
            let _ = task.await;
        }

        // 5. Stop the terminal thread and wait for it. Stop is explicit,
        //    because the client still holds a command sender.
        if let Some(commands) = self.commands.take() {
            let _ = commands.send(Command::Stop);
        }
        if let Some(thread) = self.terminal_thread.take() {
            let _ = thread.join();
        }
    }

    fn signal_group(&self, signal: Signal) {
        let Some(pgid) = self.pgid else { return };
        match rustix::process::kill_process_group(pgid, signal) {
            // No such process. The group is already gone, which is the result
            // that this call wants.
            Ok(()) | Err(rustix::io::Errno::SRCH) => {}
            Err(e) => eprintln!("pirate: cannot signal the process group: {e}"),
        }
    }

    /// Wait for the child to end. The result is false on a timeout.
    async fn wait_for_exit(&mut self, grace: Duration) -> bool {
        if self.status.borrow().is_some() {
            return true;
        }
        let wait = self.status.wait_for(Option::is_some);
        matches!(tokio::time::timeout(grace, wait).await, Ok(Ok(_)))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // `shutdown` is the normal path. This runs when the task that owned
        // the session was cancelled before it. A process group must never
        // outlive its session, so kill it here with no grace period.
        if self.status.borrow().is_none() {
            self.signal_group(Signal::KILL);
        }
    }
}

/// The frames of one session, in order.
pub struct Frames {
    rx: mpsc::Receiver<Vec<u8>>,
    resync: Arc<AtomicBool>,
    commands: std::sync::mpsc::Sender<Command>,
}

impl Frames {
    /// Take the next frame. The result is None when the session ends.
    ///
    /// When the client fell behind, this drops the backlog and asks for a
    /// fresh dump. The dump is then the next frame.
    ///
    /// The only await point is the receive, and that call is cancel safe.
    /// Therefore this call is cancel safe also, and `tokio::select!` can use it.
    pub async fn next(&mut self) -> Option<Vec<u8>> {
        if self.resync.swap(false, Ordering::AcqRel) {
            while self.rx.try_recv().is_ok() {}
            self.commands.send(Command::Resync).ok()?;
        }
        self.rx.recv().await
    }

    /// Take a frame that is already in the queue. This call never waits.
    ///
    /// The pump uses this to write every queued frame under one flush. A
    /// resync is the work of [`Frames::next`], so this gives back None when one
    /// is due and the pump then returns to its select.
    pub fn try_next(&mut self) -> Option<Vec<u8>> {
        if self.resync.load(Ordering::Acquire) {
            return None;
        }
        self.rx.try_recv().ok()
    }
}

/// The one client of a session, as the terminal thread sees it.
struct Client {
    tx: mpsc::Sender<Vec<u8>>,
    resync: Arc<AtomicBool>,
    /// True after a full queue. No frame goes out until the dump does.
    behind: bool,
}

impl Client {
    fn send(&mut self, frame: Vec<u8>) {
        if self.behind {
            return;
        }
        if self.tx.try_send(frame).is_err() {
            // The queue is full, or the client is gone. Stop sending and raise
            // the flag. The client then drops its backlog and asks for a dump.
            // The PTY reader never waits for this client.
            self.behind = true;
            self.resync.store(true, Ordering::Release);
        }
    }

    fn send_dump(&mut self, terminal: &ScreenTerminal) {
        match terminal.dump() {
            Ok(bytes) => self.send(ServerFrame::Dump(&bytes).encode()),
            Err(e) => eprintln!("pirate: cannot format the screen: {e}"),
        }
    }
}

/// The terminal thread.
///
/// This thread owns the server-side terminal for the life of the session,
/// because that type is neither `Send` nor `Sync`.
fn run_terminal(
    commands: &std::sync::mpsc::Receiver<Command>,
    tx: mpsc::Sender<Vec<u8>>,
    resync: &Arc<AtomicBool>,
    cols: u16,
    rows: u16,
) {
    let mut terminal = match ScreenTerminal::new(cols, rows) {
        Ok(terminal) => terminal,
        Err(e) => {
            eprintln!("pirate: cannot create the server-side terminal: {e}");
            return;
        }
    };
    let mut client = Client {
        tx,
        resync: Arc::clone(resync),
        behind: false,
    };

    // The first frame is a dump, so the browser starts from a known screen.
    client.send_dump(&terminal);

    // A command that a batch drained but did not consume. It runs first on the
    // next pass, so the order of the commands holds.
    let mut pending: Option<Command> = None;

    loop {
        let command = match pending.take() {
            Some(command) => command,
            None => match commands.recv() {
                Ok(command) => command,
                Err(_) => break,
            },
        };

        match command {
            Command::Output(bytes) => {
                // Join the output that is already in the queue. One parse and
                // one frame of N bytes cost less than N/1024 of each, and the
                // PTY gives about 1024 bytes per read.
                let mut batch = bytes;
                while batch.len() < OUTPUT_BATCH {
                    match commands.try_recv() {
                        Ok(Command::Output(more)) => batch.extend_from_slice(&more),
                        Ok(other) => {
                            pending = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                terminal.write(&batch);
                client.send(ServerFrame::Output(&batch).encode());
            }
            Command::Resize { cols, rows } => {
                if let Err(e) = terminal.resize(cols, rows) {
                    eprintln!("pirate: cannot resize the server-side terminal: {e}");
                }
            }
            Command::Resync => {
                client.behind = false;
                client.send_dump(&terminal);
            }
            Command::Exited(status) => {
                client.behind = false;
                client.send(ServerFrame::Exit(status).encode());
            }
            Command::Stop => break,
        }
    }
}

/// Read the PTY master until the output ends, then report the exit status.
async fn read_pty_output(
    mut pty: pty_process::OwnedReadPty,
    commands: std::sync::mpsc::Sender<Command>,
    mut status: watch::Receiver<Option<i32>>,
) {
    let mut buf = vec![0_u8; READ_CHUNK];
    loop {
        match pty.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if commands.send(Command::Output(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
            // The last slave closed. macOS and Linux both report EIO here.
            // Every read error ends the output.
            Err(_) => break,
        }
    }

    // The output stopped. Send the status after the last bytes, so that the
    // browser gets the two in order.
    let wait = status.wait_for(Option::is_some);
    let code = match tokio::time::timeout(STATUS_WAIT, wait).await {
        Ok(Ok(value)) => value.unwrap_or(-1),
        _ => -1,
    };
    let _ = commands.send(Command::Exited(code));
}

/// Wait for the child and publish its status.
async fn wait_for_child(mut child: tokio::process::Child, status: watch::Sender<Option<i32>>) {
    let code = match child.wait().await {
        Ok(exit) => exit_code(&exit),
        Err(e) => {
            eprintln!("pirate: cannot wait for the shell: {e}");
            -1
        }
    };
    let _ = status.send(Some(code));
}

/// The status of an exit, as one number.
///
/// A process that a signal ended has no exit code. The shell convention gives
/// it 128 plus the signal number, and this function uses that convention.
fn exit_code(exit: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt as _;
    exit.code()
        .unwrap_or_else(|| 128 + exit.signal().unwrap_or(0))
}

fn to_io(e: pty_process::Error) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// The shell to start when the operator names none.
///
/// The value of `SHELL` comes first. `/bin/bash` is the fallback, because a
/// login record with no `SHELL` is possible and a session with no shell is not.
#[must_use]
pub fn default_shell() -> std::path::PathBuf {
    match std::env::var_os("SHELL") {
        Some(shell) if !shell.is_empty() => std::path::PathBuf::from(shell),
        _ => std::path::PathBuf::from("/bin/bash"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerFrame;

    fn is_dump(frame: &[u8]) -> bool {
        matches!(ServerFrame::decode(frame), Ok(ServerFrame::Dump(_)))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_first_frame_of_a_session_is_a_dump() {
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/cat"), 80, 24).unwrap();

        let first = tokio::time::timeout(Duration::from_secs(10), frames.next())
            .await
            .expect("no first frame arrived")
            .expect("the session ended");
        assert!(is_dump(&first));

        session.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_that_falls_behind_gets_a_dump_and_not_its_backlog() {
        // This test drives the channel directly, with no socket between. A
        // socket adds kernel buffers whose size differs by host, and the
        // result would then depend on the host.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/cat"), 80, 24).unwrap();

        let first = frames.next().await.expect("the session ended");
        assert!(is_dump(&first), "the first frame must be a dump");

        // `cat` sends every line back, and the line discipline sends it back a
        // second time. 512 KB of input therefore makes about 1 MB of output,
        // which is twice the queue. Nothing reads the queue here.
        let line = {
            let mut line = vec![b'x'; 255];
            line.push(b'\n');
            line
        };
        let flood = async {
            for _ in 0..2048 {
                session.input(&line).await.unwrap();
            }
        };
        tokio::time::timeout(Duration::from_secs(20), flood)
            .await
            .expect("the write to the PTY timed out");

        // Wait for the condition, and not for a time. The terminal thread joins
        // the queued output into one frame per parse, so the queue fills at
        // parse speed. A debug build parses about 200 times more slowly than a
        // release build, and a fixed wait would then pass on one and fail on
        // the other.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !frames.resync.load(Ordering::Acquire) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            frames.resync.load(Ordering::Acquire),
            "1 MB of output never filled a queue of {CLIENT_BACKLOG} bytes"
        );

        // The next frame is the dump, and never the oldest queued output.
        let frame = tokio::time::timeout(Duration::from_secs(10), frames.next())
            .await
            .expect("no frame arrived after the flood")
            .expect("the session ended");
        assert!(
            is_dump(&frame),
            "a client that fell behind must get a dump, and not its backlog"
        );

        session.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dump_follows_a_real_program_into_the_alternate_screen() {
        // The whole path, through a real PTY: a program enters the alternate
        // screen, and a later dump puts a client there also. tmux and vim take
        // this path, and the user runs tmux to share a session.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/sh"), 80, 24).unwrap();

        let first = frames.next().await.expect("the session ended");
        let ServerFrame::Dump(bytes) = ServerFrame::decode(&first).unwrap() else {
            panic!("the first frame must be a dump")
        };
        assert!(
            bytes.starts_with(b"\x1b[?1049l"),
            "a shell at its prompt is on the primary screen"
        );

        // ESC [ ? 1049 h enters the alternate screen. printf writes the real
        // bytes, so the PTY carries the sequence and not its text.
        session
            .input(b"printf '\\033[?1049h\\033[2J\\033[Hinside the alternate screen'\n")
            .await
            .unwrap();

        // Ask for a dump until it reports the alternate screen. Each pass is
        // one round trip through the PTY and the terminal thread.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut entered = false;
        while tokio::time::Instant::now() < deadline && !entered {
            session
                .commands
                .as_ref()
                .unwrap()
                .send(Command::Resync)
                .unwrap();
            let frame = tokio::time::timeout(Duration::from_secs(10), frames.next())
                .await
                .expect("no frame arrived")
                .expect("the session ended");
            if let Ok(ServerFrame::Dump(bytes)) = ServerFrame::decode(&frame) {
                entered = bytes.starts_with(b"\x1b[?1049h");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            entered,
            "the dump never followed the program into the alternate screen"
        );

        session.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_reports_an_exit_status() {
        let (mut session, _frames) = Session::spawn(Path::new("/bin/cat"), 80, 24).unwrap();
        assert_eq!(session.exit_status(), None);

        session.shutdown().await;

        // 128 plus SIGHUP, which is signal 1.
        assert_eq!(session.exit_status(), Some(129));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resize_reaches_the_server_side_terminal() {
        // The dump carries the screen, so a wider screen gives a longer dump.
        // The size itself is proved through the PTY in the integration tests.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/cat"), 20, 5).unwrap();
        let small = frames.next().await.unwrap().len();

        session.resize(200, 50).unwrap();
        session.input(b"\n").await.unwrap();
        // Skip the output frames until the flag makes a new dump. A resize
        // alone sends no frame, so ask for one through the input echo.
        let large = loop {
            let frame = tokio::time::timeout(Duration::from_secs(10), frames.next())
                .await
                .expect("no frame arrived after the resize")
                .expect("the session ended");
            if is_dump(&frame) {
                break frame.len();
            }
            // Force a dump by asking for one the way a slow client does.
            session
                .commands
                .as_ref()
                .unwrap()
                .send(Command::Resync)
                .ok();
        };
        assert!(
            large > small,
            "a 200x50 dump ({large} bytes) must be longer than a 20x5 dump ({small} bytes)"
        );

        session.shutdown().await;
    }
}
