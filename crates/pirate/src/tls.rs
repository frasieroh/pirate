//! The TLS transport.
//!
//! pirate serves TLS through a second [`axum::serve::Listener`] and not through
//! a second server stack. The listener in this module wraps [`crate::NoDelay`],
//! so TLS keeps TCP_NODELAY, keeps `axum::serve`, and keeps the graceful
//! shutdown that `main.rs` gives it. A crate such as `axum-server` gives the
//! same result, and it adds a dependency and a second accept loop.
//!
//! pirate completes every handshake and never refuses one for the name that
//! the client asked for. This is a developer tool behind a browser, and the
//! browser is what judges whether a certificate name matches the URL. With a
//! supplied certificate, [`build`] therefore keeps a generated certificate
//! ready and serves it for any name that the supplied certificate does not
//! cover, so the handshake always completes and the browser shows its own
//! warning for the name it does not trust.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::serve::Listener;
use tokio::net::TcpStream;
use tokio_rustls::rustls::client::verify_server_name;
use tokio_rustls::rustls::pki_types::pem::PemObject as _;
use tokio_rustls::rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName,
};
use tokio_rustls::rustls::server::{ClientHello, ParsedCertificate, ResolvesServerCert};
use tokio_rustls::rustls::sign::CertifiedKey;
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

/// A name that no certificate of a real server carries.
///
/// [`certificate_names`] asks rustls to match this name, and it reads the list
/// of names out of the refusal. RFC 2606 reserves the `.invalid` top-level
/// domain for exactly this use, so no certificate authority can sign a name
/// under it and no operator can put one in a certificate by accident.
const NAME_PROBE: &str = "pirate-reads-the-names.invalid";

/// A server configuration, and the certificates that it can answer with.
///
/// With `--cert`, pirate serves two certificates: [`Self::supplied`] is the
/// one the operator gave, and [`Self::selfsigned`] is the one it falls back to
/// for a name the supplied certificate does not cover. In self-signed mode,
/// [`Self::supplied`] is `None` and [`Self::selfsigned`] is the only
/// certificate the server has.
#[derive(Debug, Clone)]
pub struct Tls {
    /// The configuration that [`TlsListener`] accepts connections with.
    pub config: Arc<ServerConfig>,
    /// The certificate the operator supplied with `--cert` and `--key`.
    ///
    /// This is `None` in self-signed mode.
    pub supplied: Option<CertReport>,
    /// The certificate pirate generates at startup.
    ///
    /// The key exists in this process only. Nothing writes it to disk, so a
    /// restart gives a new certificate and a new fingerprint.
    pub selfsigned: CertReport,
}

/// One certificate that the server can serve, and what an operator reads about
/// it.
#[derive(Debug, Clone)]
pub struct CertReport {
    /// Lowercase hexadecimal pairs, separated by colons.
    ///
    /// The value is the SHA-256 of the DER bytes of the leaf certificate. A
    /// browser shows the same digest in its certificate warning, so the
    /// operator can compare the two strings.
    pub fingerprint: String,
    /// The leaf certificate, in DER.
    pub leaf: CertificateDer<'static>,
    /// Every name of [`Self::leaf`], read back from the certificate.
    ///
    /// The startup line prints this list. It is what the server serves and not
    /// what a generator was asked for, so the operator reads the truth even
    /// when the two differ.
    pub names: Vec<String>,
}

