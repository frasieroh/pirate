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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse as _, Response};
use futures_util::{SinkExt as _, StreamExt as _};

use crate::protocol::{server_tag, ClientFrame};
use crate::session::{Frames, Session, DEFAULT_COLS, DEFAULT_ROWS, OUTPUT_BATCH};
use crate::AppState;

/// Upgrade the request, then start one session for it.
///
/// `WebSocketUpgrade` is the last argument, because it consumes the request.
pub async fn upgrade(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Both tests answer before `on_upgrade`. That order is what stops an
    // unauthenticated request from starting a PTY and a shell.
    if !crate::auth::origin_ok(&headers, state.tls) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !state.auth.is_authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let shell = state.shell.clone();
    ws.on_upgrade(move |socket| handle(socket, shell))
}

/// Serve one terminal.
async fn handle(socket: WebSocket, shell: PathBuf) {
    // The browser sends its true size as a resize frame right after it
    // connects. These two values hold until then.
    let (mut session, frames) = match Session::spawn(&shell, DEFAULT_COLS, DEFAULT_ROWS) {
        Ok(started) => started,
        Err(e) => {
            // The client drives this path: it opens a socket, the spawn
            // fails, and it opens another. See the CAUTION on `OnceFlag`.
            if SPAWN_REPORTED.first_time() {
                eprintln!(
                    "pirate: cannot start `{}`: {e}. \
                     pirate reports this fault one time only.",
                    shell.display()
                );
            }
            return;
        }
    };

    pump(socket, &mut session, frames).await;

    // Both a clean close and a dropped connection arrive here. The shell must
    // not survive either one.
    session.shutdown().await;
}

/// Carry frames both ways until one side ends the connection.
async fn pump(socket: WebSocket, session: &mut Session, mut frames: Frames) {
    let (mut sink, mut stream) = socket.split();

    loop {
        tokio::select! {
            // Both branches are cancel safe. `Frames::next` awaits a channel
            // receive only, and the socket stream keeps its state in itself.
            frame = frames.next() => {
                let Some(frame) = frame else { break };
                if !drain(&mut sink, &mut frames, frame).await {
                    break;
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if !apply(session, &bytes).await {
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
async fn apply(session: &mut Session, bytes: &[u8]) -> bool {
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
            session.request_dump();
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
/// The silent handshake failure of `tls.rs` holds the same rule.
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
/// The guard of the shell that would not start.
static SPAWN_REPORTED: OnceFlag = OnceFlag::new();

#[cfg(test)]
mod tests {
    use super::OnceFlag;

    #[test]
    fn the_guard_lets_one_message_through_and_then_stops() {
        // The client is untrusted and it holds the socket open. A log line for
        // each malformed frame is a way to flood stderr: 20000 one-byte frames
        // wrote 20000 lines and 1.6 MB of log against the real binary.
        let flag = OnceFlag::new();
        assert!(flag.first_time(), "the first fault must reach the operator");
        for _ in 0..20_000 {
            assert!(!flag.first_time(), "every later fault must be silent");
        }
    }
}
