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
    let tls = pirate::tls::build(source).expect("the TLS configuration did not build");
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        // These tests measure the transport, so the token gate stays off.
        auth: pirate::auth::Auth::disabled(),
        hosts: pirate::auth::HostAllow::new(Vec::new()),
        tls: true,
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

/// Write a certificate and its key to two PEM files under a new directory.
fn write_pem_pair(name: &str) -> (PathBuf, PathBuf) {
    let dir = temp_dir(name);
    let signed = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
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

/// True when `needle` is somewhere in `haystack`.
fn holds(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.len() >= needle.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
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
async fn the_generated_certificate_carries_the_three_loopback_names() {
    // The browser matches the host that the operator typed against these three
    // names. A search of the DER bytes is a cheap test that all three reached
    // the certificate.
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier)).await;

    let leaf = verifier.leaf();
    let der = leaf.as_ref();
    assert!(holds(der, b"localhost"), "the DER holds no `localhost`");
    assert!(holds(der, &[127, 0, 0, 1]), "the DER holds no 127.0.0.1");
    assert!(
        holds(der, &std::net::Ipv6Addr::LOCALHOST.octets()),
        "the DER holds no ::1"
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
