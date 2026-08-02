//! The TLS transport: a real listener, a real handshake, a real certificate.
//!
//! Each test starts the server on an ephemeral port behind
//! [`pirate::tls::TlsListener`], completes a handshake with a rustls client,
//! and reads the certificate that the server served. Every wait has a timeout,
//! so a failed handshake cannot hang the suite.

use std::fmt::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use pirate::tls::{Tls, TlsListener, TlsSource};
use pirate::{router, AppState};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::WebSocketStream;

/// Every wait in this file uses this timeout.
const WAIT: Duration = Duration::from_secs(10);

// --- The client --- //

/// A certificate verifier that accepts every certificate and keeps the leaf.
///
/// CAUTION: This verifier makes NO claim about chain validation. It proves that
/// the handshake completed, and it holds the leaf certificate that the server
/// sent so that a test can read it. Never copy this type into production code.
#[derive(Debug)]
struct RecordingVerifier {
    /// The leaf of the last handshake.
    leaf: Mutex<Option<CertificateDer<'static>>>,
    /// The signature algorithms of the provider. The signature checks below
    /// stay real, because a broken signature must still end the handshake.
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl RecordingVerifier {
    fn new() -> Arc<Self> {
        let provider = rustls::crypto::ring::default_provider();
        Arc::new(Self {
            leaf: Mutex::new(None),
            algorithms: provider.signature_verification_algorithms,
        })
    }

    /// The leaf certificate that the server sent.
    fn leaf(&self) -> CertificateDer<'static> {
        self.leaf
            .lock()
            .unwrap()
            .clone()
            .expect("the verifier saw no certificate")
    }
}

