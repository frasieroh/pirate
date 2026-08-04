//! pirate — a terminal emulator proxy.
//!
//! A PTY runs here. The browser runs the terminal emulator as WebAssembly and
//! renders the result. This crate serves the web client and the WebSocket that
//! carries the PTY bytes.
//!
//! The binary in `main.rs` is a thin wrapper on this library. The library form
//! lets the integration tests start a real server on an ephemeral port.

pub mod assets;
pub mod auth;
pub mod protocol;
pub mod session;
pub mod terminal;
pub mod tls;
mod ws;

use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;

/// What the routes need at run time.
#[derive(Debug)]
pub struct AppState {
    /// Serve the web assets from this directory instead of from the binary.
    pub assets_dir: Option<PathBuf>,
    /// The program that each new WebSocket connection starts.
    pub shell: PathBuf,
    /// The authentication state of the server.
    pub auth: auth::Auth,
    /// True when the server serves TLS.
    ///
    /// Two decisions read this value: the `Secure` flag of the session cookie,
    /// and the scheme that the Origin check expects.
    pub tls: bool,
}

impl AppState {
    /// A state with no authentication and no TLS.
    ///
    /// The benchmarks and some tests measure the wire only, so they use this.
    #[must_use]
    pub fn plain(assets_dir: Option<PathBuf>, shell: PathBuf) -> Self {
        Self {
            assets_dir,
            shell,
            auth: auth::Auth::disabled(),
            tls: false,
        }
    }
}

/// Build the routes. Each session gets a login shell.
///
/// `/ws` is the terminal, `/auth` takes the token, and every other path is a
/// web asset.
pub fn router(state: Arc<AppState>) -> Router {
    router_with_login(state, true)
}

/// Build the routes and choose the form of the session shell.
///
/// With `login` true, each session shell reads the login profile. `--no-login`
/// gives false here. The `arg0` function of `session.rs` holds the mechanism.
///
/// The form is an argument of this function and not a field of [`AppState`],
/// so the callers of the `AppState` constructors need no edit.
pub fn router_with_login(state: Arc<AppState>, login: bool) -> Router {
    Router::new()
        .route("/ws", ws::route(login))
        // The web assets stay public, because they are public JavaScript and a
        // public WebAssembly module. `/ws` is the gate that holds the shell.
        .route(
            "/auth",
            get(auth::get)
                .post(auth::post)
                // A token is 64 characters. This bound stops an unauthenticated
                // request from asking the server for a large allocation.
                .layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .fallback(asset_handler)
        .with_state(state)
}

/// A listener that turns off Nagle's algorithm on each connection it accepts.
///
/// Nagle holds a small write until the peer acknowledges the write before it.
/// A terminal sends small frames and waits for no acknowledgment, so Nagle and
/// the delayed acknowledgment of the peer add tens of milliseconds to one
/// keystroke on a link that is not loopback. `axum::serve` sets no socket
/// option, so pirate sets this one here. Every server in the repository binds
/// through this type, and the benchmarks therefore measure the real socket.
pub struct NoDelay(pub tokio::net::TcpListener);

impl axum::serve::Listener for NoDelay {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        // The inner call holds the backoff that axum applies to a failed
        // accept, so this type delegates to it and adds the option only.
        let (stream, addr) = axum::serve::Listener::accept(&mut self.0).await;
        if let Err(e) = stream.set_nodelay(true) {
            // The connection works without the option. It is only slower.
            eprintln!("pirate: cannot set TCP_NODELAY: {e}");
        }
        (stream, addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

async fn asset_handler(
    State(state): State<Arc<AppState>>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    assets::serve(uri.path(), &headers, state.assets_dir.as_ref()).await
}
