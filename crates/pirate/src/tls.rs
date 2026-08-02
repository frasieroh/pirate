//! The TLS transport.
//!
//! pirate serves TLS through a second [`axum::serve::Listener`] and not through
//! a second server stack. The listener in this module wraps [`crate::NoDelay`],
//! so TLS keeps TCP_NODELAY, keeps `axum::serve`, and keeps the graceful
//! shutdown that `main.rs` gives it. A crate such as `axum-server` gives the
//! same result, and it adds a dependency and a second accept loop.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::serve::Listener;
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::pem::PemObject as _;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::{self, ServerConfig};

/// Handshakes that run at the same time.
///
/// A handshake holds a socket and a small buffer, so a large number of them is
/// a memory cost that an unauthenticated client controls. At this bound the
/// OLDEST handshake is dropped to make room for the newest one.
///
/// CAUTION: Keep the accept arm on at every bound. An earlier version stopped
/// accepting while the set was full. One host then held 256 sockets open, sent
/// nothing on any of them, and every other client failed to open a connection
/// at all, because the accept queue of the kernel filled behind the stopped
/// loop and the kernel dropped the rest. A displaced handshake costs one
/// connection. A stopped accept loop costs the whole server.
const MAX_HANDSHAKES: usize = 256;

// A bound of zero would make `start` abort every handshake it starts, and the
// listener would accept a connection and never give one back.
const _: () = assert!(MAX_HANDSHAKES > 0);

/// Time that one handshake gets.
///
/// A client that connects and then sends nothing holds a slot until this
/// timeout ends it. Ten seconds is more than a slow link needs, and it is short
/// enough to clear the set under a flood.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where the certificate and the key come from.
#[derive(Debug, Clone)]
pub enum TlsSource {
    /// Two PEM files that the operator gives.
    Files {
        /// The certificate chain, leaf first.
        cert: PathBuf,
        /// The private key for the leaf certificate.
        key: PathBuf,
    },
    /// A certificate that pirate generates at startup.
    SelfSigned,
}

/// A server configuration, and the SHA-256 fingerprint of the leaf certificate.
#[derive(Debug, Clone)]
pub struct Tls {
    /// The configuration that [`TlsListener`] accepts connections with.
    pub config: Arc<ServerConfig>,
    /// Lowercase hexadecimal pairs, separated by colons.
    ///
    /// The value is the SHA-256 of the DER bytes of the leaf certificate. A
    /// browser shows the same digest in its certificate warning, so the
    /// operator can compare the two strings.
    pub fingerprint: String,
}

/// Build the TLS configuration from `source`.
///
/// # Errors
///
/// The result is an error when a file is missing, when a file holds no PEM
/// item of the type that pirate needs, or when the key does not match the
/// certificate. No error holds a byte of the private key.
pub fn build(source: &TlsSource) -> Result<Tls, Box<dyn std::error::Error>> {
    // rustls takes one crypto provider for the whole process. A second call
    // returns an error and changes nothing, and the test binary calls this
    // function once per server, so the result is dropped here.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (chain, key) = match source {
        TlsSource::Files { cert, key } => from_files(cert, key)?,
        TlsSource::SelfSigned => self_signed()?,
    };

    // `from_files` and `self_signed` both give at least one certificate, and
    // the fingerprint covers the leaf, which is the first one.
    let leaf = chain.first().ok_or("the certificate chain is empty")?;
    let fingerprint = fingerprint(leaf);

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(chain, key)?;

    Ok(Tls {
        config: Arc::new(config),
        fingerprint,
    })
}

/// The chain and the key from two PEM files.
fn from_files(
    cert: &Path,
    key: &Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), Box<dyn std::error::Error>> {
    // CAUTION: Send both PEM faults through `pem_error`. The reader
    // base64-decodes every section that it passes while it looks for a
    // certificate, so a combined PEM file given to --cert reports a fault in
    // its KEY section through this path.
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .map_err(|e| pem_error(cert, "certificate", &e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| pem_error(cert, "certificate", &e))?;
    if chain.is_empty() {
        return Err(format!("{} holds no certificate in PEM", cert.display()).into());
    }

    // The reader accepts PKCS#8, PKCS#1, and SEC1, and it gives the tag of the
    // PEM section back with the bytes.
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| pem_error(key, "private key", &e))?;

    Ok((chain, key))
}

/// A message for a PEM fault, with no byte of the file in it.
///
/// THREE forms of the error carry text from the file: `MissingSectionEnd` holds
/// the end marker, `IllegalSectionStart` holds the line, and `Base64Decode`
/// holds a message built from the content. A key file holds secret bytes, and a
/// certificate file can hold a key section, so this function names the fault and
/// drops every detail.
fn pem_error(path: &Path, what: &str, error: &rustls::pki_types::pem::Error) -> String {
    let path = path.display();
    match error {
        rustls::pki_types::pem::Error::Io(e) => format!("cannot read the {what} {path}: {e}"),
        rustls::pki_types::pem::Error::NoItemsFound => {
            format!("{path} holds no {what} in PEM")
        }
        _ => format!("{path} is not a valid PEM {what}"),
    }
}

