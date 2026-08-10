//! One real server, one real socket, and the files that a scenario needs.
//!
//! Every measurement of this crate runs against the real code path: a real
//! listener, a real WebSocket, a real PTY, and the real terminal thread.

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use pirate::protocol::ClientFrame;
use pirate::{router, AppState};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// The error type of every benchmark function.
pub type BoxError = Box<dyn std::error::Error>;

/// One WebSocket from a benchmark to a pirate server.
pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Start one pirate server on an ephemeral port, with this program as the shell.
///
/// # Errors
///
/// Fails when the listener does not bind.
pub async fn start(shell: PathBuf) -> Result<SocketAddr, BoxError> {
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
///
/// # Errors
///
/// Fails when the request does not build or the handshake does not complete.
pub async fn connect(addr: SocketAddr) -> Result<Socket, BoxError> {
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

/// Send one client frame.
///
/// # Errors
///
/// Fails when the socket is gone.
pub async fn send(socket: &mut Socket, frame: ClientFrame<'_>) -> Result<(), BoxError> {
    socket.send(Message::binary(frame.encode())).await?;
    Ok(())
}

/// The next binary frame, or None when the stream stays quiet for `quiet`.
pub async fn next_frame(socket: &mut Socket, quiet: Duration) -> Option<Vec<u8>> {
    loop {
        match tokio::time::timeout(quiet, socket.next()).await {
            Err(_) | Ok(None) | Ok(Some(Err(_))) => return None,
            Ok(Some(Ok(Message::Binary(bytes)))) => return Some(bytes.to_vec()),
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// Write one executable script and give back its path.
///
/// # Errors
///
/// Fails when the file does not write.
pub fn write_script(dir: &Path, name: &str, body: &str) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    std::fs::write(&path, body)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

/// `crates/pirate-bench/fixtures`, from the manifest directory of this crate.
#[must_use]
pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}
