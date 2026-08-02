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
use tokio_rustls::rustls::client::verify_server_name;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::server::ParsedCertificate;
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

/// Complete one TLS handshake against `addr`, with `server_name` as the SNI.
///
/// `server_name` picks what the client sends, not what the server carries. A
/// `ServerName::DnsName` sends that name as SNI. A `ServerName::IpAddress`
/// sends NO SNI at all: RFC 6066 defines SNI for a DNS host name only, and
/// rustls follows that rule, so this is how a test builds a client that names
/// no server.
async fn handshake_named(
    addr: SocketAddr,
    verifier: Arc<RecordingVerifier>,
    server_name: ServerName<'static>,
) -> TlsStream<TcpStream> {
    let connector = TlsConnector::from(Arc::new(client_config(verifier)));
    let stream = tokio::time::timeout(WAIT, TcpStream::connect(addr))
        .await
        .expect("the TCP connection timed out")
        .expect("the TCP connection failed");
    tokio::time::timeout(WAIT, connector.connect(server_name, stream))
        .await
        .expect("the TLS handshake timed out")
        .expect("the TLS handshake failed")
}

/// Complete one TLS handshake against `addr`, with `name` as the SNI.
async fn handshake(
    addr: SocketAddr,
    verifier: Arc<RecordingVerifier>,
    name: &str,
) -> TlsStream<TcpStream> {
    let server_name = ServerName::try_from(name.to_string()).expect("a valid server name");
    handshake_named(addr, verifier, server_name).await
}

/// True when the certificate in `leaf` covers `name`, under the SAN type that
/// `name` parses to (a dotted-decimal or colon-hex string checks an iPAddress
/// entry, everything else checks a dNSName entry).
///
/// This runs [`verify_server_name`], the same match a browser runs. It is
/// therefore the same check that tells an IP SAN from a DNS SAN: a string
/// that a certificate carries as the wrong SAN type does not match here,
/// although the plain text of the two names is equal.
fn covers(leaf: &CertificateDer<'static>, name: &str) -> bool {
    let parsed = ParsedCertificate::try_from(leaf).expect("the served leaf parses");
    let name = ServerName::try_from(name.to_string()).expect("a valid server name");
    verify_server_name(&parsed, &name).is_ok()
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
async fn start_tls_with(source: &TlsSource, auth: pirate::auth::Auth) -> (SocketAddr, Tls) {
    // TRAP 2: bind BEFORE the build of the TLS configuration, and give `build`
    // the address that the bind resolved to. `main.rs` follows the same order,
    // because a bind port of 0 does not become a real port until the bind
    // completes, and the generated certificate carries that real address.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let tls = pirate::tls::build(source, addr).expect("the TLS configuration did not build");
    let state = Arc::new(AppState {
        assets_dir: None,
        shell: PathBuf::from("/bin/cat"),
        auth,
        tls: true,
    });
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
/// rebound DNS name gives. pirate compares no name against the certificate,
/// so this post succeeds for any name, whether the certificate covers it or
/// not.
async fn post_token_as(addr: SocketAddr, host: &str, token: &str) -> u16 {
    post_token_as_with_cookie(addr, host, token).await.0
}

/// POST `token` to `/auth` over TLS, with `host` in `Host` and in `Origin`.
///
/// The result is the status code and the `Set-Cookie` value, when the answer
/// carried one. A correct token gives a session cookie back, and a caller
/// that wants to reuse that session sends this whole value in the `Cookie`
/// header of a later request.
async fn post_token_as_with_cookie(
    addr: SocketAddr,
    host: &str,
    token: &str,
) -> (u16, Option<String>) {
    let mut stream = handshake(addr, RecordingVerifier::new(), "localhost").await;
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
    let text = String::from_utf8_lossy(&answer).into_owned();
    (status_code(&text), set_cookie_value(&text))
}

/// The value of the `Set-Cookie` header of `text`, an HTTP answer with `\r\n`
/// line endings.
fn set_cookie_value(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("set-cookie")
            .then(|| value.trim().to_string())
    })
}

