//! Integration tests: a real server, a real WebSocket, a real PTY.
//!
//! Each test starts the server on an ephemeral port, connects a WebSocket
//! client, and reads the bytes that come back. Every test uses a deterministic
//! program instead of an interactive shell, and every wait has a timeout, so a
//! failure cannot hang the suite.

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use pirate::auth::Auth;
use pirate::protocol::{ClientFrame, ServerFrame};
use pirate::{router, AppState};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Every wait in this file uses this timeout. A PTY on a loaded machine can
/// take a moment, and a hung test must still fail instead of blocking the run.
const WAIT: Duration = Duration::from_secs(10);

/// Time that a process gets to disappear after the browser goes away.
///
/// The server waits 500 ms after SIGHUP and 500 ms after SIGKILL, so this
/// value holds both steps and a margin.
const DEATH_WAIT: Duration = Duration::from_secs(5);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

// --- Test scaffolding --- //

/// Start the server on an ephemeral port and give back its address.
///
/// This form has no authentication and no TLS.
async fn start(shell: PathBuf) -> SocketAddr {
    start_with(Arc::new(AppState::plain(None, shell))).await
}

/// Start the server with a state that the caller built.
///
/// The authentication tests choose the `Auth` value, so they call this one.
async fn start_with(state: Arc<AppState>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(pirate::NoDelay(listener), router(state)).await;
    });
    addr
}

/// Build a `/ws` handshake request with a chosen `Origin` and a chosen cookie.
///
/// `connect_async` on a URL sends no `Origin` header, and `/ws` answers 403
/// without that header. Every client in this file therefore builds the request
/// itself. tungstenite writes the five WebSocket headers from the map, so the
/// map must hold all of them.
fn ws_request(addr: SocketAddr, origin: Option<&str>, cookie: Option<&str>) -> Request<()> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws"))
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key());
    if let Some(origin) = origin {
        builder = builder.header("Origin", origin);
    }
    if let Some(cookie) = cookie {
        builder = builder.header("Cookie", cookie);
    }
    builder.body(()).unwrap()
}

/// The `Origin` that this server accepts.
fn own_origin(addr: SocketAddr) -> String {
    format!("http://{addr}")
}

/// Complete a handshake, or give back the error that ended it.
async fn try_connect(request: Request<()>) -> Result<Socket, WsError> {
    let (socket, _) = tokio::time::timeout(WAIT, tokio_tungstenite::connect_async(request))
        .await
        .expect("the WebSocket handshake timed out")?;
    Ok(socket)
}

/// The status of a handshake that the server refused.
fn refusal_status(error: &WsError) -> u16 {
    match error {
        WsError::Http(response) => response.status().as_u16(),
        other => panic!("the server refused with no HTTP status: {other:?}"),
    }
}

async fn connect(addr: SocketAddr) -> Socket {
    try_connect(ws_request(addr, Some(&own_origin(addr)), None))
        .await
        .expect("the WebSocket handshake failed")
}

async fn send(socket: &mut Socket, frame: ClientFrame<'_>) {
    tokio::time::timeout(WAIT, socket.send(Message::binary(frame.encode())))
        .await
        .expect("the send timed out")
        .expect("the send failed");
}

/// Take the next binary message. Every other message kind is skipped.
async fn next_binary(socket: &mut Socket) -> Vec<u8> {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("timed out waiting for a frame")
            .expect("the socket closed before a frame arrived")
            .expect("the socket failed");
        if let Message::Binary(bytes) = message {
            return bytes.to_vec();
        }
    }
}

/// Read output frames until the text holds `needle`, then give back the text.
async fn read_until(socket: &mut Socket, needle: &str) -> String {
    let deadline = Instant::now() + WAIT;
    let mut text = String::new();
    while Instant::now() < deadline {
        let frame = next_binary(socket).await;
        match ServerFrame::decode(&frame) {
            Ok(ServerFrame::Output(bytes) | ServerFrame::Dump(bytes)) => {
                text.push_str(&String::from_utf8_lossy(bytes));
            }
            Ok(ServerFrame::Exit(status)) => {
                panic!("the process exited with {status} before `{needle}` arrived. Got: {text:?}")
            }
            Err(e) => panic!("a server frame did not decode: {e}"),
        }
        if text.contains(needle) {
            return text;
        }
    }
    panic!("`{needle}` never arrived. Got: {text:?}")
}

/// Read frames until a dump arrives, then give back the screen as text.
async fn read_dump(socket: &mut Socket) -> String {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let frame = next_binary(socket).await;
        match ServerFrame::decode(&frame) {
            Ok(ServerFrame::Dump(bytes)) => return String::from_utf8_lossy(bytes).into_owned(),
            Ok(ServerFrame::Output(_)) => {}
            Ok(ServerFrame::Exit(status)) => {
                panic!("the process exited with {status} before a dump arrived")
            }
            Err(e) => panic!("a server frame did not decode: {e}"),
        }
    }
    panic!("no dump arrived")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pirate-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

