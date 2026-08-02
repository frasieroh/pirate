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

/// Wait for `stream` to close, and fail when it stays open past 20 deadlines.
///
/// The two tests below are the adversarial pair of
/// `a_partial_request_head_is_closed_at_the_deadline`. Each one holds a
/// connection with a request head that is NOT complete, so the deadline must
/// end it in the same way.
async fn assert_closed(stream: &mut TcpStream, what: &str) {
    let mut buffer = [0u8; 1024];
    let read = tokio::time::timeout(HEAD * 20, stream.read(&mut buffer))
        .await
        .unwrap_or_else(|_| panic!("{what}: the server held the connection past 20 deadlines"));
    match read {
        Ok(0) => {}
        Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
        // The deadline reaches hyper as a read error, and hyper refuses the
        // request before it closes. A refusal that ends the connection is the
        // result that this test asks for, and it tells the client more than a
        // silent reset does. The read after it must reach the end of the file,
        // because a server that answers and then HOLDS the socket still holds
        // the resource.
        Ok(count) if buffer[..count].starts_with(b"HTTP/1.1 4") => {
            let mut rest = Vec::new();
            let drained = tokio::time::timeout(HEAD * 20, stream.read_to_end(&mut rest))
                .await
                .unwrap_or_else(|_| panic!("{what}: the server answered and held the socket"));
            drained.unwrap_or_else(|e| panic!("{what}: the drain failed: {e}"));
        }
        Ok(count) => panic!(
            "{what}: the server answered with {count} bytes: {:?}",
            String::from_utf8_lossy(&buffer[..count])
        ),
        Err(e) => panic!("{what}: the read failed for another reason: {e}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_head_that_opens_with_a_blank_line_still_meets_the_deadline() {
    // RFC 9112 lets a server ignore an empty line before the request line, and
    // httparse skips every one of them. These two bytes are therefore NOT a
    // request head: hyper is still waiting for the request line after them.
    //
    // The wrapper counts newlines and nothing else, so these two bytes reach
    // HEAD_NEWLINES and disarm the deadline for the life of the connection.
    // The client then holds the connection with no request at all.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"\n\n").await.unwrap();
    stream.flush().await.unwrap();

    assert_closed(&mut stream, "a head that opens with a blank line").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_request_head_on_the_same_connection_still_meets_the_deadline() {
    // HTTP/1.1 keeps the connection open after an answer, and the head of the
    // next request arrives on the same socket. That head needs its own
    // deadline, because the connection is not a WebSocket: the pass-through
    // rule exists for the frames that follow an upgrade, and this connection
    // upgraded nothing.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let first = format!("GET /auth HTTP/1.1\r\nHost: {addr}\r\n\r\n");
    stream.write_all(first.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    // Read the answer to the first request, so the connection is idle and in
    // keep-alive when the second head starts.
    let mut buffer = [0u8; 1024];
    let count = tokio::time::timeout(WAIT, stream.read(&mut buffer))
        .await
        .expect("the answer to the first request timed out")
        .expect("the read of the first answer failed");
    let text = String::from_utf8_lossy(&buffer[..count]);
    assert!(
        text.starts_with("HTTP/1.1 204"),
        "with no token gate, /auth answers 204. Got: {text:?}"
    );

    // The slowloris shape, one request later.
    stream.write_all(b"GET /auth HTTP/1.1\r\n").await.unwrap();
    stream.flush().await.unwrap();

    assert_closed(&mut stream, "a second head on a keep-alive connection").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_dribbles_after_a_complete_head_still_meets_a_deadline() {
    // `POST /auth` takes its body as `Bytes`, and that extractor runs before
    // the handler. The head is complete here, so the wrapper is a pass-through
    // and no deadline covers the 1024 bytes that follow. One byte a minute
    // holds this connection and its task for seventeen hours, which is the
    // shape that the wrapper exists to stop.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let head = format!("POST /auth HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 1024\r\n\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(b"a").await.unwrap();
    stream.flush().await.unwrap();

    assert_closed(&mut stream, "a body that dribbles after a complete head").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgrade_on_a_reused_connection_still_becomes_a_pass_through() {
    // `note_answer` reads the status line of the FIRST write of the connection
    // and then sets `answered`, so it never looks again. A connection that
    // answered something else first therefore never records its 101, and the
    // wrapper keeps arming a deadline on a socket that now carries terminal
    // frames. The operator who reads the screen for ten seconds loses the
    // terminal.
    //
    // A client reaches this by reusing one keep-alive connection: `GET /auth`
    // first, then the upgrade. Nothing in HTTP/1.1 forbids that order.
    let addr = start().await;
    let mut stream = TcpStream::connect(addr).await.unwrap();

    // 1. An ordinary request, so the first write of the connection is a 204.
    let first = format!("GET /auth HTTP/1.1\r\nHost: {addr}\r\n\r\n");
    stream.write_all(first.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut buffer = [0u8; 4096];
    let count = tokio::time::timeout(WAIT, stream.read(&mut buffer))
        .await
        .expect("the answer to the first request timed out")
        .expect("the read of the first answer failed");
    assert!(
        String::from_utf8_lossy(&buffer[..count]).starts_with("HTTP/1.1 204"),
        "with no token gate, /auth answers 204"
    );

    // 2. The upgrade, on the same connection.
    let upgrade = format!(
        "GET /ws HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\n\
         Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://{addr}\r\n\r\n"
    );
    stream.write_all(upgrade.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut answer = Vec::new();
    while !answer.windows(4).any(|w| w == b"\r\n\r\n") {
        let count = tokio::time::timeout(WAIT, stream.read(&mut buffer))
            .await
            .expect("the answer to the upgrade timed out")
            .expect("the read of the upgrade answer failed");
        assert!(
            count > 0,
            "the server closed before it answered the upgrade"
        );
        answer.extend_from_slice(&buffer[..count]);
    }
    let text = String::from_utf8_lossy(&answer);
    assert!(
        text.starts_with("HTTP/1.1 101"),
        "the reused connection must still upgrade. Got: {text:?}"
    );

    // 3. Ten deadlines with no byte from the client. The socket now carries
    //    terminal frames, so it must stay open.
    let until = tokio::time::Instant::now() + HEAD * 10;
    loop {
        let left = until.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, stream.read(&mut buffer)).await {
            // Idle and still open, which is what an upgraded socket must be.
            Err(_) => break,
            Ok(Ok(0)) => panic!("the server closed the upgraded connection"),
            Ok(Err(e)) if e.kind() == ErrorKind::ConnectionReset => {
                panic!("the server reset the upgraded connection")
            }
            // The first dump of the session, and the frames after it.
            Ok(Ok(_)) => {}
            Ok(Err(e)) => panic!("the read failed for another reason: {e}"),
        }
    }
}