/// Open `/ws` over TLS, with `host` in `Host` and in `Origin`.
async fn upgrade_as(
    addr: SocketAddr,
    host: &str,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, WsError> {
    upgrade_as_with_cookie(addr, host, None).await
}

/// Open `/ws` over TLS, with `host` in `Host` and in `Origin`, and `cookie` in
/// `Cookie` when given.
///
/// `cookie` takes the whole `Set-Cookie` value that `/auth` gave back. The
/// reader on the server side takes the `pirate_session` pair out of a
/// `Cookie` header and ignores every other pair, so the response attributes
/// (`HttpOnly`, `Path`, and so on) cost nothing here.
async fn upgrade_as_with_cookie(
    addr: SocketAddr,
    host: &str,
    cookie: Option<&str>,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, WsError> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("wss://{host}/ws"))
        .header("Host", host)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", format!("https://{host}"));
    if let Some(cookie) = cookie {
        builder = builder.header("Cookie", cookie);
    }
    let request = builder.body(()).unwrap();
    let stream = handshake(addr, RecordingVerifier::new(), "localhost").await;
    let (socket, _) = tokio::time::timeout(WAIT, tokio_tungstenite::client_async(request, stream))
        .await
        .expect("the WebSocket handshake timed out")?;
    Ok(socket)
}