/// Wait for a script to write its process identifiers into a file.
async fn read_pids(path: &Path) -> Vec<i32> {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            let pids: Vec<i32> = text
                .split_whitespace()
                .filter_map(|word| word.parse().ok())
                .collect();
            if !pids.is_empty() {
                return pids;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{} never held a process identifier", path.display())
}

fn is_alive(pid: i32) -> bool {
    match rustix::process::Pid::from_raw(pid) {
        Some(pid) => rustix::process::test_kill_process(pid).is_ok(),
        None => false,
    }
}

/// Wait for a process to disappear. The result is false on a timeout.
async fn wait_until_gone(pid: i32, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    !is_alive(pid)
}

// --- A raw HTTP client for /auth --- //

/// The status and the headers of one HTTP answer.
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
}

impl Answer {
    /// The value of the first header with this name.
    ///
    /// A header name is not case sensitive, so the search ignores case.
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Send one HTTP request to `addr` and read the whole answer.
///
/// `/auth` is not a WebSocket, so the WebSocket client cannot reach it. This
/// helper writes the request bytes itself, which adds no dependency.
/// `Connection: close` ends the stream after the answer, so the read needs no
/// parse of the body length.
async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    extra: &[(&str, &str)],
    body: &str,
) -> Answer {
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in extra {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(body);

    let mut stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
        .await
        .expect("the connection to the server timed out")
        .expect("the connection to the server failed");
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut raw = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut raw))
        .await
        .expect("the HTTP answer timed out")
        .expect("the read of the HTTP answer failed");
    parse_answer(&String::from_utf8_lossy(&raw))
}

/// Take the status and the headers out of one HTTP answer.
fn parse_answer(text: &str) -> Answer {
    let head = text.split("\r\n\r\n").next().unwrap_or_default();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let Some(status) = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
    else {
        panic!("this is not an HTTP answer: {text:?}")
    };
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    Answer { status, headers }
}

/// Post `token` to `/auth` from an `Origin` that this server accepts.
async fn post_token(addr: SocketAddr, token: &str) -> Answer {
    let origin = own_origin(addr);
    http(addr, "POST", "/auth", &[("Origin", origin.as_str())], token).await
}

/// The `name=value` pair at the start of a `Set-Cookie` value.
fn cookie_pair(set_cookie: &str) -> &str {
    set_cookie.split(';').next().unwrap_or_default()
}

/// Post the token, then give back the `Cookie` header of the new session.
async fn login(addr: SocketAddr, token: &str) -> String {
    let answer = post_token(addr, token).await;
    assert_eq!(
        answer.status, 204,
        "the correct token did not create a session"
    );
    cookie_pair(
        answer
            .header("set-cookie")
            .expect("a new session must arrive in a Set-Cookie header"),
    )
    .to_string()
}

// --- A server with the token gate on --- //

/// A server that asks for a token, and the token that opens it.
struct GuardedServer {
    addr: SocketAddr,
    token: String,
}

/// Start a server with the token gate on.
///
/// `Token` gives no accessor, so this function reads the text of the token file
/// that `load_or_create` wrote. `secure_cookie` adds `Secure` to the session
/// cookie.
async fn start_guarded(name: &str, shell: PathBuf, secure_cookie: bool) -> GuardedServer {
    // The directory of the token file must be mode 0700, and `load_or_create`
    // creates it. Therefore the path names a directory that does not exist yet.
    let path = temp_dir(name).join("pirate").join("auth_token");
    let token = pirate::auth::load_or_create(&path).expect("the token file did not open");
    let text = std::fs::read_to_string(&path).unwrap().trim().to_string();

    let state = Arc::new(AppState {
        assets_dir: None,
        shell,
        auth: Auth::enabled(token, secure_cookie),
        hosts: pirate::auth::HostAllow::Any,
        tls: false,
        terminals: pirate::Terminals::default(),
    });
    GuardedServer {
        addr: start_with(state).await,
        token: text,
    }
}

// --- The pirate binary as a child process --- //

/// A child process that a drop always kills.
///
/// A test that fails between the start and the kill must leave no server
/// behind, so the kill belongs here and not at the end of the test.
struct Child {
    inner: std::process::Child,
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.inner.kill();
        let _ = self.inner.wait();
    }
}

/// Start the pirate binary with `args`, `HOME` at `home`, and both pipes taken.
fn start_binary(home: &Path, args: &[&str]) -> Child {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_pirate"));
    command
        .args(args)
        .env("HOME", home)
        // The two flags read an environment variable of their own. A value in
        // the environment of the test runner must not change the child.
        .env_remove("PIRATE_BIND")
        .env_remove("PIRATE_PORT")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    Child {
        inner: command.spawn().expect("the pirate binary did not start"),
    }
}

/// Read one pipe to its end on a thread of its own.
///
/// The child writes to stdout and to stderr at the same time. A reader that
/// takes one pipe to its end and then the other can block, so each pipe gets a
/// thread.
fn drain_pipe<R>(pipe: R) -> (Arc<Mutex<String>>, std::thread::JoinHandle<()>)
where
    R: std::io::Read + Send + 'static,
{
    let text = Arc::new(Mutex::new(String::new()));
    let handle = {
        let text = Arc::clone(&text);
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buffer = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut pipe, &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let chunk = String::from_utf8_lossy(&buffer[..count]).into_owned();
                        text.lock().unwrap().push_str(&chunk);
                    }
                }
            }
        })
    };
    (text, handle)
}