/// Every name that the leaf certificate carries.
///
/// rustls has no reader for the subject alternative names of its own. It has
/// one refusal that carries them: [`verify_server_name`] answers a mismatch
/// with the list of names that the certificate presented. This function asks
/// for [`NAME_PROBE`], which no certificate carries, and reads that list.
///
/// The result holds one entry for each name of the subject alternative name
/// extension, in the order of the certificate. A certificate with a subject
/// common name and no subject alternative name gives an EMPTY list, because
/// RFC 6125 reads names from that extension only.
///
/// [`build`] calls this function once for the supplied certificate and once
/// for the generated certificate, to report the names of each at startup.
///
/// The resolver does not call this function. [`NameAwareResolver::supplied_covers`]
/// parses the leaf again and calls [`verify_server_name`] directly, once for
/// every handshake.
///
/// # Errors
///
/// The result is an error when the leaf does not parse, when the probe name
/// does not parse, and when rustls answers the probe with anything other than
/// a mismatch. No error holds a byte of the private key.
pub fn certificate_names(leaf: &CertificateDer<'static>) -> Result<Vec<String>, String> {
    let parsed = rustls::server::ParsedCertificate::try_from(leaf).map_err(|e| {
        format!(
            "pirate cannot read the names of the certificate: {e}. \
             pirate reports the names of every certificate that it serves, so it must read them"
        )
    })?;
    let probe = ServerName::try_from(NAME_PROBE)
        .map_err(|e| format!("pirate cannot build the probe name {NAME_PROBE}: {e}"))?;

    match verify_server_name(&parsed, &probe) {
        // The probe is a name under a reserved top-level domain, so a match
        // means that this certificate is not one that pirate can read.
        Ok(()) => Err(format!(
            "this certificate covers the reserved name {NAME_PROBE}. \
             pirate reads the names of a certificate through that name, so it cannot read this one"
        )),
        Err(rustls::Error::InvalidCertificate(
            rustls::CertificateError::NotValidForNameContext { presented, .. },
        )) => Ok(presented.iter().map(|name| plain_name(name)).collect()),
        Err(e) => Err(format!(
            "pirate cannot read the names of the certificate: {e}. \
             pirate reports the names of every certificate that it serves, so it must read them"
        )),
    }
}

/// One name of the rustls list, in the form that an operator types.
///
/// rustls writes each presented name in its own debug form: `DnsName("host")`
/// and `IpAddress(0::1)`. The startup line must print the name that the
/// operator gives to the browser, so this function takes the value out of the
/// wrapper and gives the address back to the formatter of the standard library.
/// A form that this function does not know passes through unchanged.
fn plain_name(presented: &str) -> String {
    if let Some(name) = presented
        .strip_prefix("DnsName(\"")
        .and_then(|rest| rest.strip_suffix("\")"))
    {
        return name.to_string();
    }
    if let Some(address) = presented
        .strip_prefix("IpAddress(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        // `0::1` and `::1` are one address, and the operator types the second
        // form. The parse gives that form back, and it keeps the text of an
        // address that does not parse.
        return address
            .parse::<std::net::IpAddr>()
            .map_or_else(|_| address.to_string(), |address| address.to_string());
    }
    presented.to_string()
}

/// Build the TLS configuration from `source`.
///
/// `bound` is the address that the listener already accepted its socket on.
/// Call this function AFTER the bind, so a bind port of 0 has resolved to the
/// real port before this function reads it. [`selfsigned_names`] puts the IP
/// of `bound` into the generated certificate.
///
/// # Errors
///
/// The result is an error when a file is missing, when a file holds no PEM
/// item of the type that pirate needs, or when the key does not match the
/// certificate. No error holds a byte of the private key.
pub fn build(source: &TlsSource, bound: SocketAddr) -> Result<Tls, Box<dyn std::error::Error>> {
    // rustls takes one crypto provider for the whole process. A second call
    // returns an error and changes nothing, and the test binary calls this
    // function once per server, so the result is dropped here.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Every source needs a generated certificate: the self-signed source
    // serves it to everyone, and a supplied certificate falls back to it for
    // a name that certificate does not cover. TRAP 5: generate it once, here,
    // and never inside the resolver that runs on every handshake.
    let (selfsigned_chain, selfsigned_key) = self_signed(bound.ip())?;
    let selfsigned_leaf = selfsigned_chain
        .first()
        .ok_or("the certificate chain is empty")?
        .clone();
    let selfsigned_report = CertReport {
        fingerprint: fingerprint(&selfsigned_leaf),
        names: certificate_names(&selfsigned_leaf)?,
        leaf: selfsigned_leaf,
    };

    match source {
        TlsSource::SelfSigned => {
            let mut config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(selfsigned_chain, selfsigned_key)?;
            config.alpn_protocols = alpn_protocols();
            Ok(Tls {
                config: Arc::new(config),
                supplied: None,
                selfsigned: selfsigned_report,
            })
        }
        TlsSource::Files { cert, key } => {
            let (chain, key) = from_files(cert, key)?;
            let leaf = chain
                .first()
                .ok_or("the certificate chain is empty")?
                .clone();
            let names = certificate_names(&leaf)?;

            // A certificate with no name still gets served: the fallback
            // certificate exists for exactly this. A browser refuses a
            // certificate that carries no name for its URL, so this is a
            // warning and not a stop.
            if names.is_empty() {
                eprintln!(
                    "pirate: CAUTION: The supplied certificate carries no subject alternative \
                     name. Browsers refuse this certificate for every name. pirate serves the \
                     self-signed certificate for any name that does not match this certificate."
                );
            }

            let provider = rustls::crypto::CryptoProvider::get_default()
                .expect("the provider is installed above");
            let supplied_certified = Arc::new(CertifiedKey::from_der(chain, key, provider)?);
            let selfsigned_certified = Arc::new(CertifiedKey::from_der(
                selfsigned_chain,
                selfsigned_key,
                provider,
            )?);

            let resolver = Arc::new(NameAwareResolver {
                supplied: Arc::clone(&supplied_certified),
                supplied_leaf: leaf.clone(),
                fallback: selfsigned_certified,
            });

            let mut config = ServerConfig::builder()
                .with_no_client_auth()
                .with_cert_resolver(resolver);
            config.alpn_protocols = alpn_protocols();

            Ok(Tls {
                config: Arc::new(config),
                supplied: Some(CertReport {
                    fingerprint: fingerprint(&leaf),
                    leaf,
                    names,
                }),
                selfsigned: selfsigned_report,
            })
        }
    }
}

