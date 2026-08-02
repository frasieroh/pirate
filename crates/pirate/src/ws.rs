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
    if !crate::auth::origin_ok(&headers, state.tls, &state.hosts) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !state.auth.is_authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let shell = state.shell.clone();
    ws.on_upgrade(move |socket| handle(socket, shell))
}

async fn handle(socket: WebSocket, shell: PathBuf) {
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
                    // A text frame is not in the protocol table. Ignore it.
                    // axum answers a ping itself.
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
                eprintln!("pirate: cannot resize the terminal: {e}");
            }
            true
        }
        // The browser is untrusted. A frame that does not decode is dropped,
        // and the session continues.
        Err(e) => {
            eprintln!("pirate: dropped a frame from the browser: {e}");
            true
        }
    }
}