// --- Tests --- //

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generated_certificate_completes_a_handshake_and_serves_http() {
    let (addr, _tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let mut stream = handshake(addr, Arc::clone(&verifier), "localhost").await;
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

    let mut stream = handshake(addr, Arc::clone(&verifier), "localhost").await;
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

    let _stream = handshake(addr, Arc::clone(&verifier), "localhost").await;

    let leaf = verifier.leaf();
    assert_eq!(tls.selfsigned.fingerprint, fingerprint(leaf.as_ref()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_generated_certificate_covers_the_loopback_names_and_the_system_hostname() {
    // The browser matches the host that the operator typed against the names
    // of this certificate, and pirate answers to the same set. The test reads
    // the certificate off the wire, so it measures what the client got and not
    // what the generator intended.
    let (addr, tls) = start_tls(&TlsSource::SelfSigned).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier), "localhost").await;

    let names = pirate::tls::selfsigned_names(addr.ip());
    assert!(
        names.len() >= 3,
        "the loopback names are always there: {names:?}"
    );
    for name in ["localhost", "127.0.0.1", "::1"] {
        assert!(names.contains(&name.to_string()), "{name}");
    }

    // The startup line prints `tls.selfsigned.names`, and the operator trusts
    // that line. These are the names of the certificate on the wire, so the
    // line states what the server serves and not what the generator was asked
    // for.
    let leaf = verifier.leaf();
    assert_eq!(
        tls.selfsigned.names,
        pirate::tls::certificate_names(&leaf).expect("the served leaf parses"),
        "the printed names are not the names of the served certificate"
    );
    assert_eq!(
        tls.selfsigned.names, names,
        "the generator gave a name that the certificate dropped"
    );

    // IP literals must land as IP SANs, and DNS names as DNS SANs. `covers`
    // runs the same match a browser runs, and it only succeeds for the SAN
    // type that the query name parses to.
    assert!(covers(&leaf, "127.0.0.1"), "127.0.0.1 must be an IP SAN");
    assert!(covers(&leaf, "::1"), "::1 must be an IP SAN");
    assert!(covers(&leaf, "localhost"), "localhost must be a DNS SAN");

    // TRAP 1. `ServerName` refuses the `*` character, so the wildcard name is
    // dropped silently if it is ever run through that gate on its way into
    // the certificate. This assertion catches exactly that: the wildcard name
    // must be present BY NAME in the list the server reports, and not merely
    // as a suffix match against some other name.
    let hostname = names
        .iter()
        .find_map(|n| n.strip_prefix("*.").map(str::to_string))
        .expect("the machine hostname must produce a wildcard name");
    assert!(
        names.contains(&hostname),
        "the plain hostname must also be present: {names:?}"
    );
    assert!(covers(&leaf, &hostname), "the hostname must be a DNS SAN");
    let wildcard = format!("*.{hostname}");
    assert!(
        names.contains(&wildcard),
        "the wildcard name must be present by name: {names:?}"
    );
    // A wildcard is a SAN entry, not a name a client can ask for, so this
    // checks what the wildcard covers instead of querying the wildcard
    // string itself: a name it did not enumerate, such as a name a reverse
    // proxy adds in front of pirate.
    assert!(
        covers(&leaf, &format!("anything.{hostname}")),
        "the wildcard must cover a subdomain of the hostname"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bound_address_becomes_an_ip_san_and_an_unspecified_address_does_not() {
    // `tls::build` only needs the address, not a real bind, so this test
    // reads the certificate straight out of `build` with an address that no
    // loopback default already carries.
    let bound = SocketAddr::from((std::net::Ipv4Addr::new(203, 0, 113, 9), 4433));
    let tls = pirate::tls::build(&TlsSource::SelfSigned, bound)
        .expect("the TLS configuration did not build");
    assert!(
        tls.selfsigned.names.contains(&"203.0.113.9".to_string()),
        "the bound address must become an IP SAN: {:?}",
        tls.selfsigned.names
    );
    assert!(
        covers(&tls.selfsigned.leaf, "203.0.113.9"),
        "the bound address must be an IP SAN, not a DNS name"
    );

    // `0.0.0.0` answers on every interface of the machine, and it names none
    // of them. pirate does not enumerate interfaces, so it adds no IP SAN for
    // an unspecified address.
    let unspecified = SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, 4433));
    let tls = pirate::tls::build(&TlsSource::SelfSigned, unspecified)
        .expect("the TLS configuration did not build");
    assert!(
        !tls.selfsigned.names.contains(&"0.0.0.0".to_string()),
        "an unspecified bind address must not become an IP SAN: {:?}",
        tls.selfsigned.names
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_supplied_certificate_is_served_when_the_sni_matches() {
    let (cert, key) = write_named_pem_pair("sni-match", &["pirate.example"]);
    let (addr, tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier), "pirate.example").await;

    let supplied = tls.supplied.expect("a supplied certificate was given");
    assert_eq!(
        verifier.leaf(),
        supplied.leaf,
        "an SNI that the supplied certificate covers must get that certificate"
    );
}

/// REGRESSION. A naive string compare of the SNI against the certificate
/// names would pass every test above: none of them sends an SNI that differs
/// from the certificate name by more than an exact string. This test and the
/// one after it send an SNI that only a real match, through
/// `verify_server_name`, accepts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wildcard_in_the_supplied_certificate_covers_a_subdomain_of_the_sni() {
    let (cert, key) = write_named_pem_pair("sni-wildcard", &["*.example.test"]);
    let (addr, tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    // The certificate carries the string `*.example.test`, and the SNI is
    // `host.example.test`. The two strings never match; only the wildcard
    // rule of RFC 6125 does.
    let _stream = handshake(addr, Arc::clone(&verifier), "host.example.test").await;

    let supplied = tls.supplied.expect("a supplied certificate was given");
    assert_eq!(
        verifier.leaf(),
        supplied.leaf,
        "a wildcard in the supplied certificate must cover a subdomain of the SNI"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_sni_that_differs_only_in_case_still_matches_the_supplied_certificate() {
    // DNS names are not case sensitive. rustls lowercases the SNI before the
    // resolver ever sees it, so the certificate here carries the name in
    // mixed case on purpose: the exact string that reaches `supplied_covers`
    // never equals it, and only a case-insensitive match accepts the SNI.
    let (cert, key) = write_named_pem_pair("sni-case", &["Pirate.Example"]);
    let (addr, tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    let _stream = handshake(addr, Arc::clone(&verifier), "pirate.example").await;

    let supplied = tls.supplied.expect("a supplied certificate was given");
    assert_eq!(
        verifier.leaf(),
        supplied.leaf,
        "a case difference alone must not cost the supplied certificate its match"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_sni_the_supplied_certificate_does_not_cover_gets_the_selfsigned_fallback() {
    let (cert, key) = write_named_pem_pair("sni-mismatch", &["pirate.example"]);
    let (addr, tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    // TRAP 4 and the whole point of B2: this name matches neither the
    // supplied certificate nor a name pirate refuses, so the handshake must
    // still complete, and the request after it must still work.
    let mut stream = handshake(addr, Arc::clone(&verifier), "evil.example").await;
    let answer = http_over_tls(&mut stream, addr).await;

    let supplied = tls.supplied.expect("a supplied certificate was given");
    assert_eq!(
        verifier.leaf(),
        tls.selfsigned.leaf,
        "an SNI the supplied certificate does not cover must get the generated fallback"
    );
    assert_ne!(
        verifier.leaf(),
        supplied.leaf,
        "the fallback must not be the supplied certificate"
    );
    assert!(
        answer.starts_with("HTTP/1.1 204"),
        "the handshake must complete and the request must still work. Got: {answer:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_sends_no_sni_gets_the_supplied_certificate() {
    let (cert, key) = write_named_pem_pair("no-sni", &["pirate.example"]);
    let (addr, tls) = start_tls(&TlsSource::Files { cert, key }).await;
    let verifier = RecordingVerifier::new();

    // A `ServerName::IpAddress` sends no SNI extension at all, which is the
    // shape of a client that names no server. The operator asked pirate to
    // serve the supplied certificate, so that client gets it.
    let name = ServerName::try_from(addr.ip().to_string()).expect("a valid IP address");
    let _stream = handshake_named(addr, Arc::clone(&verifier), name).await;

    let supplied = tls.supplied.expect("a supplied certificate was given");
    assert_eq!(
        verifier.leaf(),
        supplied.leaf,
        "a client with no SNI must get the supplied certificate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_that_the_certificate_does_not_cover_still_posts_the_token() {
    // This is DNS rebinding. The attacker owns `evil.example` and points it at
    // the address of pirate. The browser writes that name into BOTH headers,
    // so the two AGREE with each other. The browser is what checks the name of
    // the certificate, and it does that check before it opens the connection.
    // pirate compares no name here, so the post must succeed.
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
        204,
        "pirate must accept a name that the certificate does not cover"
    );
    // A name that the certificate DOES cover must still work. pirate compares
    // neither name against the certificate, so both posts succeed alike.
    assert_eq!(
        post_token_as(addr, "pirate.example", &text).await,
        204,
        "a name that the certificate covers must still reach the token gate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_name_that_the_certificate_does_not_cover_still_opens_the_terminal() {
    // The same rule on the route that holds the shell. pirate compares no name
    // against the certificate, so a name that the certificate does not cover
    // still upgrades, as long as `Host` and `Origin` agree.
    let (cert, key) = write_named_pem_pair("upgrade-name", &["pirate.example"]);
    let (addr, _tls) = start_tls(&TlsSource::Files { cert, key }).await;

    let mut socket = upgrade_as(addr, "evil.example")
        .await
        .expect("a name that the certificate does not cover must still upgrade");
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

    // A name that the certificate DOES cover must still upgrade too.
    let mut socket = upgrade_as(addr, "pirate.example")
        .await
        .expect("a name that the certificate covers must still upgrade");
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
async fn a_session_authenticated_over_an_unrecognized_host_still_opens_the_terminal() {
    // REGRESSION. This is the report of the product manager: connect over a
    // hostname that the certificate does not cover, authenticate, and the
    // NEXT request must not answer 403. The two tests above post the token
    // once and upgrade once, each on its own connection with no session
    // carried between them. This test carries the session cookie from the
    // POST into the upgrade, on the same unrecognized host, which is the
    // exact sequence that the product manager ran.
    let (cert, key) = write_named_pem_pair("session-unknown-host", &["pirate.example"]);
    let path = temp_dir("session-unknown-host-token")
        .join("pirate")
        .join("auth_token");
    let token = pirate::auth::load_or_create(&path).expect("the token file did not open");
    let text = std::fs::read_to_string(&path).unwrap().trim().to_string();
    let (addr, _tls) = start_tls_with(
        &TlsSource::Files { cert, key },
        pirate::auth::Auth::enabled(token, true),
    )
    .await;

    let host = "unknown.example";
    let (status, cookie) = post_token_as_with_cookie(addr, host, &text).await;
    assert_eq!(
        status, 204,
        "authentication over a host that the certificate does not cover must still succeed"
    );
    let cookie = cookie.expect("a correct token must set a session cookie");

    let mut socket = upgrade_as_with_cookie(addr, host, Some(&cookie))
        .await
        .expect(
            "the request that carries the session cookie from that authentication \
             must not be refused",
        );
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
    let mut stream = handshake(addr, Arc::clone(&verifier), "localhost").await;
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
        handshake(addr, Arc::clone(&verifier), "localhost"),
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
    // axum 0.8 does not carry `http2` in its default set, and `Cargo.lock`
    // holds no `h2` crate, so this build speaks HTTP/1.1 only. The pin is what
    // keeps it that way if a later change turns that feature on. The server
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