/// The one ALPN protocol that every TLS configuration offers.
///
/// CAUTION: Keep this list at one protocol, and keep that protocol
/// `http/1.1`. An EMPTY list leaves the protocol of the connection to the
/// client and to the defaults of two libraries, which is how a
/// cross-protocol confusion starts. One name makes the transport
/// deterministic, and a client that offers `h2` alone gets
/// `no_application_protocol` instead of a socket.
///
/// This build speaks HTTP/1.1 and nothing else: axum 0.8 does not carry
/// `http2` in its default set, `Cargo.toml` adds only the `ws` feature, and
/// `Cargo.lock` holds no `h2` crate. The line still earns its place. A
/// WebSocket over HTTP/2 needs the extended CONNECT method of RFC 8441, and
/// pirate has never proven that path, so this pin is what stops a later
/// change to the features from handing the socket to an HTTP/2 handler.
fn alpn_protocols() -> Vec<Vec<u8>> {
    vec![b"http/1.1".to_vec()]
}

/// Serves the supplied certificate for the name it covers, and a generated
/// certificate for every other name.
///
/// TRAP 4: [`ResolvesServerCert::resolve`] aborts the handshake when it
/// returns `None`. This resolver always has a certificate ready, so it never
/// returns `None`.
///
/// TRAP 5: `resolve` runs inside every handshake, so it must stay cheap. Both
/// certificates below are built once, at startup, in [`build`]. `resolve`
/// only reads the SNI and picks between the two; it generates nothing.
#[derive(Debug)]
struct NameAwareResolver {
    /// The certificate the operator supplied with `--cert`.
    supplied: Arc<CertifiedKey>,
    /// The leaf of [`Self::supplied`], parsed again on each handshake to
    /// check the SNI against it. The parse reads bytes that are already in
    /// memory; it holds no private key and it generates nothing.
    supplied_leaf: CertificateDer<'static>,
    /// The certificate pirate generates. Served for a name that
    /// [`Self::supplied`] does not cover.
    fallback: Arc<CertifiedKey>,
}

impl ResolvesServerCert for NameAwareResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        // A client that sends no SNI has named no server. The operator asked
        // for the supplied certificate, so that client gets it.
        let Some(sni) = client_hello.server_name() else {
            return Some(Arc::clone(&self.supplied));
        };

        if self.supplied_covers(sni) {
            Some(Arc::clone(&self.supplied))
        } else {
            Some(Arc::clone(&self.fallback))
        }
    }
}