/// A chain of one certificate that pirate signs itself.
///
/// The key exists in this process only. Nothing writes it to disk, so a restart
/// gives a new certificate and a new fingerprint.
fn self_signed(
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), Box<dyn std::error::Error>> {
    // The browser matches the host that the operator typed against these three
    // names. They cover every loopback form.
    let names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    let signed = rcgen::generate_simple_self_signed(names)?;
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signed.signing_key.serialize_der()));
    Ok((vec![signed.cert.der().clone()], key))
}

/// The SHA-256 of the DER bytes of `cert`, as lowercase hexadecimal pairs.
fn fingerprint(cert: &CertificateDer<'_>) -> String {
    use sha2::Digest as _;
    use std::fmt::Write as _;

    let digest = sha2::Sha256::digest(cert.as_ref());
    let mut out = String::with_capacity(digest.len() * 3);
    for byte in digest {
        if !out.is_empty() {
            out.push(':');
        }
        // A write into a String never fails.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// One connection after its handshake is complete.
type Handshake = (tokio_rustls::server::TlsStream<TcpStream>, SocketAddr);

/// A listener that completes a TLS handshake on each connection it accepts.
///
/// The handshakes run in parallel. A serial listener hands the whole server to
/// one client: that client opens a connection, sends nothing, and no other
/// connection is accepted until the timeout ends it.
pub struct TlsListener {
    inner: crate::NoDelay,
    acceptor: tokio_rustls::TlsAcceptor,
    handshakes: tokio::task::JoinSet<Option<Handshake>>,
    /// The handshakes in the set, in the order that they started.
    ///
    /// The set gives no order of its own, so this queue holds it. The front is
    /// the oldest handshake, and it is the one that a new connection displaces.
    started: std::collections::VecDeque<tokio::task::AbortHandle>,
}

impl TlsListener {
    /// Wrap `inner`, and accept every connection with `config`.
    #[must_use]
    pub fn new(inner: crate::NoDelay, config: Arc<ServerConfig>) -> Self {
        Self {
            inner,
            acceptor: tokio_rustls::TlsAcceptor::from(config),
            handshakes: tokio::task::JoinSet::new(),
            started: std::collections::VecDeque::with_capacity(MAX_HANDSHAKES),
        }
    }

    /// Start one handshake, and drop the oldest one when the set is full.
    ///
    /// A legitimate handshake on loopback takes about two milliseconds. It
    /// therefore completes long before [`MAX_HANDSHAKES`] new connections can
    /// push it out, and a flood of silent connections displaces itself.
    fn start(&mut self, stream: TcpStream, addr: SocketAddr) {
        while self.started.len() >= MAX_HANDSHAKES {
            match self.started.pop_front() {
                Some(oldest) => oldest.abort(),
                None => break,
            }
        }

        let acceptor = self.acceptor.clone();
        let handle = self.handshakes.spawn(async move {
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                Ok(Ok(tls)) => Some((tls, addr)),
                // A failed handshake is silent. One message per failure gives
                // an attacker a way to flood stderr.
                Ok(Err(_)) | Err(_) => None,
            }
        });
        self.started.push_back(handle);
    }
}

impl Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            // The accept arm is ALWAYS on. See the CAUTION on MAX_HANDSHAKES:
            // a listener that stops accepting under load denies the whole
            // server to one host that holds sockets open and sends nothing.
            let new = {
                let inner = &mut self.inner;
                let handshakes = &mut self.handshakes;
                tokio::select! {
                    // Both arms are cancel safe. `accept` keeps its state in
                    // the socket, and `join_next` keeps its state in the set.
                    (stream, addr) = Listener::accept(inner) => {
                        Some((stream, addr))
                    }
                    // The set gives `None` while it is empty, and the arm is
                    // then off for this pass. The accept arm stays on, so the
                    // select always holds one live branch and never panics.
                    Some(done) = handshakes.join_next() => {
                        // A panic in the handshake task, and an abort that made
                        // room for a newer connection, both arrive as a join
                        // error. Each one is one connection, so it is dropped
                        // like a handshake that failed.
                        if let Ok(Some(ready)) = done {
                            return ready;
                        }
                        None
                    }
                }
            };

            if let Some((stream, addr)) = new {
                self.start(stream, addr);
            }

            // Drop the handles of the handshakes that already ended, so the
            // queue cannot grow past the set that it tracks.
            self.started.retain(|handle| !handle.is_finished());
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}
