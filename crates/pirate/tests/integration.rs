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
const WAIT: Duration = Duration::from_secs(120);

/// Every wait on the pirate binary as a child process uses this timeout.
///
/// The binary starts, or it exits, in well under a second. A run that takes
/// longer than this timeout is a failure of the run.
const BINARY_WAIT: Duration = Duration::from_secs(30);

/// The wait after a needle in the output of the binary.
///
/// The startup prints its last lines in one sequence, so this wait holds the
/// gap between two of those lines. It is not a wait for the startup itself.
const SETTLE: Duration = Duration::from_millis(500);

/// Time that a process gets to disappear after the browser goes away.
///
/// The server waits 500 ms after SIGHUP and 500 ms after SIGKILL, so this
/// value holds both steps and a margin.
const DEATH_WAIT: Duration = Duration::from_secs(30);

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
    serve(router(state)).await
}

/// Start a router that the caller built on an ephemeral port.
///
/// The login shell tests build the router themselves, because the form of the
/// shell is an argument of `router_with_login` and not a field of `AppState`.
async fn serve(router: axum::Router) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(pirate::NoDelay(listener), router).await;
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

/// Ask the shell of this session for its own `argv[0]`.
///
/// A shebang script cannot report `argv[0]`. The kernel drops the value that
/// the caller gave and builds a new argument list for the interpreter, so `$0`
/// in a script is the path of that script. The two tests below therefore start
/// `/bin/sh` and drive it over the PTY.
///
/// The PTY sends the input line back, so the marker text arrives twice if the
/// input holds it. `printf` joins the marker from two parts here, and the echo
/// of the input therefore matches neither `ARG0[` nor `]END`.
async fn read_arg0(socket: &mut Socket) -> String {
    send(
        socket,
        ClientFrame::Input(b"printf 'A%s[%s]E%s\\n' RG0 \"$0\" ND\n"),
    )
    .await;
    let text = read_until(socket, "]END").await;
    let value = text
        .split_once("ARG0[")
        .and_then(|(_, rest)| rest.split_once("]END"))
        .map(|(value, _)| value.to_string());
    value.unwrap_or_else(|| panic!("the shell reported no argv[0]: {text:?}"))
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
        tls: false,
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
    start_binary_with_env(home, args, &[])
}