impl NameAwareResolver {
    /// True when the supplied certificate covers `sni`.
    ///
    /// This runs the same match that a browser runs against a server,
    /// through [`verify_server_name`]. It honors a wildcard name in the
    /// supplied certificate exactly as rustls does, and it never returns an
    /// error: a name it cannot parse, or a certificate it cannot parse,
    /// simply does not match, and the caller falls back.
    fn supplied_covers(&self, sni: &str) -> bool {
        let Ok(name) = ServerName::try_from(sni) else {
            return false;
        };
        let Ok(parsed) = ParsedCertificate::try_from(&self.supplied_leaf) else {
            return false;
        };
        verify_server_name(&parsed, &name).is_ok()
    }
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

/// The names that a generated certificate carries.
///
/// The browser matches the host that the operator typed against these names.
/// The three loopback names cover every loopback form. `bound` is the address
/// that the listener accepted its socket on, and it becomes an IP SAN when it
/// names one machine. The system hostname covers the name that the operator
/// types from another machine, and the wildcard form of that hostname covers
/// every name under it, such as a name that a reverse proxy adds in front of
/// pirate.
///
/// `uname` gives `some-mac.local` on macOS, and the operator can type either
/// that name or `some-mac`. Therefore the list holds both forms.
///
/// A hostname that a certificate name cannot carry is dropped here, and pirate
/// prints a CAUTION that names the machine. The result then covers the loopback
/// names only, and the server still starts.
#[must_use]
pub fn selfsigned_names(bound: IpAddr) -> Vec<String> {
    let uname = rustix::system::uname();
    // A nodename that is not valid UTF-8 cannot be a certificate name either,
    // and the lossy form is what the CAUTION line prints.
    names_for(&String::from_utf8_lossy(uname.nodename().to_bytes()), bound)
}

/// The generated names for a machine whose system hostname is `nodename` and
/// whose listener is bound to `bound`.
///
/// [`selfsigned_names`] reads the system hostname and this function turns it,
/// with `bound`, into a list. The split lets a test give a hostname and a
/// bind address that no machine here carries.
fn names_for(nodename: &str, bound: IpAddr) -> Vec<String> {
    let mut names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    // `0.0.0.0` and `::` answer on every interface of the machine, and
    // neither address names one of them. An IP SAN of `0.0.0.0` would be
    // useless, so this function adds no IP SAN for an unspecified address.
    // pirate does not read the network interfaces of the machine to list
    // their addresses instead; that is out of scope here.
    if !bound.is_unspecified() {
        let bound_name = bound.to_string();
        if !names.contains(&bound_name) {
            names.push(bound_name);
        }
    }

    let Some(hostname) = clean_hostname(nodename) else {
        // The operator controls this name, and an attacker does not, so the
        // line can carry it. A silent drop gave the operator a certificate that
        // covered the machine under a name that the machine does not answer to.
        eprintln!(
            "pirate: CAUTION: A certificate name cannot carry the name of this machine, \
             {nodename}. This certificate covers the loopback names only."
        );
        return names;
    };
    // The first label comes second, so the full name stays the first hostname
    // in the list and the startup line reads in that order.
    let first_label = hostname
        .split('.')
        .next()
        .filter(|label| *label != hostname)
        .map(str::to_string);
    for name in [Some(hostname.clone()), first_label].into_iter().flatten() {
        if !names.contains(&name) {
            names.push(name);
        }
    }

    // TRAP 1: `ServerName::try_from` refuses the `*` character outright, so a
    // wildcard string can never pass through `clean_hostname`. `hostname` is
    // already validated above, with no `*` in it, so this line builds the
    // wildcard AFTER the gate and never sends the wildcard string itself
    // through that gate. `rcgen` needs no further check: a string that does
    // not parse as an IP address becomes a DNS name, wildcard and all.
    let wildcard = format!("*.{hostname}");
    if !names.contains(&wildcard) {
        names.push(wildcard);
    }

    names
}

/// `hostname` in lowercase, when a certificate name can carry it.
///
/// CAUTION: The gate here is [`ServerName::try_from`]. It refuses the `*`
/// character, so a wildcard name must never reach this function; build it
/// AFTER this function validates the plain hostname instead. See the CAUTION
/// in [`names_for`].
///
/// `localhost.` and `localhost` name one host, so every trailing dot goes.
fn clean_hostname(hostname: &str) -> Option<String> {
    let hostname = hostname.trim_end_matches('.').to_ascii_lowercase();
    ServerName::try_from(hostname.as_str()).ok()?;
    Some(hostname)
}

/// A chain of one certificate that pirate signs itself, covering the names
/// that [`selfsigned_names`] gives for `bound`.
///
/// The key exists in this process only. Nothing writes it to disk, so a restart
/// gives a new certificate and a new fingerprint.
fn self_signed(
    bound: IpAddr,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), Box<dyn std::error::Error>> {
    // `rcgen` turns a string that parses as an IP address into an IP address
    // name, and every other string into a DNS name.
    let signed = rcgen::generate_simple_self_signed(selfsigned_names(bound))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    /// The bind address that most tests use: it is already in the loopback
    /// list, so it changes no assertion that predates the bound-address SAN.
    const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

    #[test]
    fn the_hostname_test_takes_a_dns_name_and_drops_every_other_form() {
        // A name that a certificate can carry. The result is lowercase, and it
        // holds no trailing dot.
        assert_eq!(
            clean_hostname("Some-Mac.local."),
            Some("some-mac.local".to_string())
        );
        assert_eq!(clean_hostname("host1"), Some("host1".to_string()));
        // Every trailing dot goes, and not one dot only.
        assert_eq!(
            clean_hostname("some-mac.local.."),
            Some("some-mac.local".to_string())
        );
        // `rustls-pki-types` takes an underscore, so pirate takes it too.
        assert_eq!(
            clean_hostname("under_score"),
            Some("under_score".to_string())
        );

        // An invalid hostname costs the operator that one name. The server
        // still starts, so every case here gives `None` and a CAUTION line.
        let long_label = "a".repeat(64);
        let long_name = format!("{}.example", "a".repeat(250));
        for hostname in [
            "",
            ".",
            "a..b",
            "a b",
            "name:8080",
            "*.wild.example",
            long_label.as_str(),
            long_name.as_str(),
        ] {
            assert_eq!(clean_hostname(hostname), None, "{hostname}");
        }
    }

    #[test]
    fn every_generated_name_is_a_valid_server_name_or_the_wildcard_of_one() {
        // A name that `ServerName` refuses, and that is not the wildcard form
        // of a name it accepts, is a name that no browser can ask for and no
        // certificate resolver can match. TRAP 1: `ServerName` refuses `*`
        // outright, so the wildcard name itself never passes this call; this
        // test checks the label behind the `*.` instead.
        for name in selfsigned_names(LOOPBACK) {
            if let Some(label) = name.strip_prefix("*.") {
                assert!(
                    ServerName::try_from(label).is_ok(),
                    "the wildcard {name} covers no name that a client could ask for"
                );
                continue;
            }
            assert!(
                ServerName::try_from(name.as_str()).is_ok(),
                "the certificate would carry {name}, and no client could name it"
            );
        }
    }

    #[test]
    fn the_generated_names_hold_the_loopback_forms_and_no_duplicate() {
        let names = selfsigned_names(LOOPBACK);
        for name in ["localhost", "127.0.0.1", "::1"] {
            assert!(names.contains(&name.to_string()), "{name}");
        }

        // A hostname of `localhost`, and a hostname with no dot, both give a
        // name that the list already holds. It must appear once.
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), names.len(), "{names:?}");
    }

    #[test]
    fn the_bound_address_is_an_ip_san_only_when_it_names_one_machine() {
        // A concrete address becomes an IP SAN, and it appears once even when
        // it duplicates a loopback name that the list already holds.
        let names = names_for(
            "pirate-test-host",
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)),
        );
        assert!(names.contains(&"203.0.113.7".to_string()), "{names:?}");
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), names.len(), "{names:?}");

        // `0.0.0.0` and `::` answer on every interface, so neither address
        // names one machine. This function adds no IP SAN for either.
        for unspecified in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        ] {
            let names = names_for("pirate-test-host", unspecified);
            assert!(
                !names.contains(&unspecified.to_string()),
                "an unspecified bind address must not become an IP SAN: {names:?}"
            );
        }
    }

    #[test]
    fn the_generated_names_hold_the_wildcard_of_the_hostname() {
        let names = names_for("pirate-test-host", LOOPBACK);
        assert!(names.contains(&"pirate-test-host".to_string()), "{names:?}");
        assert!(
            names.contains(&"*.pirate-test-host".to_string()),
            "the wildcard name must be present by name, not only as a prefix match: {names:?}"
        );
    }

    /// REGRESSION. `clean_hostname` took a hostname whose last label is all
    /// digits, and `rcgen` wrote that string into a dNSName. `ServerName`
    /// refuses the same string, because RFC 1123 reserves an all-digit last
    /// label for an IPv4 address, and the parse as an IP address fails too. A
    /// browser could then never open a connection under that name, although
    /// the certificate carried it and the startup line advertised it.
    #[test]
    fn a_hostname_whose_last_label_is_all_digits_stays_out_of_the_certificate() {
        for hostname in ["box.1", "12345", "rack7.42"] {
            assert_eq!(
                clean_hostname(hostname),
                None,
                "a certificate must not promise {hostname}"
            );
            // The generated list then holds the loopback names and nothing
            // else, and pirate prints a CAUTION that names the machine.
            assert_eq!(
                names_for(hostname, LOOPBACK),
                ["localhost", "127.0.0.1", "::1"]
            );
        }
    }

    /// REGRESSION. A certificate with a subject common name and no
    /// subjectAltName parses, so an earlier guard in [`build`] stopped the
    /// server for it. Under the current rule the server always has a
    /// fallback certificate, so it serves this one and warns instead.
    #[test]
    fn a_certificate_with_a_common_name_and_no_san_parses_to_an_empty_name_list() {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "pirate.example");
        let key = rcgen::KeyPair::generate().unwrap();
        let signed = params.self_signed(&key).unwrap();

        // The parse takes this certificate, so a parse alone catches nothing.
        assert!(rustls::server::ParsedCertificate::try_from(signed.der()).is_ok());
        // The reader gives the empty list, which is the fault itself, and
        // `build` below turns that into a warning and not a stop.
        assert_eq!(
            certificate_names(signed.der()).expect("the leaf parses"),
            Vec::<String>::new()
        );

        let directory = std::env::temp_dir().join(format!(
            "pirate-tls-no-san-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let cert = directory.join("cert.pem");
        let key_file = directory.join("key.pem");
        std::fs::write(&cert, signed.pem()).unwrap();
        std::fs::write(&key_file, key.serialize_pem()).unwrap();

        let tls = build(
            &TlsSource::Files {
                cert,
                key: key_file,
            },
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        )
        .expect("a certificate with no name is a warning, and the server still starts");
        assert_eq!(
            tls.supplied
                .expect("a supplied certificate was given")
                .names,
            Vec::<String>::new()
        );

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn the_reader_gives_every_name_of_the_certificate_in_the_form_that_an_operator_types() {
        // A dNSName, a wildcard and an IP address all come back as the string
        // that the operator gives to the browser.
        let names = ["pirate.example", "*.wild.example", "127.0.0.1", "::1"];
        let signed =
            rcgen::generate_simple_self_signed(names.map(str::to_string).to_vec()).unwrap();
        assert_eq!(
            certificate_names(signed.cert.der()).expect("the leaf parses"),
            names
        );
    }

    #[test]
    fn a_leaf_that_does_not_parse_names_the_fault_and_holds_no_key() {
        let leaf = CertificateDer::from(vec![0u8; 8]);
        let error = certificate_names(&leaf).expect_err("eight zero bytes are not a certificate");
        assert!(
            error.contains("cannot read the names of the certificate"),
            "{error}"
        );
    }

    /// A resolver whose supplied certificate is the generated certificate for
    /// `LOOPBACK`. The value of `fallback` is never read by `supplied_covers`.
    fn resolver_over_generated_certificate() -> NameAwareResolver {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (chain, key) = self_signed(LOOPBACK).expect("the generated certificate must build");
        let leaf = chain
            .first()
            .expect("the chain holds one certificate")
            .clone();
        let provider =
            rustls::crypto::CryptoProvider::get_default().expect("the provider is installed above");
        let certified = Arc::new(
            CertifiedKey::from_der(chain, key, provider).expect("the generated pair must certify"),
        );
        NameAwareResolver {
            supplied: Arc::clone(&certified),
            supplied_leaf: leaf,
            fallback: certified,
        }
    }

    /// REGRESSION, and the reason for the whole function: no rustls
    /// `ClientHello` can ever carry an SNI of this shape. RFC 6066 defines SNI
    /// for a DNS name only: rustls never sends one for a
    /// [`ServerName::IpAddress`] on the client side, and the rustls server
    /// discards an SNI that parses as an address before `resolve` ever sees
    /// it. `supplied_covers` still takes a plain string, so this test calls
    /// it directly, with the loopback address in a form that the certificate
    /// never stores: an IP SAN holds the address as bytes, not as this text.
    /// A naive string compare against the text of [`certificate_names`] would
    /// refuse this form. Only a real parse of the address accepts it.
    #[test]
    fn an_sni_in_a_different_textual_form_still_matches_an_ip_san() {
        let resolver = resolver_over_generated_certificate();
        assert!(
            resolver.supplied_covers("0:0:0:0:0:0:0:1"),
            "the full form of ::1 names the same address and must still match"
        );
    }
}
