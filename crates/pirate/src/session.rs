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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
/// The batch loop tests the length of a frame before it appends one more read.
/// One frame therefore carries [`OUTPUT_BATCH`] bytes plus one read of
/// [`READ_CHUNK`] bytes, at most. This count holds the queue near
/// [`CLIENT_BACKLOG`], and to that value plus one read per frame at the most.
pub const CLIENT_QUEUE: usize = CLIENT_BACKLOG / OUTPUT_BATCH;

/// Bytes per read from the PTY master.
const READ_CHUNK: usize = 8192;

/// Time that one output frame waits for more output.
///
/// A join of the queued output alone joins nothing when the writer is slower
/// than the server. A program that writes one line at a time is such a writer,
/// and each line then becomes one frame and one WebSocket message. This window
/// holds the output that arrives close together in one frame.
///
/// The window starts at the last output frame that went out, so output that
/// follows a quiet period waits for nothing. The delay that this window adds is
/// therefore [`OUTPUT_WINDOW`] at the most, and it falls on a stream only.
///
/// The value comes from two measurements on the browser side. One message costs
/// about 2 ms of parse and paint, so a window under 2 ms cannot pay for the
/// message that it saves. A display frame at 60 Hz is 16.7 ms, and output that
/// waits longer than one display frame is late. This value is half of a display
/// frame, so a frame that the window holds still reaches the paint that follows
/// it. `crates/pirate/tests/integration.rs` measures the count that it gives.
const OUTPUT_WINDOW: Duration = Duration::from_millis(8);

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
    /// The count of writes to the PTY master.
    ///
    /// The terminal thread reads this count to find the output that answers a
    /// keystroke. That output leaves the batch window at once.
    input_seq: Arc<AtomicU64>,
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
    /// With `login` true, the shell reads the login profile. The `arg0`
    /// function of this file holds the mechanism.
    ///
    /// The second value is the frame stream for the one client of this session.
    pub fn spawn(
        shell: &Path,
        cols: u16,
        rows: u16,
        login: bool,
    ) -> Result<(Self, Frames), Box<dyn std::error::Error + Send + Sync>> {
        // The same ceiling as `resize`. `spawn` is the second path into the
        // PTY and into the server-side terminal, so it takes the same clamp.
        let cols = cols.clamp(1, crate::terminal::MAX_COLS);
        let rows = rows.clamp(1, crate::terminal::MAX_ROWS);

        let (pty, pts) = pty_process::open().map_err(to_io)?;
        pty.resize(pty_process::Size::new(rows, cols))
            .map_err(to_io)?;

        // TERM tells the shell which sequences it can emit. Without it, most
        // programs fall back to a terminal with no color and no cursor keys.
        let child = pty_process::Command::new(shell)
            .arg0(arg0(shell, login))
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
        // it.
        let (commands, command_rx) = std::sync::mpsc::channel::<Command>();
        let (frame_tx, frame_rx) = mpsc::channel::<Vec<u8>>(CLIENT_QUEUE);
        let resync = Arc::new(AtomicBool::new(false));
        let input_seq = Arc::new(AtomicU64::new(0));

        let terminal_thread = std::thread::Builder::new()
            .name("pirate-terminal".to_string())
            .spawn({
                let resync = Arc::clone(&resync);
                let input_seq = Arc::clone(&input_seq);
                move || run_terminal(&command_rx, frame_tx, &resync, &input_seq, cols, rows)
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
            input_seq,
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
        let Some(pty) = self.pty.as_mut() else {
            return Err(std::io::Error::other("the session is closed"));
        };
        // The count goes up before the write, so the terminal thread cannot
        // see the echo of these bytes before it sees the count.
        self.input_seq.fetch_add(1, Ordering::Relaxed);
        let mut rest = bytes;
        while !rest.is_empty() {
            match pty.write(rest).await {
                Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                Ok(n) => rest = &rest[n..],
                // A signal on another thread gives EINTR here, because
                // `pty-process` retries `WouldBlock` only. The write must
                // continue: the caller ends the session on an error, and a
                // signal must not end a live terminal. The loop writes what
                // remains, so no byte goes out twice.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Apply a new window size.
    ///
    /// The PTY and the server-side terminal take the size here, in one place.
    /// Therefore the two cannot drift.
    /// The size is clamped to [`crate::terminal::MAX_COLS`] and
    /// [`crate::terminal::MAX_ROWS`]. This call feeds both the PTY ioctl and
    /// the terminal thread, so one clamp holds for both. [`Session::spawn`] is
    /// the other call that sets a size, and it carries the same clamp.
    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        let cols = cols.clamp(1, crate::terminal::MAX_COLS);
        let rows = rows.clamp(1, crate::terminal::MAX_ROWS);
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
        //
        //    Signal a group that still has a status of None only. On the
        //    ordinary exit path the child is already reaped here, the kernel
        //    can have given its pid to another process, and this call would
        //    then hang up a group that pirate does not own.
        if self.status.borrow().is_none() {
            self.signal_group(Signal::HUP);
        }

        // 2. Give the group a short time, then escalate. A process that
        //    ignores SIGHUP must not outlive the browser that started it.
        if !self.wait_for_exit(HANGUP_GRACE).await {
            if self.status.borrow().is_none() {
                self.signal_group(Signal::KILL);
            }
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
            // Every close of a socket reaches this line, and a host where
            // the signal gives EPERM writes one line for each of them. An
            // adversarial review watched that happen.
            Err(e) => {
                if SIGNAL_REPORTED.first_time() {
                    eprintln!(
                        "pirate: cannot signal the process group: {e}. \
                         pirate reports this fault one time only."
                    );
                }
            }
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

/// The guard of a signal that the operating system refused.
static SIGNAL_REPORTED: crate::ws::OnceFlag = crate::ws::OnceFlag::new();
/// The guard of a screen that would not format.
static DUMP_REPORTED: crate::ws::OnceFlag = crate::ws::OnceFlag::new();
/// The guard of a resize that the server-side terminal refused.
static RESIZE_REPORTED: crate::ws::OnceFlag = crate::ws::OnceFlag::new();

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
    /// The exit status of the child, when the child has ended.
    ///
    /// The exit frame goes out once when the child ends, and again after every
    /// dump. A full queue therefore cannot lose it: a resync empties the queue,
    /// so the dump and the exit frame both fit. The client that already has the
    /// frame gets a copy of it, and a copy is harmless.
    exit: Option<i32>,
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
            Err(e) => {
                if DUMP_REPORTED.first_time() {
                    eprintln!(
                        "pirate: cannot format the screen: {e}. \
                         pirate reports this fault one time only."
                    );
                }
            }
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
    input_seq: &Arc<AtomicU64>,
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
        exit: None,
    };

    // The first frame is a dump, so the browser starts from a known screen.
    client.send_dump(&terminal);

    // A command that a batch drained but did not consume. It runs first on the
    // next pass, so the order of the commands holds.
    let mut pending: Option<Command> = None;

    // The end of the window of the last output frame. A frame that starts after
    // this instant goes out with no wait.
    let mut window_end = Instant::now();

    // The count of input writes that the last output frame answered. The echo
    // of a keystroke is the output that follows a new count, and it waits for
    // nothing.
    let mut seen_input = input_seq.load(Ordering::Relaxed);

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
                // Join the output that is already in the queue, and then the
                // output that arrives inside the window. One parse and one
                // frame of N bytes cost less than N/1024 of each, and the PTY
                // gives about 1024 bytes per read.
                let batch;
                (batch, pending) = collect_output(commands, bytes, window_end, || {
                    input_seq.load(Ordering::Relaxed) != seen_input
                });
                seen_input = input_seq.load(Ordering::Relaxed);
                window_end = Instant::now() + OUTPUT_WINDOW;
                terminal.write(&batch);
                client.send(ServerFrame::Output(&batch).encode());
            }
            Command::Resize { cols, rows } => {
                if let Err(e) = terminal.resize(cols, rows) {
                    if RESIZE_REPORTED.first_time() {
                        eprintln!(
                            "pirate: cannot resize the server-side terminal: {e}. \
                             pirate reports this fault one time only."
                        );
                    }
                }
            }
            Command::Resync => {
                client.behind = false;
                client.send_dump(&terminal);
                // The dump goes into the queue first, so the client sees the
                // screen and then the status, in that order.
                if let Some(status) = client.exit {
                    client.send(ServerFrame::Exit(status).encode());
                }
            }
            Command::Exited(status) => {
                // Hold the status first. A full queue throws this frame away,
                // and the next dump then carries the status again.
                client.exit = Some(status);
                client.behind = false;
                client.send(ServerFrame::Exit(status).encode());
            }
            Command::Stop => break,
        }
    }
}

/// Join the output of one frame.
///
/// The output that is already in the queue joins with no wait. Further output
/// joins until `window_end`, until the frame is full, or until a command that
/// is not output arrives.
///
/// `input_arrived` reports a keystroke that the last frame did not answer. The
/// wait ends there, because the echo of a keystroke is the one output that an
/// operator times.
///
/// The second value is the command that ended the collection. That command runs
/// on the next pass of the loop, so the order of the commands holds.
fn collect_output(
    commands: &std::sync::mpsc::Receiver<Command>,
    first: Vec<u8>,
    window_end: Instant,
    input_arrived: impl Fn() -> bool,
) -> (Vec<u8>, Option<Command>) {
    let mut batch = first;
    while batch.len() < OUTPUT_BATCH {
        match commands.try_recv() {
            Ok(Command::Output(more)) => {
                batch.extend_from_slice(&more);
                continue;
            }
            Ok(other) => return (batch, Some(other)),
            Err(_) => {}
        }

        let now = Instant::now();
        if now >= window_end || input_arrived() {
            break;
        }
        match commands.recv_timeout(window_end - now) {
            Ok(Command::Output(more)) => batch.extend_from_slice(&more),
            Ok(other) => return (batch, Some(other)),
            // The window ended, or the writers are gone. The next receive of
            // the loop reports the second one.
            Err(_) => break,
        }
    }
    (batch, None)
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
            // A signal on another thread gives EINTR here, because
            // `pty-process` retries `WouldBlock` only. Read again: a signal is
            // not the end of the output.
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // The last slave closed. macOS and Linux both report EIO here.
            // Every other read error ends the output.
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

/// The `argv[0]` of the shell process.
///
/// A shell reads the login profile when `argv[0]` starts with a dash. The
/// program that runs is the full path in both forms, because `argv[0]` names
/// no file.
///
/// The value is the file name of `shell`, with a dash in front of it when
/// `login` is true. A path such as `/` or `/bin/..` has no file name, so the
/// whole path is the fallback.
fn arg0(shell: &Path, login: bool) -> std::ffi::OsString {
    let name = shell.file_name().unwrap_or(shell.as_os_str());
    if !login {
        return name.to_os_string();
    }
    let mut arg0 = std::ffi::OsString::from("-");
    arg0.push(name);
    arg0
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

    const DRAIN_GRACE: Duration = Duration::from_secs(120);

    fn is_dump(frame: &[u8]) -> bool {
        matches!(ServerFrame::decode(frame), Ok(ServerFrame::Dump(_)))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_first_frame_of_a_session_is_a_dump() {
        let (mut session, mut frames) =
            Session::spawn(Path::new("/bin/cat"), 80, 24, true).unwrap();

        let first = tokio::time::timeout(DRAIN_GRACE, frames.next())
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
        let (mut session, mut frames) =
            Session::spawn(Path::new("/bin/cat"), 80, 24, true).unwrap();

        let first = frames.next().await.expect("the session ended");
        assert!(is_dump(&first), "the first frame must be a dump");

        flood_until_behind(&mut session, &frames).await;

        // The next frame is the dump, and never the oldest queued output.
        let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
            .await
            .expect("no frame arrived after the flood")
            .expect("the session ended");
        assert!(
            is_dump(&frame),
            "a client that fell behind must get a dump, and not its backlog"
        );

        session.shutdown().await;
    }

    /// Fill the queue of `frames` until the server calls the client slow.
    ///
    /// `cat` sends every line back, and the line discipline sends it back a
    /// second time. 512 KB of input therefore makes about 1 MB of output, which
    /// is twice the queue. The caller must read no frame while this runs.
    async fn flood_until_behind(session: &mut Session, frames: &Frames) {
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
        tokio::time::timeout(DRAIN_GRACE, flood)
            .await
            .expect("the write to the PTY timed out");

        // Wait for the condition, and not for a time. The terminal thread joins
        // the queued output into one frame per parse, so the queue fills at
        // parse speed. A debug build parses about 200 times more slowly than a
        // release build, and a fixed wait would then pass on one and fail on
        // the other.
        let deadline = tokio::time::Instant::now() + DRAIN_GRACE;
        while !frames.resync.load(Ordering::Acquire) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            frames.resync.load(Ordering::Acquire),
            "1 MB of output never filled a queue of {CLIENT_BACKLOG} bytes"
        );
    }

    /// Wait until the server calls the client slow. The result is the flag.
    ///
    /// The caller must read no frame while this runs. The wait is on the
    /// condition and not on a time, because a debug build parses much more
    /// slowly than a release build.
    async fn wait_for_resync(frames: &Frames, grace: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + grace;
        while !frames.resync.load(Ordering::Acquire) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        frames.resync.load(Ordering::Acquire)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_that_falls_behind_still_gets_the_exit_status() {
        // A burst fills the queue, and the shell then exits. The exit frame is
        // the last frame of a session, and the pump in `ws.rs` closes the
        // socket on it. A client that fell behind must therefore still get it.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/sh"), 80, 24, true).unwrap();

        let first = frames.next().await.expect("the session ended");
        assert!(is_dump(&first), "the first frame must be a dump");

        // About 1 MB of output, which is twice the queue. Read no frame here.
        let line = "x".repeat(255);
        let burst = format!("i=0; while [ $i -lt 4000 ]; do echo {line}; i=$((i+1)); done\n");
        tokio::time::timeout(DRAIN_GRACE, session.input(burst.as_bytes()))
            .await
            .expect("the write to the PTY timed out")
            .expect("the write to the PTY failed");
        assert!(
            wait_for_resync(&frames, DRAIN_GRACE).await,
            "1 MB of output never filled a queue of {CLIENT_BACKLOG} bytes"
        );

        // Clear the flag by hand, and send the exit after it. A client that is
        // behind sends no frame, so only the exit frame can raise the flag now.
        frames.resync.store(false, Ordering::Release);
        tokio::time::timeout(DRAIN_GRACE, session.input(b"exit 42\n"))
            .await
            .expect("the write to the PTY timed out")
            .expect("the write to the PTY failed");
        assert!(
            wait_for_resync(&frames, DRAIN_GRACE).await,
            "the shell never exited into a full queue"
        );

        // The queue was full when the exit frame went out. Read now: the
        // resync drops the backlog, and the empty queue holds the dump and the
        // exit frame together.
        let mut exit = None;
        for _ in 0..16 {
            let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
                .await
                .expect("no frame arrived after the exit")
                .expect("the session ended");
            if let Ok(ServerFrame::Exit(status)) = ServerFrame::decode(&frame) {
                exit = Some(status);
                break;
            }
        }
        assert_eq!(
            exit,
            Some(42),
            "a client that fell behind must still get the exit status"
        );

        session.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_that_is_behind_still_gets_the_dump_that_it_asked_for() {
        // The browser asks for a dump when it repaints, and it can ask while it
        // is behind. `request_dump` and the backpressure path both send
        // `Command::Resync`, and that command clears the behind flag. Therefore
        // the request must give a dump and must open the output again.
        let (mut session, mut frames) =
            Session::spawn(Path::new("/bin/cat"), 80, 24, true).unwrap();

        let first = frames.next().await.expect("the session ended");
        assert!(is_dump(&first), "the first frame must be a dump");

        flood_until_behind(&mut session, &frames).await;

        // The client asks for a dump while the server holds it behind.
        session.request_dump();
        let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
            .await
            .expect("no frame arrived after the request")
            .expect("the session ended");
        assert!(
            is_dump(&frame),
            "a client that asks for a dump while it is behind must get one"
        );

        // Output must reach that client again. The line goes through the PTY,
        // so this is the whole path and not the flag alone.
        tokio::time::timeout(DRAIN_GRACE, session.input(b"after the dump\n"))
            .await
            .expect("the write to the PTY timed out")
            .expect("the write to the PTY failed");
        let mut flowed = false;
        for _ in 0..64 {
            let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
                .await
                .expect("no frame arrived after the dump")
                .expect("the session ended");
            if matches!(ServerFrame::decode(&frame), Ok(ServerFrame::Output(_))) {
                flowed = true;
                break;
            }
        }
        assert!(flowed, "output must reach the client again after its dump");

        session.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dump_follows_a_real_program_into_the_alternate_screen() {
        // The whole path, through a real PTY: a program enters the alternate
        // screen, and a later dump puts a client there also. tmux and vim take
        // this path, and the user runs tmux to share a session.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/sh"), 80, 24, true).unwrap();

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
        let deadline = tokio::time::Instant::now() + DRAIN_GRACE;
        let mut entered = false;
        while tokio::time::Instant::now() < deadline && !entered {
            session
                .commands
                .as_ref()
                .unwrap()
                .send(Command::Resync)
                .unwrap();
            let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
                .await
                .expect("no frame arrived")
                .expect("the session ended");
            if let Ok(ServerFrame::Dump(bytes)) = ServerFrame::decode(&frame) {
                entered = bytes.windows(8).any(|w| w == b"\x1b[?1049h");
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
        let (mut session, _frames) = Session::spawn(Path::new("/bin/cat"), 80, 24, true).unwrap();
        assert_eq!(session.exit_status(), None);

        session.shutdown().await;

        // 128 plus SIGHUP, which is signal 1.
        assert_eq!(session.exit_status(), Some(129));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_signals_no_group_after_the_child_is_reaped() {
        // A reaped child leaves a free pid, and the kernel can give that pid to
        // another process. The race itself is not reachable from a test, so
        // this test points the session at a group that it does not own and
        // proves that the guard sends no signal to it.
        let (mut ended, _ended_frames) =
            Session::spawn(Path::new("/bin/echo"), 80, 24, true).unwrap();
        assert!(
            ended.wait_for_exit(DRAIN_GRACE).await,
            "/bin/echo must end on its own"
        );

        // A live process group that this session must not touch.
        let (mut other, _other_frames) =
            Session::spawn(Path::new("/bin/cat"), 80, 24, true).unwrap();
        ended.pgid = other.pgid;

        ended.shutdown().await;

        // SIGHUP ends `cat`, so a status here is the signal that this test
        // forbids. The wait covers the delivery and the reap.
        tokio::time::sleep(HANGUP_GRACE).await;
        assert_eq!(
            other.exit_status(),
            None,
            "shutdown signaled a process group that it no longer owns"
        );

        other.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resize_reaches_the_server_side_terminal() {
        // The dump carries the screen, so a wider screen gives a longer dump.
        // The size itself is proved through the PTY in the integration tests.
        let (mut session, mut frames) = Session::spawn(Path::new("/bin/cat"), 20, 5, true).unwrap();
        let small = frames.next().await.unwrap().len();

        session.resize(200, 50).unwrap();
        session.input(b"\n").await.unwrap();
        // Skip the output frames until the flag makes a new dump. A resize
        // alone sends no frame, so ask for one through the input echo.
        let large = loop {
            let frame = tokio::time::timeout(DRAIN_GRACE, frames.next())
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
