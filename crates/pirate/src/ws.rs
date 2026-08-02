//! The `/ws` route.
//!
//! One WebSocket connection is one terminal. The upgrade starts a PTY and a
//! shell, the connection carries the bytes both ways, and the end of the
//! connection ends the shell. `crate::protocol` holds the frame table.
//!
//! `/ws` is the gate that matters. The static assets are public, because they
//! are the same files for every visitor and they hold no secret. This route
//! starts a shell, so it tests the `Origin` header and the session before it
//! upgrades anything.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse as _, Response};
use futures_util::{SinkExt as _, StreamExt as _};

use crate::protocol::{server_tag, ClientFrame};
use crate::session::{Frames, Session, DEFAULT_COLS, DEFAULT_ROWS, OUTPUT_BATCH};
use crate::AppState;

/// The number of terminals that can live at the same time.
///
/// One `/ws` connection forks a shell and starts a terminal thread, and
/// `auth::MAX_SESSIONS` bounds the session COOKIES and not the connections. One
/// cookie therefore opened any number of terminals, and `--no-password` needed
/// no cookie at all. That is a fork bomb that a client reaches.
///
/// 64 matches `auth::MAX_SESSIONS` and it is far more than an operator uses. A
/// request over the bound gets 503 and starts no process.
const MAX_TERMINALS: usize = 64;

// A bound of zero would answer 503 to every request, and the operator would
// get a server that serves the web assets and no terminal.
const _: () = assert!(MAX_TERMINALS > 0);

/// The live terminals of one server.
///
/// The count lives in [`crate::AppState`], so two servers in one test binary
/// bound each other nothing.
#[derive(Debug)]
pub struct Terminals {
    live: Arc<AtomicUsize>,
    bound: usize,
}

impl Default for Terminals {
    fn default() -> Self {
        Self::new(MAX_TERMINALS)
    }
}

impl Terminals {
    /// A count that holds `bound` terminals at the same time.
    ///
    /// The bound is a field and not a constant, so a test can build a server
    /// with a small bound and open a few sockets instead of 64.
    #[must_use]
    pub fn new(bound: usize) -> Self {
        Self {
            live: Arc::new(AtomicUsize::new(0)),
            bound,
        }
    }

    /// The terminals that are live now. The tests read this value.
    #[must_use]
    pub fn live(&self) -> usize {
        self.live.load(Ordering::Acquire)
    }

    /// Take one slot, or give `None` when the server is full.
    ///
    /// The update is one compare-and-swap, so two requests that arrive together
    /// cannot both take the last slot.
    fn take(&self) -> Option<TerminalSlot> {
        let bound = self.bound;
        self.live
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                (live < bound).then_some(live + 1)
            })
            .ok()?;
        Some(TerminalSlot {
            live: Arc::clone(&self.live),
        })
    }
}

/// One live terminal. The drop gives the slot back.
///
/// CAUTION: Keep the count in this guard. The slot must come back on EVERY
/// path: a clean close, a dropped connection, a shell that exits, and a panic
/// in the handler. A pair of hand-written increment and decrement calls leaks
/// the slot on the panic path, and a leaked slot never comes back.
#[derive(Debug)]
pub struct TerminalSlot {
    live: Arc<AtomicUsize>,
}