/// Wait for the line of the child that names the address of its listener.
async fn wait_for_address(output: &Arc<Mutex<String>>) -> SocketAddr {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        let seen = output.lock().unwrap().clone();
        if let Some(rest) = seen.split("listening on http://").nth(1) {
            // A partial line gives no address, and the next pass reads again.
            if let Some(Ok(addr)) = rest.split('\n').next().map(|line| line.trim().parse()) {
                return addr;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "the binary never printed its address. Got: {}",
        output.lock().unwrap()
    )
}

/// Wait for the child to exit, and give back its status.
async fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if let Some(status) = child.inner.try_wait().unwrap() {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the binary did not exit inside the timeout")
}

// --- Tests --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_frame_is_a_state_dump() {
    let addr = start(PathBuf::from("/bin/cat")).await;
    let mut socket = connect(addr).await;

    let frame = next_binary(&mut socket).await;
    assert_eq!(frame[0], 0x01, "the first frame must carry the dump tag");
    assert!(matches!(
        ServerFrame::decode(&frame),
        Ok(ServerFrame::Dump(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pty_sends_input_back() {
    // `cat` is deterministic and it never waits for a prompt. The line
    // discipline of the PTY sends the input back, and `cat` sends it a second
    // time, so `hello` arrives twice.
    let addr = start(PathBuf::from("/bin/cat")).await;
    let mut socket = connect(addr).await;

    send(&mut socket, ClientFrame::Input(b"hello\n")).await;

    let text = read_until(&mut socket, "hello").await;
    assert!(text.contains("hello"), "got {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_arrives_whole_and_in_far_fewer_messages_than_reads() {
    // The server joins the output that its queues already hold. This test
    // holds both halves of that contract: every byte arrives, in order, and
    // the message count is far below the count of PTY reads that carried it.
    //
    // `seq` writes a known stream that no line of the output can produce by
    // chance, and each line names its own place in the order.
    let dir = temp_dir("burst");
    let script = write_script(&dir, "burst.sh", "#!/bin/sh\nstty -echo\nseq 1 8000\n");
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    let mut text = String::new();
    let mut messages = 0_usize;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline && !text.contains("\r\n8000\r\n") {
        let frame = next_binary(&mut socket).await;
        if let Ok(ServerFrame::Output(bytes)) = ServerFrame::decode(&frame) {
            messages += 1;
            text.push_str(&String::from_utf8_lossy(bytes));
        }
    }

    // Every line, in order, and none missing.
    let lines: Vec<&str> = text.trim_end().split("\r\n").collect();
    let expected: Vec<String> = (1..=8_000).map(|n| n.to_string()).collect();
    assert_eq!(
        lines.len(),
        expected.len(),
        "the burst lost or added a line"
    );
    for (got, want) in lines.iter().zip(&expected) {
        assert_eq!(got, want, "the burst arrived out of order");
    }

    // The burst is about 47 KB. A PTY read gives about 1 KB, so one message
    // per read is about 47 messages. The join brings that to 2 on this
    // machine. The bound is loose, and one message per read still breaks it.
    assert!(
        messages <= 12,
        "the burst arrived in {messages} messages, so the join did not happen"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resize_frame_reaches_the_pty() {
    // `stty size` reads the window size from the PTY itself, so this test
    // proves that the resize frame arrived at the kernel and not only at the
    // server-side terminal.
    let dir = temp_dir("resize");
    let script = write_script(
        &dir,
        "size.sh",
        "#!/bin/sh\nwhile read -r line; do stty size; done\n",
    );
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    send(
        &mut socket,
        ClientFrame::Resize {
            cols: 120,
            rows: 40,
        },
    )
    .await;
    send(&mut socket, ClientFrame::Input(b"\n")).await;

    // `stty size` prints the rows first, then the columns.
    let text = read_until(&mut socket, "40 120").await;
    assert!(text.contains("40 120"), "got {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dump_request_gives_the_screen_that_the_client_asked_for() {
    // A theme change rebuilds the terminal in the browser, and the new terminal
    // is empty. The client asks for a dump, and the dump carries the screen.
    let addr = start(PathBuf::from("/bin/cat")).await;
    let mut socket = connect(addr).await;

    // The dump of a new session. It comes before the request, so every later
    // dump in this test is the answer to the request.
    let first = next_binary(&mut socket).await;
    assert!(matches!(
        ServerFrame::decode(&first),
        Ok(ServerFrame::Dump(_))
    ));

    // Put text on the screen. The echo proves that the server-side terminal
    // wrote it, because the thread writes the bytes before it sends the frame.
    send(&mut socket, ClientFrame::Input(b"marker\n")).await;
    read_until(&mut socket, "marker").await;

    send(&mut socket, ClientFrame::Dump).await;

    let screen = read_dump(&mut socket).await;
    assert!(
        screen.contains("marker"),
        "the dump must carry the text of the screen: {screen:?}"
    );

    // The shell survived the request.
    send(&mut socket, ClientFrame::Input(b"still here\n")).await;
    let text = read_until(&mut socket, "still here").await;
    assert!(text.contains("still here"), "got {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flood_of_dump_requests_collapses_into_a_few_dumps() {
    // A dump formats the whole screen. A client that asks in a loop must not
    // make the server format in a loop, so the pump coalesces the requests and
    // holds one interval between two dumps.
    //
    // The test reads the interval of the server, so a change to the server
    // moves the ceiling of this test with it.
    const INTERVAL: Duration = pirate::DUMP_INTERVAL;
    /// Dumps that a slow machine can add on top of the computed ceiling.
    const MARGIN: u128 = 1;
    /// The longest pause between two requests of the flood.
    ///
    /// The requests must cover the whole window. A burst that ends in the first
    /// milliseconds collapses into one or two dumps whatever the interval is,
    /// and such a burst measures the coalesce only.
    const GAP: Duration = Duration::from_millis(2);
    const WINDOW: Duration = Duration::from_secs(1);

    let addr = start(PathBuf::from("/bin/cat")).await;
    let mut socket = connect(addr).await;

    // The dump of a new session, before the flood starts.
    let first = next_binary(&mut socket).await;
    assert!(matches!(
        ServerFrame::decode(&first),
        Ok(ServerFrame::Dump(_))
    ));

    // One loop sends the requests and reads the answers. The read timeout is
    // the pause between two requests, and it also takes each dump off the
    // socket while the flood runs.
    let started = Instant::now();
    let mut requests = 0_usize;
    let mut dumps = 0_usize;
    while let Some(left) = (started + WINDOW).checked_duration_since(Instant::now()) {
        send(&mut socket, ClientFrame::Dump).await;
        requests += 1;
        match tokio::time::timeout(GAP.min(left), socket.next()).await {
            // No frame waits, because the pump holds the next dump back.
            Err(_) => {}
            Ok(None) => panic!("the socket closed during the flood"),
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                if matches!(ServerFrame::decode(&bytes), Ok(ServerFrame::Dump(_))) {
                    dumps += 1;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("the socket failed: {e}"),
        }
    }

    // One dump goes out at once, and one more for each interval that the
    // window holds. MARGIN covers a machine that is slower than this one.
    let elapsed = started.elapsed().as_millis();
    let ceiling = 1 + elapsed / INTERVAL.as_millis() + MARGIN;
    assert!(
        u128::try_from(dumps).unwrap() <= ceiling,
        "{requests} requests gave {dumps} dumps in {elapsed} ms, and the ceiling is {ceiling}"
    );
    // The flood covers more than two intervals, so the pump must answer more
    // than the first request. A lower count means that it stopped.
    assert!(
        dumps >= 2,
        "{requests} requests gave {dumps} dumps in {elapsed} ms"
    );

    // The session still works: the socket is open, and input reaches the shell.
    send(&mut socket, ClientFrame::Input(b"still here\n")).await;
    let text = read_until(&mut socket, "still here").await;
    assert!(text.contains("still here"), "got {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exit_sends_the_status_and_closes() {
    let dir = temp_dir("exit");
    let script = write_script(&dir, "exit.sh", "#!/bin/sh\nexit 7\n");
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    let deadline = Instant::now() + WAIT;
    let mut status = None;
    while Instant::now() < deadline && status.is_none() {
        let frame = next_binary(&mut socket).await;
        if let Ok(ServerFrame::Exit(code)) = ServerFrame::decode(&frame) {
            status = Some(code);
        }
    }
    assert_eq!(status, Some(7), "the exit status must reach the browser");

    // The server closes after the status. The next read gives a close or an
    // end of stream, and never another frame.
    let next = tokio::time::timeout(WAIT, socket.next())
        .await
        .expect("the server did not close after the exit frame");
    match next {
        None => {}
        Some(Ok(Message::Close(_))) => {}
        Some(other) => panic!("expected a close, and got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clean_close_ends_the_shell() {
    let dir = temp_dir("hangup");
    let script = write_script(
        &dir,
        "hangup.sh",
        "#!/bin/sh\necho $$ > \"$(dirname \"$0\")/pid\"\nexec cat\n",
    );
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    let pid = read_pids(&dir.join("pid")).await[0];
    assert!(is_alive(pid), "the shell must be running before the close");

    socket.close(None).await.unwrap();
    drop(socket);

    assert!(
        wait_until_gone(pid, DEATH_WAIT).await,
        "process {pid} survived a clean WebSocket close"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_connection_ends_the_shell() {
    let dir = temp_dir("dropped");
    let script = write_script(
        &dir,
        "dropped.sh",
        "#!/bin/sh\necho $$ > \"$(dirname \"$0\")/pid\"\nexec cat\n",
    );
    let addr = start(script).await;
    let socket = connect(addr).await;

    let pid = read_pids(&dir.join("pid")).await[0];
    assert!(is_alive(pid), "the shell must be running before the drop");

    // No close frame. The socket goes away, as it does when a browser tab
    // closes or a network path fails.
    drop(socket);

    assert!(
        wait_until_gone(pid, DEATH_WAIT).await,
        "process {pid} survived a dropped WebSocket connection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_that_ignores_sighup_still_dies() {
    let dir = temp_dir("stubborn");
    let script = write_script(
        &dir,
        "stubborn.sh",
        "#!/bin/sh\ntrap '' HUP\necho $$ > \"$(dirname \"$0\")/pid\"\nwhile true; do sleep 1; done\n",
    );
    let addr = start(script).await;
    let socket = connect(addr).await;

    let pid = read_pids(&dir.join("pid")).await[0];
    assert!(is_alive(pid), "the shell must be running before the drop");

    drop(socket);

    // SIGHUP has no effect here, so only the SIGKILL escalation can pass this.
    assert!(
        wait_until_gone(pid, DEATH_WAIT).await,
        "process {pid} ignored SIGHUP and the server never escalated"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_child_dies_with_its_shell() {
    // The signal goes to the process group, not to the direct child only. A
    // shell with a background job must leave no orphan.
    let dir = temp_dir("children");
    let script = write_script(
        &dir,
        "children.sh",
        "#!/bin/sh\nsleep 120 &\necho \"$$ $!\" > \"$(dirname \"$0\")/pid\"\nexec cat\n",
    );
    let addr = start(script).await;
    let socket = connect(addr).await;

    let pids = read_pids(&dir.join("pid")).await;
    assert_eq!(pids.len(), 2, "the script must report two processes");
    let (shell, background) = (pids[0], pids[1]);
    assert!(is_alive(background), "the background job must be running");

    drop(socket);

    assert!(
        wait_until_gone(shell, DEATH_WAIT).await,
        "the shell {shell} survived the disconnect"
    );
    assert!(
        wait_until_gone(background, DEATH_WAIT).await,
        "the background job {background} outlived its shell"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_client_gets_its_own_pty() {
    // There is no shared session. Two browsers get two shells, and neither one
    // sees the screen of the other.
    let addr = start(PathBuf::from("/bin/cat")).await;

    let mut first = connect(addr).await;
    send(&mut first, ClientFrame::Input(b"alpha\n")).await;
    read_until(&mut first, "alpha").await;

    let mut second = connect(addr).await;
    let dump = next_binary(&mut second).await;
    let ServerFrame::Dump(bytes) = ServerFrame::decode(&dump).unwrap() else {
        panic!("the first frame of the second client must be a dump")
    };
    let screen = String::from_utf8_lossy(bytes).into_owned();
    assert!(
        !screen.contains("alpha"),
        "the second client saw the screen of the first: {screen:?}"
    );

    // The second shell answers the second client only.
    send(&mut second, ClientFrame::Input(b"beta\n")).await;
    let text = read_until(&mut second, "beta").await;
    assert!(!text.contains("alpha"), "got {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_frame_does_not_end_the_session() {
    let addr = start(PathBuf::from("/bin/cat")).await;
    let mut socket = connect(addr).await;

    // Tag 0x7f is not in the protocol table, and a one-byte resize is short.
    socket
        .send(Message::binary(vec![0x7f, 0x01, 0x02]))
        .await
        .unwrap();
    socket
        .send(Message::binary(vec![0x01, 0x00]))
        .await
        .unwrap();
    socket.send(Message::binary(Vec::new())).await.unwrap();

    // The session still works.
    send(&mut socket, ClientFrame::Input(b"still here\n")).await;
    let text = read_until(&mut socket, "still here").await;
    assert!(text.contains("still here"), "got {text:?}");
}

// --- Authentication --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_websocket_with_no_session_cookie_is_refused() {
    let server = start_guarded("no-cookie", PathBuf::from("/bin/cat"), false).await;

    let request = ws_request(server.addr, Some(&own_origin(server.addr)), None);
    let error = try_connect(request)
        .await
        .expect_err("the upgrade must fail without a session");

    assert_eq!(refusal_status(&error), 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_websocket_with_a_valid_session_cookie_upgrades() {
    let server = start_guarded("with-cookie", PathBuf::from("/bin/cat"), false).await;
    let cookie = login(server.addr, &server.token).await;

    let request = ws_request(server.addr, Some(&own_origin(server.addr)), Some(&cookie));
    let mut socket = try_connect(request)
        .await
        .expect("a valid session must reach the terminal");

    let frame = next_binary(&mut socket).await;
    assert!(matches!(
        ServerFrame::decode(&frame),
        Ok(ServerFrame::Dump(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_token_creates_no_session() {
    let server = start_guarded("wrong-token", PathBuf::from("/bin/cat"), false).await;
    let wrong = "0".repeat(64);

    let answer = post_token(server.addr, &wrong).await;
    assert_eq!(answer.status, 401);
    assert!(
        answer.header("set-cookie").is_none(),
        "a wrong token must set no cookie"
    );

    // That exchange gave the client no cookie, so the client invents one. The
    // identifier has the right shape and names no session.
    let cookie = format!("pirate_session={wrong}");
    let request = ws_request(server.addr, Some(&own_origin(server.addr)), Some(&cookie));
    let error = try_connect(request)
        .await
        .expect_err("an invented cookie must not reach the terminal");

    assert_eq!(refusal_status(&error), 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cross_origin_upgrade_is_refused_with_a_valid_session() {
    // This is the attack that the Origin check closes: a page on another origin
    // opens a WebSocket to pirate, and the browser sends the session cookie of
    // the operator with it. The cookie here is valid, so a 403 proves that the
    // Origin check refused the handshake and not the session check.
    let server = start_guarded("cross-origin", PathBuf::from("/bin/cat"), false).await;
    let cookie = login(server.addr, &server.token).await;

    let request = ws_request(server.addr, Some("http://evil.example"), Some(&cookie));
    let error = try_connect(request)
        .await
        .expect_err("a cross-origin upgrade must fail");

    assert_eq!(refusal_status(&error), 403);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgrade_with_no_origin_header_is_refused() {
    let server = start_guarded("no-origin", PathBuf::from("/bin/cat"), false).await;
    let cookie = login(server.addr, &server.token).await;

    let request = ws_request(server.addr, None, Some(&cookie));
    let error = try_connect(request)
        .await
        .expect_err("an upgrade with no Origin must fail");

    assert_eq!(refusal_status(&error), 403);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_password_leaves_the_websocket_open() {
    // This is the state that `--no-password` builds.
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        auth: Auth::disabled(),
        hosts: pirate::auth::HostAllow::Any,
        tls: false,
        terminals: pirate::Terminals::default(),
    });
    let addr = start_with(state).await;

    let request = ws_request(addr, Some(&own_origin(addr)), None);
    let mut socket = try_connect(request)
        .await
        .expect("--no-password must leave /ws open");

    let frame = next_binary(&mut socket).await;
    assert!(matches!(
        ServerFrame::decode(&frame),
        Ok(ServerFrame::Dump(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_auth_route_reports_the_state_of_the_session() {
    let server = start_guarded("auth-get", PathBuf::from("/bin/cat"), false).await;

    let answer = http(server.addr, "GET", "/auth", &[], "").await;
    assert_eq!(answer.status, 401, "no cookie must give 401");

    let cookie = login(server.addr, &server.token).await;
    let answer = http(
        server.addr,
        "GET",
        "/auth",
        &[("Cookie", cookie.as_str())],
        "",
    )
    .await;
    assert_eq!(answer.status, 204, "a live session must give 204");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_session_cookie_carries_the_flags_that_hold_it_in_the_browser() {
    // `HttpOnly` keeps the cookie away from a script. `SameSite=Strict` keeps it
    // off a cross-site request. No `Max-Age` and no `Expires` make the browser
    // drop it when it closes.
    let plain = start_guarded("cookie-flags", PathBuf::from("/bin/cat"), false).await;
    let answer = post_token(plain.addr, &plain.token).await;
    let value = answer
        .header("set-cookie")
        .expect("the answer set no cookie")
        .to_string();

    assert!(value.contains("HttpOnly"), "{value}");
    assert!(value.contains("SameSite=Strict"), "{value}");
    assert!(value.contains("Path=/"), "{value}");
    assert!(!value.contains("Max-Age"), "{value}");
    assert!(!value.contains("Expires"), "{value}");
    assert!(
        !value.contains("Secure"),
        "plain HTTP must set no Secure flag: {value}"
    );

    // With TLS the cookie must never travel in the clear.
    let secure = start_guarded("cookie-secure", PathBuf::from("/bin/cat"), true).await;
    let answer = post_token(secure.addr, &secure.token).await;
    let value = answer
        .header("set-cookie")
        .expect("the answer set no cookie")
        .to_string();
    assert!(value.contains("Secure"), "{value}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rate_limiter_stops_a_burst_of_wrong_tokens() {
    let server = start_guarded("rate-limit", PathBuf::from("/bin/cat"), false).await;
    let wrong = "0".repeat(64);

    // The bucket holds 20 attempts. Each wrong token takes one, and the
    // attempts run back to back, so the refill of 5 per second adds little.
    let mut refused = 0;
    loop {
        let status = post_token(server.addr, &wrong).await.status;
        if status == 429 {
            break;
        }
        assert_eq!(status, 401, "a wrong token must give 401 or 429");
        refused += 1;
        assert!(refused < 100, "the bucket never emptied");
    }
    assert!(refused >= 20, "the bucket held only {refused} attempts");

    // REGRESSION. An earlier version spent an attempt on EVERY request, before
    // the comparison. An attacker who held the bucket empty then locked the
    // operator out of the shell: a flood of 300000 guesses made six correct
    // tokens in a row answer 429. The comparison now comes first, so a correct
    // token always works and only a wrong guess spends an attempt.
    let answer = post_token(server.addr, &server.token).await;
    assert_eq!(
        answer.status, 204,
        "an empty bucket must never refuse the correct token"
    );
    assert!(
        answer.header("set-cookie").is_some(),
        "the correct token must still create a session under a flood"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_correct_token_costs_the_rate_limiter_nothing() {
    let server = start_guarded("rate-refund", PathBuf::from("/bin/cat"), false).await;
    let wrong = "0".repeat(64);

    // 19 wrong tokens leave one attempt in a bucket of 20.
    for _ in 0..19 {
        assert_eq!(post_token(server.addr, &wrong).await.status, 401);
    }

    // Each correct token gives its attempt back. Without that refund, the
    // second of these three answers 429.
    for round in 0..3 {
        assert_eq!(
            post_token(server.addr, &server.token).await.status,
            204,
            "the correct token was charged to the bucket on round {round}"
        );
    }
}

// --- The token file --- //

#[test]
fn a_token_file_that_another_user_can_read_stops_the_start() {
    let directory = temp_dir("token-mode").join("pirate");
    let path = directory.join("auth_token");
    pirate::auth::load_or_create(&path).expect("the first call must write a token");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let text = format!("{}", pirate::auth::load_or_create(&path).unwrap_err());
    assert!(text.contains(&path.display().to_string()), "{text}");
    assert!(text.contains("chmod 600"), "{text}");

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
    let text = format!("{}", pirate::auth::load_or_create(&path).unwrap_err());
    assert!(text.contains(&directory.display().to_string()), "{text}");
    assert!(text.contains("chmod 700"), "{text}");

    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn a_missing_token_file_is_created_at_mode_0600() {
    let directory = temp_dir("token-new").join("pirate");
    let path = directory.join("auth_token");
    pirate::auth::load_or_create(&path).expect("the token file did not open");

    let file_mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(file_mode & 0o777, 0o600);
    let directory_mode = std::fs::metadata(&directory).unwrap().permissions().mode();
    assert_eq!(directory_mode & 0o777, 0o700);

    let token = std::fs::read_to_string(&path).unwrap().trim().to_string();
    assert_eq!(token.len(), 64, "the token is {} characters", token.len());
    assert!(
        token.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "the token is not hexadecimal: {token}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_call_gives_the_same_token() {
    let path = temp_dir("token-again").join("pirate").join("auth_token");
    pirate::auth::load_or_create(&path).expect("the first call must write a token");
    let first = std::fs::read_to_string(&path).unwrap().trim().to_string();

    // `Token` gives no accessor, so the value of the second call goes into a
    // live gate. The text that the first call wrote then opens that gate, or
    // the two values differ.
    let second = pirate::auth::load_or_create(&path).expect("the second call must read the token");
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        auth: Auth::enabled(second, false),
        hosts: pirate::auth::HostAllow::Any,
        tls: false,
        terminals: pirate::Terminals::default(),
    });
    let addr = start_with(state).await;

    assert_eq!(
        post_token(addr, &first).await.status,
        204,
        "the second call gave a different token"
    );
}

// --- The token never leaks --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_binary_never_writes_the_token_to_its_output() {
    // The operator reads the token from the token file. A token in the output
    // reaches every log collector and every terminal recording, so the binary
    // must never print it.
    let home = temp_dir("binary-token");
    let mut child = start_binary(
        &home,
        &["--bind", "127.0.0.1", "--port", "0", "--shell", "/bin/cat"],
    );
    let (stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let addr = wait_for_address(&stderr).await;

    // The server answers real requests before the test reads the output.
    assert_eq!(http(addr, "GET", "/auth", &[], "").await.status, 401);
    assert_eq!(http(addr, "GET", "/", &[], "").await.status, 200);

    let _ = child.inner.kill();
    let _ = child.inner.wait();
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let token = std::fs::read_to_string(home.join(".pirate").join("auth_token"))
        .expect("the binary wrote no token file")
        .trim()
        .to_string();
    assert_eq!(token.len(), 64, "the token is {} characters", token.len());

    let out = stdout.lock().unwrap().clone();
    let err = stderr.lock().unwrap().clone();
    assert!(!out.contains(&token), "the token reached stdout: {out}");
    assert!(!err.contains(&token), "the token reached stderr: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_loopback_bind_with_no_transport_flag_stops_the_start() {
    // 192.0.2.1 is TEST-NET-1. The transport test runs before the bind, so the
    // error names the missing flag and not a failed bind.
    let home = temp_dir("binary-transport");
    let mut child = start_binary(&home, &["--bind", "192.0.2.1", "--port", "0"]);
    let (_stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let status = wait_for_exit(&mut child).await;
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    assert!(
        !status.success(),
        "a non-loopback bind with no transport flag must fail"
    );
    let err = stderr.lock().unwrap().clone();
    for flag in ["--cert", "--selfsigned", "--plaintext"] {
        assert!(err.contains(flag), "the error does not name {flag}: {err}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ipv4_mapped_loopback_address_needs_no_transport_flag() {
    // REGRESSION. `Ipv6Addr::is_loopback` is true for `::1` only, so the mapped
    // form failed the test and pirate refused to start on an address that
    // reaches this machine only. The transport test unmaps first.
    let home = temp_dir("binary-mapped");
    let mut child = start_binary(&home, &["--bind", "::ffff:127.0.0.1", "--port", "0"]);
    let (_stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    // The server stays up when it accepted the address, so a short wait and a
    // still-running child is the pass. A refusal exits at once.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let running = child.inner.try_wait().unwrap().is_none();
    // `Child` kills the process and waits for it when it drops.
    drop(child);
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let err = stderr.lock().unwrap().clone();
    assert!(
        running,
        "pirate refused the IPv4-mapped loopback address: {err}"
    );
    assert!(
        !err.contains("needs a transport"),
        "the mapped loopback address must need no transport flag: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plaintext_server_answers_to_every_name_that_the_two_headers_agree_on() {
    // A plain HTTP server holds no certificate, so it claims no name and it
    // tests none. The name `evil.example` here is the DNS rebinding shape: the
    // browser writes one name into BOTH headers, so the two AGREE. On this
    // transport that request passes, and the certificate of a TLS server is
    // what refuses it. `tests/tls.rs` holds that half.
    //
    // The session cookie is VALID here, so the upgrade tests the name and
    // nothing else.
    let server = start_guarded("any-name", PathBuf::from("/bin/cat"), false).await;
    let cookie = login(server.addr, &server.token).await;

    let mut request = ws_request(server.addr, Some("http://evil.example"), Some(&cookie));
    let headers = request.headers_mut();
    headers.remove("Host");
    headers.insert("Host", "evil.example".parse().unwrap());

    let mut socket = try_connect(request)
        .await
        .expect("a plaintext server must answer to every name");
    let frame = next_binary(&mut socket).await;
    assert_eq!(frame[0], 0x01, "the first frame must carry the dump tag");

    // The two headers must still AGREE. A name in `Origin` that the `Host`
    // does not repeat is a cross-origin request, and that test stays.
    let mut request = ws_request(server.addr, Some("http://evil.example"), Some(&cookie));
    let headers = request.headers_mut();
    headers.remove("Host");
    headers.insert("Host", "other.example".parse().unwrap());

    let error = try_connect(request)
        .await
        .expect_err("two headers that disagree must not upgrade");
    assert_eq!(
        refusal_status(&error),
        403,
        "an Origin that the Host does not repeat must be refused"
    );
}

/// The bound that the test below gives its server.
///
/// `ws::MAX_TERMINALS` is 64 and it is private. A test at that bound would fork
/// 64 shells and open 64 PTYs, so `Terminals::new` takes the bound and this
/// test sets a small one. The code path is the same one.
const TERMINAL_BOUND: usize = 4;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_live_terminals_are_bounded_and_a_closed_one_gives_its_slot_back() {
    // `auth::MAX_SESSIONS` bounds the session COOKIES and not the connections.
    // One cookie therefore opened any number of terminals, and each one forks a
    // shell. `--no-password` needed no cookie at all, which is the state here.
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        auth: Auth::disabled(),
        hosts: pirate::auth::HostAllow::Any,
        tls: false,
        terminals: pirate::Terminals::new(TERMINAL_BOUND),
    });
    let addr = start_with(Arc::clone(&state)).await;

    // The server takes the slot before it upgrades, so the count is complete
    // as soon as the handshake of the client is complete.
    let mut sockets = Vec::new();
    for _ in 0..TERMINAL_BOUND {
        sockets.push(connect(addr).await);
    }
    let error = try_connect(ws_request(addr, Some(&own_origin(addr)), None))
        .await
        .expect_err("a request over the bound must not upgrade");
    assert_eq!(refusal_status(&error), 503);
    // The refusal answers before `on_upgrade`, so it forked no shell. The count
    // is therefore the bound and not one more than the bound.
    assert_eq!(
        state.terminals.live(),
        TERMINAL_BOUND,
        "a refused request must start no terminal"
    );

    // A dropped connection ends its shell, and the guard then gives the slot
    // back. The shutdown of the session takes a moment, so this waits for it.
    // The deadline is `WAIT`, so a slot that never comes back fails the test
    // instead of hanging the suite.
    sockets.pop();
    let socket = tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(socket) = try_connect(ws_request(addr, Some(&own_origin(addr)), None)).await {
                return socket;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the closed terminal never gave its slot back");
    drop(socket);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversized_resize_frame_is_clamped_at_the_pty() {
    // A resize frame carries two `u16` values, so this five-byte message asks
    // for 65535 by 65535. Unclamped it took 3.9 GB of resident memory against
    // the real binary, its dump never answered, and the memory stayed after
    // the socket closed. One client therefore took every terminal of the
    // operator. `stty size` reads the size back from the kernel.
    let dir = temp_dir("resize-clamp");
    let script = write_script(
        &dir,
        "size.sh",
        "#!/bin/sh\nwhile read -r line; do stty size; done\n",
    );
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    send(
        &mut socket,
        ClientFrame::Resize {
            cols: u16::MAX,
            rows: u16::MAX,
        },
    )
    .await;
    send(&mut socket, ClientFrame::Input(b"\n")).await;

    let expected = format!(
        "{} {}",
        pirate::terminal::MAX_ROWS,
        pirate::terminal::MAX_COLS
    );
    let text = read_until(&mut socket, &expected).await;
    assert!(
        text.contains(&expected),
        "the PTY must report the clamped size {expected:?}, and it reported {text:?}"
    );

    // The session still works after the clamp, so the frame is not a refusal.
    send(&mut socket, ClientFrame::Dump).await;
    let dump = read_dump(&mut socket).await;
    assert!(!dump.is_empty(), "a clamped terminal must still dump");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_asset_answer_carries_the_two_headers_that_a_browser_obeys() {
    // `nosniff` holds the browser to the type that pirate states. A guess
    // turns an asset into a document. `frame-ancestors` refuses every frame,
    // so no other origin can put the terminal of the operator in a page.
    let addr = start(PathBuf::from("/bin/cat")).await;
    let answer = http(addr, "GET", "/", &[], "").await;

    assert_eq!(
        answer.header("x-content-type-options"),
        Some("nosniff"),
        "the asset answer must carry nosniff"
    );
    assert_eq!(
        answer.header("content-security-policy"),
        Some("frame-ancestors 'none'"),
        "the asset answer must refuse every frame"
    );
}