impl ServerCertVerifier for RecordingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.leaf.lock().unwrap() = Some(end_entity.clone().into_owned());
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// A client configuration that uses `verifier` and no client certificate.
fn client_config(verifier: Arc<RecordingVerifier>) -> ClientConfig {
    // The provider goes in here, so this file needs no process-wide default.
    ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

/// Start one TLS handshake against `addr` with a client that offers `alpn`.
///
/// The result is the error of the handshake, so a test can read a refusal
/// instead of a panic message.
async fn handshake_with_alpn(
    addr: SocketAddr,
    alpn: &[&str],
) -> std::io::Result<TlsStream<TcpStream>> {
    let mut config = client_config(RecordingVerifier::new());
    config.alpn_protocols = alpn.iter().map(|name| name.as_bytes().to_vec()).collect();
    let connector = TlsConnector::from(Arc::new(config));
    let stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
        .await
        .expect("the TCP connection timed out")
        .expect("the TCP connection failed");
    let name = ServerName::try_from("localhost").unwrap();
    tokio::time::timeout(WAIT, connector.connect(name, stream))
        .await
        .expect("the TLS handshake timed out")
}

/// Complete one TLS handshake against `addr`.
async fn handshake(addr: SocketAddr, verifier: Arc<RecordingVerifier>) -> TlsStream<TcpStream> {
    let connector = TlsConnector::from(Arc::new(client_config(verifier)));
    let stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
        .await
        .expect("the TCP connection timed out")
        .expect("the TCP connection failed");
    let name = ServerName::try_from("localhost").unwrap();
    tokio::time::timeout(WAIT, connector.connect(name, stream))
        .await
        .expect("the TLS handshake timed out")
        .expect("the TLS handshake failed")
}

// --- The server --- //

/// Start a TLS server on an ephemeral port.
///
/// The result holds the address and the [`Tls`] value that `tls::build` gave.
async fn start_tls(source: &TlsSource) -> (SocketAddr, Tls) {
    // These tests measure the transport, so the token gate stays off.
    start_tls_with(source, pirate::auth::Auth::disabled()).await
}

/// Start a TLS server with the authentication state that the caller built.
///
/// The names of the certificate are the names that the server answers to, so
/// `hosts` comes from the leaf that `tls::build` gave.
async fn start_tls_with(source: &TlsSource, auth: pirate::auth::Auth) -> (SocketAddr, Tls) {
    let tls = pirate::tls::build(source).expect("the TLS configuration did not build");
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        auth,
        hosts: pirate::auth::HostAllow::from_certificate(Some(&tls.leaf)),
        tls: true,
        terminals: pirate::Terminals::default(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = tls.config.clone();
    tokio::spawn(async move {
        let _ = axum::serve(
            TlsListener::new(pirate::NoDelay(listener), config),
            router(state),
        )
        .await;
    });
    (addr, tls)
}

/// Send one HTTP request over `stream` and read the whole answer.
///
/// `Connection: close` makes the server end the stream after the answer, so the
/// read stops without a parse of the length.
async fn http_over_tls(stream: &mut TlsStream<TcpStream>, addr: SocketAddr) -> String {
    let request = format!("GET /auth HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut answer = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut answer))
        .await
        .expect("the HTTP answer timed out")
        .expect("the read of the HTTP answer failed");
    String::from_utf8_lossy(&answer).into_owned()
}

// --- Other scaffolding --- //

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pirate-tls-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Write a certificate for `localhost` and its key to two PEM files.
fn write_pem_pair(name: &str) -> (PathBuf, PathBuf) {
    write_named_pem_pair(name, &["localhost"])
}

/// Write a certificate that covers `names`, and its key, to two PEM files.
fn write_named_pem_pair(name: &str, names: &[&str]) -> (PathBuf, PathBuf) {
    let dir = temp_dir(name);
    let signed = rcgen::generate_simple_self_signed(
        names.iter().map(|n| (*n).to_string()).collect::<Vec<_>>(),
    )
    .unwrap();
    let cert = dir.join("cert.pem");
    let key = dir.join("key.pem");
    std::fs::write(&cert, signed.cert.pem()).unwrap();
    std::fs::write(&key, signed.signing_key.serialize_pem()).unwrap();
    (cert, key)
}

/// The SHA-256 of `der`, as lowercase hexadecimal pairs with colons.
fn fingerprint(der: &[u8]) -> String {
    use sha2::Digest as _;

    let digest = sha2::Sha256::digest(der);
    let mut out = String::with_capacity(digest.len() * 3);
    for byte in digest {
        if !out.is_empty() {
            out.push(':');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The status code of an HTTP answer.
fn status_code(text: &str) -> u16 {
    text.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("this is not an HTTP answer: {text:?}"))
}

/// POST `token` to `/auth` over TLS, with `host` in `Host` and in `Origin`.
///
/// The two headers therefore AGREE on that name, which is the shape that a
/// rebound DNS name gives. The certificate is the only thing that can refuse
/// it.
async fn post_token_as(addr: SocketAddr, host: &str, token: &str) -> u16 {
    let mut stream = handshake(addr, RecordingVerifier::new()).await;
    let request = format!(
        "POST /auth HTTP/1.1\r\nHost: {host}\r\nOrigin: https://{host}\r\n\
         Connection: close\r\nContent-Length: {}\r\n\r\n{token}",
        token.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut answer = Vec::new();
    tokio::time::timeout(WAIT, stream.read_to_end(&mut answer))
        .await
        .expect("the HTTP answer timed out")
        .expect("the read of the HTTP answer failed");
    status_code(&String::from_utf8_lossy(&answer))
}

/// Open `/ws` over TLS, with `host` in `Host` and in `Origin`.
async fn upgrade_as(
    addr: SocketAddr,
    host: &str,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, WsError> {
    let request = Request::builder()
        .method("GET")
        .uri(format!("wss://{host}/ws"))
        .header("Host", host)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", format!("https://{host}"))
        .body(())
        .unwrap();
    let stream = handshake(addr, RecordingVerifier::new()).await;
    let (socket, _) = tokio::time::timeout(WAIT, tokio_tungstenite::client_async(request, stream))
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

// --- Tests --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generated_certificate_completes_a_handshake_and_serves_http() {
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let mut stream = handshake(addr, Arc::clone(&verifier)).await;
    let answer = http_over_tls(&mut stream, addr).await;

    assert!(
        answer.starts_with("HTTP/1.1 "),
        "the answer is not HTTP: {answer:?}"
    );
    assert!(
        answer.starts_with("HTTP/1.1 204"),
        "with no token gate, /auth answers 204. Got: {answer:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_supplied_certificate_and_key_pair_completes_a_handshake() {
    let (cert, key) = write_pem_pair("files");
    let (addr, _tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    let mut stream = handshake(addr, Arc::clone(&verifier)).await;
    let answer = http_over_tls(&mut stream, addr).await;

    assert!(
        answer.starts_with("HTTP/1.1 204"),
        "the PEM pair did not serve a request. Got: {answer:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_reported_fingerprint_is_the_digest_of_the_served_certificate() {
    // The operator compares the printed fingerprint with the one in the
    // browser warning. That comparison is worth nothing when the two values
    // cover different certificates, so this test takes the certificate from
    // the wire and digests it again.
    let (addr, tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier)).await;

    let leaf = verifier.leaf();
    assert_eq!(tls.fingerprint, fingerprint(leaf.as_ref()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_generated_certificate_covers_the_loopback_names_and_the_system_hostname() {
    // The browser matches the host that the operator typed against the names
    // of this certificate, and pirate answers to the same set. The test reads
    // the certificate off the wire, so it measures what the client got and not
    // what the generator intended.
    let (addr, tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier)).await;

    let names = pirate::tls::selfsigned_names();
    assert!(
        names.len() >= 3,
        "the loopback names are always there: {names:?}"
    );
    for name in ["localhost", "127.0.0.1", "::1"] {
        assert!(names.contains(&name.to_string()), "{name}");
    }

    // The startup line prints `tls.names`, and the operator trusts that line.
    // These are the names of the certificate on the wire, so the line states
    // what the server serves and not what the generator was asked for.
    assert_eq!(
        tls.names,
        pirate::tls::certificate_names(&verifier.leaf()).expect("the served leaf parses"),
        "the printed names are not the names of the served certificate"
    );
    assert_eq!(
        tls.names, names,
        "the generator gave a name that the certificate dropped"
    );

    let hosts = pirate::auth::HostAllow::from_certificate(Some(&verifier.leaf()));
    for name in &names {
        assert!(
            hosts.permits(name.as_bytes()),
            "the served certificate covers no {name}"
        );
    }
    assert!(
        !hosts.permits(b"evil.example"),
        "the served certificate must cover nothing else"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_that_the_certificate_does_not_cover_cannot_post_the_token() {
    // This is DNS rebinding, and it is the case that a plain same-origin test
    // cannot see. The attacker owns `evil.example` and points it at the address
    // of pirate. The browser then writes that name into BOTH headers, so the
    // two AGREE with each other. The certificate is what refuses it.
    let (cert, key) = write_named_pem_pair("post-name", &["pirate.example"]);
    let path = temp_dir("post-name-token")
        .join("pirate")
        .join("auth_token");
    let token = pirate::auth::load_or_create(&path).expect("the token file did not open");
    let text = std::fs::read_to_string(&path).unwrap().trim().to_string();
    let (addr, _tls) = start_tls_with(
        &TlsSource::Files { cert, key },
        pirate::auth::Auth::enabled(token, true),
    )
    .await;

    assert_eq!(
        post_token_as(addr, "evil.example", &text).await,
        403,
        "a name that the certificate does not cover must be refused"
    );
    // The same token under a covered name opens a session, so the refusal
    // above came from the name and from nothing else.
    assert_eq!(
        post_token_as(addr, "pirate.example", &text).await,
        204,
        "the name of the certificate must reach the token gate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_that_the_certificate_does_not_cover_cannot_open_the_terminal() {
    // The same rule on the route that holds the shell. The token gate is off
    // here, so a 403 comes from the name and from nothing else.
    let (cert, key) = write_named_pem_pair("upgrade-name", &["pirate.example"]);
    let (addr, _tls) = start_tls(&TlsSource::Files { cert, key }).await;

    let error = upgrade_as(addr, "evil.example")
        .await
        .expect_err("a name that the certificate does not cover must not upgrade");
    assert_eq!(refusal_status(&error), 403);

    let mut socket = upgrade_as(addr, "pirate.example")
        .await
        .expect("the name of the certificate must upgrade");
    let message = tokio::time::timeout(WAIT, socket.next())
        .await
        .expect("the first frame timed out")
        .expect("the socket ended")
        .expect("the read of the first frame failed");
    assert_eq!(
        message.into_data().first().copied(),
        Some(0x01),
        "the first frame must carry the dump tag"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_client_does_not_block_a_handshake() {
    // A serial listener hands the whole server to one client: it connects, it
    // sends nothing, and every other client waits for the handshake timeout.
    // The listener runs its handshakes in parallel, so these eight sockets
    // must cost the ninth client nothing.
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;

    let mut silent = Vec::new();
    for _ in 0..8 {
        let stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
            .await
            .expect("a silent connection timed out")
            .expect("a silent connection failed");
        silent.push(stream);
    }

    let verifier = RecordingVerifier::new();
    let mut stream = handshake(addr, Arc::clone(&verifier)).await;
    let answer = http_over_tls(&mut stream, addr).await;

    assert!(
        answer.starts_with("HTTP/1.1 204"),
        "the silent clients blocked the server. Got: {answer:?}"
    );
    drop(silent);
}

/// More silent connections than the listener holds handshakes for.
///
/// `tls::MAX_HANDSHAKES` is 256 and it is private, so this value states the
/// same number. A change to the constant must change this one.
const MORE_THAN_MAX_HANDSHAKES: usize = 320;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn silent_clients_past_the_handshake_bound_do_not_deny_the_server() {
    // REGRESSION, and the reason the test above is not enough: that test holds
    // 8 sockets, which is under the bound, and the earlier listener passed it.
    //
    // The earlier listener stopped accepting while its handshake set was full.
    // One host then held 256 sockets open, sent nothing, and the accept queue
    // of the kernel filled behind the stopped loop. Every other client failed
    // to open a TCP connection at all, and a real client measured 9.99 s, which
    // is one whole handshake timeout. The listener now displaces its oldest
    // handshake instead of refusing the new connection.
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;

    let mut silent = Vec::new();
    for _ in 0..MORE_THAN_MAX_HANDSHAKES {
        match tokio::time::timeout(WAIT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => silent.push(stream),
            // A refused connection is itself the defect that this test covers.
            other => panic!(
                "connection {} of {MORE_THAN_MAX_HANDSHAKES} did not open: {other:?}",
                silent.len() + 1
            ),
        }
    }
    assert_eq!(silent.len(), MORE_THAN_MAX_HANDSHAKES);

    // The real client must not wait for a handshake timeout. The bound here is
    // far under the 10 s timeout, so a listener that waits for one cannot pass.
    let verifier = RecordingVerifier::new();
    let at = Instant::now();
    let mut stream = tokio::time::timeout(
        Duration::from_secs(5),
        handshake(addr, Arc::clone(&verifier)),
    )
    .await
    .expect("the real client never completed a handshake under the flood");
    let answer = http_over_tls(&mut stream, addr).await;
    let took = at.elapsed();

    assert!(
        answer.starts_with("HTTP/1.1 204"),
        "the flood denied the server. Got: {answer:?}"
    );
    assert!(
        took < Duration::from_secs(5),
        "the real client waited {took:?}, which is a handshake timeout and not a handshake"
    );
    drop(silent);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_offers_two_protocols_negotiates_http_1_1() {
    // axum builds with its `http2` feature on, so `axum::serve` hands each
    // connection to a hyper auto-builder that can speak HTTP/2. The server
    // offers one protocol, so a browser that offers both gets HTTP/1.1 and the
    // WebSocket upgrade of RFC 6455 stays on the path that pirate proved.
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;

    let stream = handshake_with_alpn(addr, &["h2", "http/1.1"])
        .await
        .expect("a client that offers http/1.1 must complete a handshake");

    let (_, connection) = stream.get_ref();
    assert_eq!(
        connection.alpn_protocol(),
        Some(&b"http/1.1"[..]),
        "the server must name one protocol and it must be http/1.1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_offers_http_2_alone_gets_no_application_protocol() {
    // An empty ALPN list on the server would take this client and leave the
    // protocol of the connection to chance. A WebSocket over HTTP/2 needs the
    // extended CONNECT method of RFC 8441, which pirate has never proven, so
    // the handshake must end here instead.
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;

    let error = handshake_with_alpn(addr, &["h2"])
        .await
        .expect_err("a client that offers h2 alone must not complete a handshake");

    let inner = error
        .into_inner()
        .expect("the handshake error must carry the rustls error");
    let rustls_error = inner
        .downcast::<rustls::Error>()
        .expect("the handshake error must be a rustls error");
    assert!(
        matches!(
            *rustls_error,
            rustls::Error::AlertReceived(rustls::AlertDescription::NoApplicationProtocol)
        ),
        "rustls must answer no_application_protocol. Got: {rustls_error:?}"
    );
}