/// Start the pirate binary with `args` and with `env` in its environment.
///
/// A test that drives `PIRATE_BIND` or `PIRATE_PORT` names the variable in
/// `env`. Every other test gets a child without those two variables.
fn start_binary_with_env(home: &Path, args: &[&str], env: &[(&str, &str)]) -> Child {
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
    for (name, value) in env {
        command.env(name, value);
    }
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
///
/// That line carries the scheme of the transport, and the caller states the
/// scheme that it expects. A wait for `http` therefore never matches an
/// `https` run. The test then fails on the timeout and not on a connection
/// that speaks another protocol.
async fn wait_for_address(output: &Arc<Mutex<String>>, scheme: &str) -> SocketAddr {
    let needle = format!("listening on {scheme}://");
    let deadline = Instant::now() + BINARY_WAIT;
    while Instant::now() < deadline {
        let seen = output.lock().unwrap().clone();
        if let Some(rest) = seen.split(needle.as_str()).nth(1) {
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

/// Wait for the child to exit, and give back its status. `None` on a timeout.
async fn wait_for_exit(child: &mut Child) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + BINARY_WAIT;
    while Instant::now() < deadline {
        if let Some(status) = child.inner.try_wait().unwrap() {
            return Some(status);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    None
}

/// Start the binary, wait for it to exit, and give back the status, stdout,
/// and stderr.
///
/// A binary that serves instead of exiting is the failure of a test that calls
/// this function. The panic therefore carries stderr, which names the address
/// that the binary bound.
async fn run_to_exit(home: &Path, args: &[&str]) -> (std::process::ExitStatus, String, String) {
    let mut child = start_binary(home, args);
    let (stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let status = wait_for_exit(&mut child).await;
    // `Child` kills the process and waits for it when it drops. A child that
    // did not exit still holds both pipes, so this drop comes before the join.
    drop(child);
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let out = stdout.lock().unwrap().clone();
    let err = stderr.lock().unwrap().clone();
    let Some(status) = status else {
        panic!("the binary did not exit inside the timeout. Got: {err}")
    };
    (status, out, err)
}

/// Start the binary, wait for `needle` in stderr, and give back the state of
/// the child with everything that stderr holds.
///
/// The startup prints its lines in one sequence, so `needle` proves that every
/// earlier line is in the buffer. The wait of `SETTLE` after `needle` lets a
/// later line arrive. A test that asserts the absence of a line needs that
/// wait, because a line that never prints gives no needle of its own.
async fn run_until(home: &Path, args: &[&str], needle: &str) -> (bool, String) {
    let mut child = start_binary(home, args);
    let (_stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let deadline = Instant::now() + BINARY_WAIT;
    while Instant::now() < deadline && !stderr.lock().unwrap().contains(needle) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(SETTLE).await;

    let running = child.inner.try_wait().unwrap().is_none();
    // `Child` kills the process and waits for it when it drops.
    drop(child);
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let err = stderr.lock().unwrap().clone();
    (running, err)
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
    //
    // The line discipline ends each line, and not the program. ONLCR turns the
    // newline into a carriage return and a newline, and the two go into the
    // output queue of the tty one at a time. On macOS, a full queue takes the
    // carriage return and refuses the newline. The kernel then writes the whole
    // pair again, so the line ends with two carriage returns and a newline. A
    // loaded machine fills that queue, and this test therefore reads a line as
    // the text up to the newline, without the carriage returns that end it.
    let dir = temp_dir("burst");
    let script = write_script(&dir, "burst.sh", "#!/bin/sh\nstty -echo\nseq 1 8000\n");
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    let mut text = String::new();
    let mut messages = 0_usize;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline && !text.contains("\n8000\r") {
        let frame = next_binary(&mut socket).await;
        if let Ok(ServerFrame::Output(bytes)) = ServerFrame::decode(&frame) {
            messages += 1;
            text.push_str(&String::from_utf8_lossy(bytes));
        }
    }

    // Every line, in order, and none missing.
    let lines: Vec<&str> = text
        .trim_end()
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
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
async fn a_line_at_a_time_writer_arrives_whole_and_in_far_fewer_messages_than_lines() {
    // A writer that is slower than the server leaves the command queue empty on
    // every pass. A join of the queued output alone therefore joins nothing,
    // and each line becomes one frame and one WebSocket message. The batch
    // window holds the lines that arrive close together in one message.
    //
    // The script writes 2000 lines of about 102 bytes, which is about 204 KB.
    // Each line names its own place in the order, so a lost line, a duplicated
    // line, or a swapped pair fails the byte assertion.
    //
    // The inner loop paces the writer at about 1 ms per line, which is the rate
    // of a program that does work between two lines. Without it, this machine
    // writes faster than the server sends, the queue then holds several lines
    // at each pass, and the test measures the old join and not the window.
    //
    // The carriage returns come from ONLCR, as in the burst test above.
    let lines = 2_000_usize;
    let pace = 400_usize;
    let pad = "x".repeat(99);
    let dir = temp_dir("line-at-a-time");
    let script = write_script(
        &dir,
        "lines.sh",
        &format!(
            "#!/bin/sh\nstty -echo\ni=1\nwhile [ $i -le {lines} ]; do\n\
             j=0\nwhile [ $j -lt {pace} ]; do\nj=$((j+1))\ndone\n\
             printf '%s %s\\n' \"$i\" '{pad}'\ni=$((i+1))\ndone\n"
        ),
    );
    let addr = start(script).await;
    let mut socket = connect(addr).await;

    let last = format!("\n{lines} ");
    let mut text = String::new();
    let mut messages = 0_usize;
    let mut bytes_in = 0_usize;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline && !text.contains(&last) {
        let frame = next_binary(&mut socket).await;
        if let Ok(ServerFrame::Output(bytes)) = ServerFrame::decode(&frame) {
            messages += 1;
            bytes_in += bytes.len();
            text.push_str(&String::from_utf8_lossy(bytes));
        }
    }
    println!("line-at-a-time: {bytes_in} bytes in {messages} messages");

    // Every line, in order, and none missing.
    let got: Vec<&str> = text
        .trim_end()
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    let expected: Vec<String> = (1..=lines).map(|n| format!("{n} {pad}")).collect();
    assert_eq!(got.len(), expected.len(), "the stream lost or added a line");
    for (got, want) in got.iter().zip(&expected) {
        assert_eq!(got, want, "the stream arrived out of order");
    }

    // The count follows the time that the writer takes, divided by the window.
    // Without the window this machine gave 1380 messages, and with it 206. The
    // bound is loose, because the rate of the writer belongs to the machine:
    // it is four times the count that this machine gives, and one message per
    // line still breaks it.
    assert!(
        messages <= 800,
        "the stream arrived in {messages} messages, so the window did not hold it"
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

// --- The login shell --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_session_shell_is_a_login_shell_by_default() {
    // A login shell reads the login profile, so the user gets the environment
    // that a terminal gives. The shell reads its own `argv[0]` to find out.
    let addr = start(PathBuf::from("/bin/sh")).await;
    let mut socket = connect(addr).await;

    assert_eq!(
        read_arg0(&mut socket).await,
        "-sh",
        "the default session shell must start with a dash in argv[0]"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_no_login_form_starts_the_shell_with_a_plain_arg0() {
    // This is the server that `--no-login` builds.
    let state = Arc::new(AppState::plain(None, PathBuf::from("/bin/sh")));
    let addr = serve(pirate::router_with_login(state, false)).await;
    let mut socket = connect(addr).await;

    assert_eq!(
        read_arg0(&mut socket).await,
        "sh",
        "--no-login must give the file name of the shell with no dash"
    );
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
        tls: false,
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
async fn a_correct_token_still_creates_a_session_after_many_wrong_ones() {
    // An earlier version spent an attempt on every wrong guess and then locked
    // the operator out for good after enough of them. The comparison against
    // the digest of the token now runs with no such bookkeeping, so a flood of
    // wrong guesses never refuses the correct token.
    let server = start_guarded("wrong-tokens", PathBuf::from("/bin/cat"), false).await;
    let wrong = "0".repeat(64);

    for _ in 0..50 {
        assert_eq!(post_token(server.addr, &wrong).await.status, 401);
    }

    let answer = post_token(server.addr, &server.token).await;
    assert_eq!(
        answer.status, 204,
        "many wrong tokens must never refuse the correct token"
    );
    assert!(
        answer.header("set-cookie").is_some(),
        "the correct token must still create a session"
    );
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
        tls: false,
    });
    let addr = start_with(state).await;

    assert_eq!(
        post_token(addr, &first).await.status,
        204,
        "the second call gave a different token"
    );
}

// --- The token never leaks --- //

/// Read the token of `home` and make sure that neither pipe carries it.
fn assert_the_token_stayed_out_of_the_pipes(home: &Path, out: &str, err: &str) {
    let token = std::fs::read_to_string(home.join(".pirate").join("auth_token"))
        .expect("the binary wrote no token file")
        .trim()
        .to_string();
    assert_eq!(token.len(), 64, "the token is {} characters", token.len());
    assert!(!out.contains(&token), "the token reached stdout: {out}");
    assert!(!err.contains(&token), "the token reached stderr: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_binary_never_writes_the_token_to_its_output() {
    // The operator reads the token from the token file. A token in the output
    // reaches every log collector and every terminal recording, so the binary
    // must never print it.
    //
    // The requests of this first leg are plain HTTP, so the run names that
    // transport. The TLS leg comes after it.
    let home = temp_dir("binary-token");
    let mut child = start_binary(
        &home,
        &[
            "--plaintext",
            "--bind",
            "127.0.0.1",
            "--port",
            "0",
            "--shell",
            "/bin/cat",
        ],
    );
    let (stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let addr = wait_for_address(&stderr, "http").await;

    // The server answers real requests before the test reads the output.
    assert_eq!(http(addr, "GET", "/auth", &[], "").await.status, 401);
    assert_eq!(http(addr, "GET", "/", &[], "").await.status, 200);

    let _ = child.inner.kill();
    let _ = child.inner.wait();
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    assert_the_token_stayed_out_of_the_pipes(
        &home,
        &stdout.lock().unwrap().clone(),
        &stderr.lock().unwrap().clone(),
    );

    // The second leg takes the default transport. That path prints the names
    // of the certificate and its fingerprint, which the first leg never
    // reaches. The token comes from the file, so this leg needs no request.
    let home = temp_dir("binary-token-tls");
    let mut child = start_binary(
        &home,
        &["--bind", "127.0.0.1", "--port", "0", "--shell", "/bin/cat"],
    );
    let (stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    wait_for_address(&stderr, "https").await;

    let _ = child.inner.kill();
    let _ = child.inner.wait();
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let err = stderr.lock().unwrap().clone();
    assert!(
        err.contains("compare this fingerprint"),
        "the TLS leg did not reach the fingerprint line: {err}"
    );
    assert_the_token_stayed_out_of_the_pipes(&home, &stdout.lock().unwrap().clone(), &err);
}

// --- The transport of the binary --- //

/// Write a certificate for `localhost` and its key to two PEM files.
fn write_pem_pair(name: &str) -> (PathBuf, PathBuf) {
    let dir = temp_dir(name);
    let signed = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let cert = dir.join("cert.pem");
    let key = dir.join("key.pem");
    std::fs::write(&cert, signed.cert.pem()).unwrap();
    std::fs::write(&key, signed.signing_key.serialize_pem()).unwrap();
    (cert, key)
}

/// Send one plain HTTP request to `addr` and give back the bytes of the answer.
///
/// A TLS server ends this exchange with an alert or with a close, and neither
/// one starts with `HTTP/`.
async fn plain_http_probe(addr: SocketAddr) -> Vec<u8> {
    let mut stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
        .await
        .expect("the connection to the server timed out")
        .expect("the connection to the server failed");
    let request = format!("GET / HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut raw = Vec::new();
    let _ = tokio::time::timeout(WAIT, stream.read_to_end(&mut raw)).await;
    raw
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_with_no_transport_flag_serves_tls_with_a_generated_certificate() {
    // TLS is the default on every bind address, and loopback is one of them.
    // The listening line names the transport, and the plain HTTP probe proves
    // that the port speaks TLS and not HTTP.
    let home = temp_dir("binary-default-tls");
    let mut child = start_binary(
        &home,
        &["--bind", "127.0.0.1", "--port", "0", "--shell", "/bin/cat"],
    );
    let (_stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
    let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

    let addr = wait_for_address(&stderr, "https").await;
    assert_ne!(addr.port(), 0, "the startup line must name the bound port");

    let raw = plain_http_probe(addr).await;
    assert!(
        !raw.starts_with(b"HTTP/"),
        "the default transport answered a plain HTTP request: {:?}",
        String::from_utf8_lossy(&raw)
    );

    // `Child` kills the process and waits for it when it drops.
    drop(child);
    stdout_thread.join().unwrap();
    stderr_thread.join().unwrap();

    let err = stderr.lock().unwrap().clone();
    assert!(
        err.contains("nothing signed this certificate"),
        "the default certificate must be the generated one: {err}"
    );
    assert!(
        err.contains("compare this fingerprint"),
        "the default run must print the fingerprint: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_help_text_states_the_default_port_of_each_transport() {
    // The operator reads the default port from `--help`, and clap writes that
    // text to stdout. This is the second witness of the two defaults. The
    // first one reads the address of a failed bind.
    let home = temp_dir("binary-help");
    let (status, out, _err) = run_to_exit(&home, &["--help"]).await;
    assert!(status.success(), "`--help` must exit with success");

    // clap can wrap a long help line, so the test reads the whole entry of
    // `--port`. That entry ends where the next option starts.
    let entry = out
        .split_once("--port")
        .map(|(_, rest)| rest.split("--assets-dir").next().unwrap_or(rest))
        .unwrap_or_else(|| panic!("`--help` names no --port option: {out}"));

    for word in ["10433", "8080", "--plaintext"] {
        assert!(
            entry.contains(word),
            "the --port entry of `--help` does not state {word}: {entry}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_supplied_certificate_overrides_the_generated_one() {
    // The supplied certificate covers `localhost` alone, so the generated
    // certificate stays as the fallback for every other name. `tests/tls.rs`
    // drives the handshake for both. This test drives the two flags.
    let (cert, key) = write_pem_pair("binary-cert-files");
    let home = temp_dir("binary-cert");
    let (running, err) = run_until(
        &home,
        &[
            "--cert",
            cert.to_str().unwrap(),
            "--key",
            key.to_str().unwrap(),
            "--bind",
            "127.0.0.1",
            "--port",
            "0",
        ],
        "listening on https://",
    )
    .await;

    assert!(running, "pirate exited instead of serving: {err}");
    assert!(
        err.contains("the supplied certificate covers localhost"),
        "the supplied certificate did not reach the transport: {err}"
    );
    assert!(
        err.contains("pirate falls back to a self-signed certificate"),
        "the fallback certificate did not print: {err}"
    );
    assert!(
        err.contains("listening on https://"),
        "the server did not reach the listening line: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_supplied_key_and_plaintext_cannot_run_together() {
    // REGRESSION. `key` is not a member of the `tls` group. clap treats a
    // `requires` target as satisfied when that target conflicts with an
    // argument that is present. `conflicts_with_all` on `key` is what rejects
    // the two command lines below.
    let (cert, key) = write_pem_pair("binary-conflict-files");
    let pairs: [Vec<&str>; 2] = [
        vec![
            "--cert",
            cert.to_str().unwrap(),
            "--key",
            key.to_str().unwrap(),
            "--plaintext",
        ],
        vec!["--key", key.to_str().unwrap(), "--plaintext"],
    ];

    for args in &pairs {
        let home = temp_dir("binary-conflict");
        let (status, _out, err) = run_to_exit(&home, args).await;

        assert!(!status.success(), "{args:?} must stop the start: {err}");
        assert!(
            err.contains("cannot be used with"),
            "{args:?} must give the clap error for a conflict: {err}"
        );
        assert!(
            !err.contains("listening on"),
            "{args:?} must reach no listener: {err}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_default_port_is_10433_on_tls_and_8080_on_plaintext() {
    // A test that SERVES on a fixed port fails on a machine where another
    // process already holds that port. This test therefore HOLDS the port
    // itself and reads the address that pirate could not bind. The bind of
    // pirate fails whether this test or another process holds the port, so the
    // result is the same on every machine. The address in that error is the
    // address that pirate resolved, and the port in it is the default.
    async fn assert_default_port(name: &str, args: &[&str], port: u16) {
        let held = TcpListener::bind(("127.0.0.1", port)).await;

        let home = temp_dir(name);
        let (status, _out, err) = run_to_exit(&home, args).await;

        assert!(
            !status.success(),
            "the bind to a port that another socket holds must fail: {err}"
        );
        assert!(
            err.contains(&format!("127.0.0.1:{port}")),
            "the error must name the default port {port}: {err}"
        );
        assert!(
            !err.contains("listening on"),
            "a failed bind must reach no listener: {err}"
        );
        drop(held);
    }

    assert_default_port("default-port-tls", &["--bind", "127.0.0.1"], 10433).await;
    assert_default_port(
        "default-port-plaintext",
        &["--plaintext", "--bind", "127.0.0.1"],
        8080,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_port_flag_and_the_port_variable_override_the_default() {
    // An ephemeral port is never 10433, so a bound port that differs from
    // 10433 proves that the default gave way. The second run gives clap both
    // sources at once, and `--port` must win.
    async fn assert_ephemeral_port(name: &str, args: &[&str], env: &[(&str, &str)]) {
        let home = temp_dir(name);
        let mut child = start_binary_with_env(&home, args, env);
        let (_stdout, stdout_thread) = drain_pipe(child.inner.stdout.take().unwrap());
        let (stderr, stderr_thread) = drain_pipe(child.inner.stderr.take().unwrap());

        let addr = wait_for_address(&stderr, "https").await;
        // `Child` kills the process and waits for it when it drops.
        drop(child);
        stdout_thread.join().unwrap();
        stderr_thread.join().unwrap();

        assert_ne!(addr.port(), 0, "`--port 0` must resolve to a real port");
        assert_ne!(addr.port(), 10433, "the default port must not win");
    }

    // PIRATE_PORT alone, with no `--port`.
    assert_ephemeral_port(
        "port-env",
        &["--bind", "127.0.0.1", "--shell", "/bin/cat"],
        &[("PIRATE_PORT", "0")],
    )
    .await;

    // `--port` against PIRATE_PORT. clap ranks the flag over the variable.
    assert_ephemeral_port(
        "port-flag-over-env",
        &["--bind", "127.0.0.1", "--port", "0", "--shell", "/bin/cat"],
        &[("PIRATE_PORT", "10433")],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_loopback_bind_with_no_transport_flag_serves_tls() {
    // The default carries the transport on every bind address, so a command
    // line with no transport flag serves TLS here.
    let home = temp_dir("binary-transport");
    let (running, err) = run_until(
        &home,
        &["--bind", "0.0.0.0", "--port", "0"],
        "listening on https://",
    )
    .await;

    assert!(running, "pirate exited instead of serving: {err}");
    assert!(
        err.contains("listening on https://"),
        "a non-loopback bind must serve TLS: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ipv4_mapped_loopback_address_prints_no_warning() {
    // REGRESSION. `Ipv6Addr::is_loopback` is true for `::1` only. The mapped
    // form therefore got the answer false. The warning of a non-loopback bind
    // then printed on an address that reaches this machine only. The gate at
    // the startup line unmaps first. `--no-password` arms that warning, so a
    // broken unmap prints it.
    let home = temp_dir("binary-mapped");
    let (running, err) = run_until(
        &home,
        &["--no-password", "--bind", "::ffff:127.0.0.1", "--port", "0"],
        "listening on https://",
    )
    .await;

    assert!(
        running,
        "pirate refused the IPv4-mapped loopback address: {err}"
    );
    assert!(
        !err.contains("gives a shell"),
        "the mapped loopback address must print no warning: {err}"
    );
    assert!(
        err.contains("listening on https://"),
        "the server did not reach the listening line: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_no_password_bind_that_is_not_loopback_warns_and_still_serves() {
    // REGRESSION. The warning and the TLS message were one `if`/`else if`
    // chain. TLS present made the chain skip the warning. The warning must
    // fire whether or not TLS is present, and the server must still serve.
    // This run takes the default transport, which is TLS.
    let home = temp_dir("no-password-warn");
    let (running, err) = run_until(
        &home,
        &["--no-password", "--bind", "0.0.0.0", "--port", "0"],
        "gives a shell",
    )
    .await;

    assert!(running, "pirate exited instead of serving: {err}");
    assert!(
        err.contains("--no-password on 0.0.0.0 gives a shell to every host"),
        "the warning did not print with TLS present: {err}"
    );
    assert!(
        err.contains("listening on https://"),
        "the server did not reach the listening line: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_loopback_bind_prints_no_warning_and_still_serves() {
    // RULING. A loopback bind crosses no network, so no line of the startup
    // reports the transport or the authentication of that bind. The
    // still-running check and the listening line stop a warning from turning
    // into a refusal to start.
    async fn assert_loopback_run_has_no_warning(home_name: &str, args: &[&str]) {
        let home = temp_dir(home_name);
        let (running, err) = run_until(&home, args, "listening on http://").await;

        assert!(running, "pirate exited instead of serving: {err}");
        assert!(
            !err.contains("in the clear"),
            "a loopback bind must print no transport warning: {err}"
        );
        assert!(
            !err.contains("gives a shell"),
            "a loopback bind must print no authentication warning: {err}"
        );
        assert!(
            err.contains("listening on http://"),
            "the server did not reach the listening line: {err}"
        );
    }

    assert_loopback_run_has_no_warning(
        "loopback-no-warning-plaintext",
        &["--plaintext", "--bind", "127.0.0.1", "--port", "0"],
    )
    .await;
    assert_loopback_run_has_no_warning(
        "loopback-no-warning-plaintext-no-password",
        &[
            "--plaintext",
            "--no-password",
            "--bind",
            "127.0.0.1",
            "--port",
            "0",
        ],
    )
    .await;
    // `::ffff:127.0.0.1` is the IPv4-mapped spelling of loopback, so it also
    // needs no warning.
    assert_loopback_run_has_no_warning(
        "loopback-no-warning-plaintext-mapped",
        &["--plaintext", "--bind", "::ffff:127.0.0.1", "--port", "0"],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_plaintext_run_that_is_not_loopback_warns_about_the_token_and_still_serves() {
    // GUARD. This test stops an agent from deleting the line that reports the
    // transport on a non-loopback bind. The still-running check stops that
    // line from turning into a refusal to start.
    let home = temp_dir("plaintext-non-loopback-token-warn");
    let (running, err) = run_until(
        &home,
        &["--plaintext", "--bind", "0.0.0.0", "--port", "0"],
        "sends the token",
    )
    .await;

    assert!(running, "pirate exited instead of serving: {err}");
    assert!(
        err.contains("--plaintext on 0.0.0.0 sends the token"),
        "the transport line did not print for a non-loopback bind: {err}"
    );
    assert!(
        err.contains("in the clear"),
        "the transport line did not state the risk: {err}"
    );
    assert!(
        err.contains("listening on http://"),
        "the server did not reach the listening line: {err}"
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unrelated_host_header_still_posts_the_token_on_plain_http() {
    // A plain HTTP server holds no certificate, so it makes no claim about a
    // name and it compares none against `Host`. This test names a host that
    // no real server answers to, and the post must still succeed.
    let server = start_guarded("unrelated-host", PathBuf::from("/bin/cat"), false).await;

    let host = "totally-unrelated.example";
    let request = format!(
        "POST /auth HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n{}",
        server.token.len(),
        server.token
    );
    let mut stream = tokio::time::timeout(WAIT, TcpStream::connect(server.addr))
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
    let answer = parse_answer(&String::from_utf8_lossy(&raw));

    assert_eq!(
        answer.status, 204,
        "a Host header that names no real server must not stop the token post"
    );
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
