//! The read deadline on the request headers, on a real server.
//!
//! Every server here binds through [`pirate::timeout::Timeout`], which is the
//! wrapper that `main.rs` uses, so these tests cover the real stack. The
//! deadline is 200 ms instead of `timeout::HEADER_TIMEOUT`, so a test that
//! waits for it waits for a fraction of a second.

use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use pirate::protocol::{ClientFrame, ServerFrame};
use pirate::timeout::Timeout;
use pirate::{router, AppState};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// The deadline that these servers give a request head.
const HEAD: Duration = Duration::from_millis(200);

/// Every wait uses this timeout. A hung test must fail and not block the run.
const WAIT: Duration = Duration::from_secs(10);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Start a server that gives each request head [`HEAD`].
async fn start() -> SocketAddr {
    let state = Arc::new(AppState::plain(None, PathBuf::from("/bin/cat")));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        // CAUTION: This is the wrapper that `main.rs` binds through. A test
        // that serves the plain listener here measures nothing.
        let _ = axum::serve(Timeout::new(pirate::NoDelay(listener), HEAD), router(state)).await;
    });
    addr
}

/// Open a WebSocket to `/ws` on `addr`.
async fn connect(addr: SocketAddr) -> Socket {
    let request = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws"))
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", format!("http://{addr}"))
        .body(())
        .unwrap();
    let (socket, _) = tokio::time::timeout(WAIT, tokio_tungstenite::connect_async(request))
        .await
        .expect("the WebSocket handshake timed out")
        .expect("the WebSocket handshake failed");
    socket
}

/// Read output frames until the text holds `needle`.
async fn read_until(socket: &mut Socket, needle: &str) -> String {
    let deadline = Instant::now() + WAIT;
    let mut text = String::new();
    while Instant::now() < deadline {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("timed out waiting for a frame")
            .expect("the socket closed before a frame arrived")
            .expect("the socket failed");
        let Message::Binary(bytes) = message else {
            continue;
        };
        match ServerFrame::decode(&bytes) {
            Ok(ServerFrame::Output(bytes) | ServerFrame::Dump(bytes)) => {
                text.push_str(&String::from_utf8_lossy(bytes));
            }
            Ok(ServerFrame::Exit(status)) => {
                panic!("the process exited with {status} before `{needle}` arrived")
            }
            Err(e) => panic!("a server frame did not decode: {e}"),
        }
        if text.contains(needle) {
            return text;
        }
    }
    panic!("`{needle}` never arrived. Got: {text:?}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_partial_request_head_is_closed_at_the_deadline() {
    // This is the slowloris shape. The client writes the request line and then
    // sends nothing, and no bound of `axum::serve` ends the connection.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"GET /auth HTTP/1.1\r\n").await.unwrap();
    stream.flush().await.unwrap();

    let at = Instant::now();
    let mut buffer = [0u8; 1024];
    let read = tokio::time::timeout(HEAD * 20, stream.read(&mut buffer))
        .await
        .expect("the server held the partial head open past 20 deadlines");
    let took = at.elapsed();

    match read {
        // The server dropped the connection. Both forms mean the same thing:
        // an orderly close gives end of file, and a close with bytes still
        // unread gives a reset.
        Ok(0) => {}
        Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
        Ok(count) => panic!(
            "the server answered a partial head with {count} bytes: {:?}",
            String::from_utf8_lossy(&buffer[..count])
        ),
        Err(e) => panic!("the read failed for another reason: {e}"),
    }
    assert!(
        took >= HEAD,
        "the server closed after {took:?}, which is before the deadline"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_complete_request_still_gets_its_answer() {
    // The deadline must cost a legitimate client nothing.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let request = format!("GET /auth HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut answer = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut answer))
        .await
        .expect("the HTTP answer timed out")
        .expect("the read of the HTTP answer failed");

    let text = String::from_utf8_lossy(&answer);
    assert!(
        text.starts_with("HTTP/1.1 204"),
        "with no token gate, /auth answers 204. Got: {text:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_websocket_survives_many_deadlines() {
    // THE test of this wrapper. The first request on a `/ws` connection is the
    // upgrade, and every byte after it is a WebSocket frame that arrives when
    // the operator types. A wrapper that arms a second deadline closes the
    // terminal of an operator who reads the screen for a moment.
    let addr = start().await;
    let mut socket = connect(addr).await;

    // Ten deadlines with no byte from the client.
    tokio::time::sleep(HEAD * 10).await;

    // The socket must still carry input and output.
    tokio::time::timeout(
        WAIT,
        socket.send(Message::binary(ClientFrame::Input(b"hello\n").encode())),
    )
    .await
    .expect("the send timed out")
    .expect("the idle socket refused the input");

    let text = read_until(&mut socket, "hello").await;
    assert!(text.contains("hello"), "got {text:?}");
}