impl Drop for TerminalSlot {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Upgrade the request, then start one session for it.
///
/// `WebSocketUpgrade` is the last argument, because it consumes the request.
pub async fn upgrade(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // All three tests answer before `on_upgrade`. That order is what stops an
    // unauthenticated request, and a request over the bound, from starting a
    // PTY and a shell.
    if !crate::auth::origin_ok(&headers, state.tls, &state.hosts) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !state.auth.is_authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(slot) = state.terminals.take() else {
        // The refusal is silent. One line per refusal gives a client a way to
        // flood stderr, which is the same rule that the TLS handshake follows.
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    let shell = state.shell.clone();
    // The guard moves into the callback. axum drops that callback when the
    // upgrade never completes, so a connection that dies in the handshake gives
    // its slot back too.
    ws.on_upgrade(move |socket| handle(socket, shell, slot))
}

/// Serve one terminal. The slot comes back when this future ends.
///
/// CAUTION: Keep `_slot` in this signature. It is the live count of the server,
/// and a drop of it anywhere earlier frees a slot that a shell still holds.
async fn handle(socket: WebSocket, shell: PathBuf, _slot: TerminalSlot) {
    // The browser sends its true size as a resize frame right after it
    // connects. These two values hold until then.
    let (mut session, frames) = match Session::spawn(&shell, DEFAULT_COLS, DEFAULT_ROWS) {
        Ok(started) => started,
        Err(e) => {
            eprintln!("pirate: cannot start `{}`: {e}", shell.display());
            return;
        }
    };

    pump(socket, &mut session, frames).await;

    // Both a clean close and a dropped connection arrive here. The shell must
    // not survive either one.
    session.shutdown().await;
}

/// The shortest time between two dumps that the client asked for.
///
/// A dump formats the whole screen, so a client that asks in a loop must not
/// make the server format in a loop. Requests inside one interval collapse
/// into one dump, and that dump goes out when the interval ends. The client
/// therefore loses no repaint, and the server does at most four of these
/// dumps per second for one socket.
///
/// This module is private, and the crate root re-exports this constant as
/// `pirate::DUMP_INTERVAL`. The integration test
/// `a_flood_of_dump_requests_collapses_into_a_few_dumps` reads it there. That
/// test computes its ceiling from this value, so a change here moves the
/// ceiling with it.
pub const DUMP_INTERVAL: Duration = Duration::from_millis(250);

/// Carry frames both ways until one side ends the connection.
async fn pump(socket: WebSocket, session: &mut Session, mut frames: Frames) {
    let (mut sink, mut stream) = socket.split();

    // A request that waits for its interval. Many requests collapse into this
    // one flag, which is the whole of the coalesce.
    let mut dump_pending = false;
    // The deadline of the next dump. It starts in the past, so the first
    // request goes out at once.
    let mut next_dump_at = tokio::time::Instant::now();

    loop {
        tokio::select! {
            // All three branches are cancel safe. `Frames::next` awaits a
            // channel receive only, the socket stream keeps its state in
            // itself, and `sleep_until` takes a deadline that this loop owns,
            // so a cancelled sleep starts again at the same deadline.
            frame = frames.next() => {
                let Some(frame) = frame else { break };
                if !drain(&mut sink, &mut frames, frame).await {
                    break;
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if !apply(session, &bytes, &mut dump_pending).await {
                            break;
                        }
                    }
                    // Every other message that arrives whole. A text frame is
                    // not in the protocol table, and axum answers a ping
                    // itself. A close arrives here also: it needs no answer,
                    // because the next poll of the stream gives None and the
                    // loop then ends.
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            // The guard disables this branch when no request waits, so the
            // loop never spins on an elapsed deadline.
            () = tokio::time::sleep_until(next_dump_at), if dump_pending => {
                dump_pending = false;
                next_dump_at = tokio::time::Instant::now() + DUMP_INTERVAL;
                session.request_dump();
            }
        }
    }

    let _ = sink.send(Message::Close(None)).await;
}

/// The write half of the socket, after the split.
type Sink = futures_util::stream::SplitSink<WebSocket, Message>;

/// Write one frame and every frame that is already queued behind it.
///
/// Two costs fall here, and a burst from a full-screen program pays both.
///
/// The socket is the slowest stage of the server, so its queue is the longest
/// one. This call joins the output frames of that queue into one message.
/// Output is a stream of bytes and the browser applies it as one, so the join
/// changes nothing on the screen. It removes a message, a copy, and a call into
/// WebAssembly for each frame that it joins.
///
/// The join tests the length of the message before it appends one more frame,
/// and one frame is itself a batch that can pass [`OUTPUT_BATCH`]. One message
/// therefore carries a little more than twice that many bytes, at most.
///
/// `SinkExt::send` is a write and then a flush, and a flush is a write to the
/// socket. The messages that remain therefore go out under one flush, which is
/// one syscall for the whole queue and not one for each message.
///
/// The result is false when the socket failed, or when the child has ended.
async fn drain(sink: &mut Sink, frames: &mut Frames, first: Vec<u8>) -> bool {
    let mut frame = first;
    let ended = loop {
        // A frame that the join stopped on. It is the next message, and it
        // must not go back into the queue, because order is the contract.
        let mut held = None;
        if frame.first() == Some(&server_tag::OUTPUT) {
            while frame.len() < OUTPUT_BATCH {
                match frames.try_next() {
                    // Drop the tag byte of the frame that joins. The payloads
                    // are consecutive PTY bytes, so one tag covers them all.
                    Some(more) if more.first() == Some(&server_tag::OUTPUT) => {
                        frame.extend_from_slice(&more[1..]);
                    }
                    other => {
                        held = other;
                        break;
                    }
                }
            }
        }

        let exited = frame.first() == Some(&server_tag::EXIT);
        if sink
            .feed(Message::Binary(Bytes::from(frame)))
            .await
            .is_err()
        {
            return false;
        }
        // The process is gone. Its status is the last frame of the session.
        if exited {
            break true;
        }
        match held.or_else(|| frames.try_next()) {
            Some(next) => frame = next,
            None => break false,
        }
    };

    // Nothing above reached the socket until this call.
    sink.flush().await.is_ok() && !ended
}

/// Apply one client frame. The result is false when the session must end.
///
/// A dump request raises `dump_pending` and does nothing else. The pump holds
/// the rate, because a dump is the most expensive frame that this server sends.
async fn apply(session: &mut Session, bytes: &[u8], dump_pending: &mut bool) -> bool {
    match ClientFrame::decode(bytes) {
        Ok(ClientFrame::Input(input)) => match session.input(input).await {
            Ok(()) => true,
            // The master rejects a write after the shell is gone.
            Err(_) => false,
        },
        Ok(ClientFrame::Resize { cols, rows }) => {
            if let Err(e) = session.resize(cols, rows) {
                if RESIZE_REPORTED.first_time() {
                    eprintln!(
                        "pirate: cannot resize the terminal: {e}. \
                         pirate reports this fault one time only."
                    );
                }
            }
            true
        }
        Ok(ClientFrame::Dump) => {
            *dump_pending = true;
            true
        }
        // The browser is untrusted. A frame that does not decode is dropped,
        // and the session continues.
        Err(e) => {
            if DECODE_REPORTED.first_time() {
                eprintln!(
                    "pirate: dropped a frame from the browser: {e}. \
                     pirate reports this fault one time only."
                );
            }
            true
        }
    }
}

/// A flag that lets one message through for the life of the process.
///
/// CAUTION: Keep every log line of this module behind one of these. The client
/// is untrusted and it holds the socket open, so a line for each fault is a way
/// to flood stderr. 20000 one-byte frames wrote 20000 lines and 1.6 MB of log.
/// `eprintln!` also takes the lock of stderr and writes at once, inside an
/// async task, so a slow reader of that log stops a worker thread of tokio.
///
/// `auth::hint_unknown_host` and the silent handshake failure of `tls.rs` hold
/// the same rule.
pub(crate) struct OnceFlag(AtomicBool);

impl OnceFlag {
    pub(crate) const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// True the first time it is called, and false for every later call.
    pub(crate) fn first_time(&self) -> bool {
        !self.0.swap(true, Ordering::Relaxed)
    }
}

/// The guard of the frame that did not decode.
static DECODE_REPORTED: OnceFlag = OnceFlag::new();
/// The guard of the resize that the PTY refused.
static RESIZE_REPORTED: OnceFlag = OnceFlag::new();
