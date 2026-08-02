//! The token gate and the session store.
//!
//! pirate gives a shell to whoever reaches it, so the network path to the
//! server is not enough of a boundary. This module holds the one secret that
//! the server keeps, the sessions that a correct secret creates, and the two
//! header checks that a browser request must pass.
//!
//! The session model is small on purpose. The operator reads the token from
//! `$HOME/.pirate/auth_token` and the client posts it to `/auth`. The server
//! compares it, then answers with an opaque identifier in a cookie. That
//! identifier names an entry in a bounded list in server memory. Nothing is
//! signed, nothing is stored on disk, and a restart of the server ends every
//! session.

use std::fmt;
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{
    DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, COOKIE, HOST, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse as _, Response};
use sha2::{Digest as _, Sha256};
use subtle::{Choice, ConstantTimeEq as _};

use crate::AppState;

/// The name of the session cookie.
const COOKIE_NAME: &str = "pirate_session";

/// The length of a session identifier, in hexadecimal characters.
const SESSION_ID_LEN: usize = 64;

/// The number of random bytes behind a token and behind a session identifier.
const RANDOM_BYTES: usize = 32;

/// One work day. The operator opens the terminal in the morning and the
/// session lasts until the evening. A longer life gives a stolen cookie more
/// value, and a shorter one asks for the token again during the work.
const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// The size of the session store. One operator uses a few tabs, so 64 live
/// sessions are more than the intended use. The bound makes the memory of the
/// store constant, and it limits what a leaked token can accumulate.
const MAX_SESSIONS: usize = 64;

/// The shortest token that this module accepts. An operator can write the file
/// instead of pirate, and a short token is one that a flood of guesses reaches.
/// 32 characters is the floor, and the token that pirate writes is 64.
const MIN_TOKEN_BYTES: usize = 32;

/// The shared secret of the server.
pub struct Token(Vec<u8>);

impl fmt::Debug for Token {
    /// The value never reaches a log line or a panic message.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(redacted)")
    }
}

/// What can stop the server from reading or writing the token file.
#[derive(Debug)]
pub enum TokenError {
    /// `HOME` is empty or is not set.
    NoHome,
    /// The file system rejected an operation on this path.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The path of the token file names something other than a regular file.
    NotRegularFile(PathBuf),
    /// The parent path of the token file names something other than a
    /// directory.
    NotDirectory(PathBuf),
    /// The directory gives access to the group or to other users.
    DirectoryMode { path: PathBuf, mode: u32 },
    /// The token file gives access to the group or to other users.
    FileMode { path: PathBuf, mode: u32 },
    /// Another user owns the directory or the token file.
    WrongOwner {
        path: PathBuf,
        owner: u32,
        expected: u32,
    },
    /// The token file holds whitespace only.
    Empty(PathBuf),
    /// The token holds fewer than `MIN_TOKEN_BYTES` bytes.
    TooShort { path: PathBuf, minimum: usize },
    /// The operating system gave no random bytes.
    Random(getrandom::Error),
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // CAUTION: Do not add the token to a message here. An error goes to
        // the log, and the log is not a secret.
        match self {
            Self::NoHome => f.write_str(
                "the environment variable HOME is empty or is not set. \
                 Set HOME, or give the path of the token file",
            ),
            Self::Io { path, source } => {
                write!(f, "cannot use {}: {source}", path.display())
            }
            Self::NotRegularFile(path) => write!(
                f,
                "{} is not a regular file. The token file must be a regular file",
                path.display()
            ),
            Self::NotDirectory(path) => write!(
                f,
                "{} is not a directory. It must be the directory of the token file",
                path.display()
            ),
            Self::DirectoryMode { path, mode } => write!(
                f,
                "the directory {} is mode {:04o}. The required mode is 0700. Run `chmod 700 {}`",
                path.display(),
                mode & 0o7777,
                path.display()
            ),
            Self::FileMode { path, mode } => write!(
                f,
                "the token file {} is mode {:04o}. The required mode is 0600. Run `chmod 600 {}`",
                path.display(),
                mode & 0o7777,
                path.display()
            ),
            Self::WrongOwner {
                path,
                owner,
                expected,
            } => write!(
                f,
                "user {owner} owns {}. User {expected} must own it. \
                 A path that another user owns can hold a token that this user did not write",
                path.display()
            ),
            Self::Empty(path) => write!(
                f,
                "the token file {} is empty. Delete this file, then start pirate again. \
                 pirate writes a new token",
                path.display()
            ),
            Self::TooShort { path, minimum } => write!(
                f,
                "the token in {} is shorter than {minimum} bytes. \
                 Delete this file, then start pirate again. pirate writes a correct token",
                path.display()
            ),
            Self::Random(e) => write!(f, "the operating system gave no random bytes: {e}"),
        }
    }
}

impl std::error::Error for TokenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Random(e) => Some(e),
            _ => None,
        }
    }
}

/// The path of the token file, under the home directory of the user.
pub fn default_token_path() -> Result<PathBuf, TokenError> {
    let home = std::env::var_os("HOME").ok_or(TokenError::NoHome)?;
    if home.is_empty() {
        return Err(TokenError::NoHome);
    }
    Ok(Path::new(&home).join(".pirate").join("auth_token"))
}

/// Read the token from `path`, or write a new token there.
///
/// The first start of pirate creates the file with mode 0600. Every later
/// start reads it and stops when the mode of the file, or the mode of its
/// directory, gives access to another user.
pub fn load_or_create(path: &Path) -> Result<Token, TokenError> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    prepare_directory(directory)?;

    match File::open(path) {
        Ok(file) => read_token(path, file),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_token(path),
        Err(source) => Err(TokenError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

/// Create the directory of the token file when it is missing, then test its
/// mode.
fn prepare_directory(directory: &Path) -> Result<(), TokenError> {
    // `mkdir` masks this mode with the umask, and 0700 holds no group bit and
    // no other bit. The result is therefore 0700 or less.
    if let Err(source) = DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
    {
        return Err(TokenError::Io {
            path: directory.to_path_buf(),
            source,
        });
    }

    let metadata = std::fs::metadata(directory).map_err(|source| TokenError::Io {
        path: directory.to_path_buf(),
        source,
    })?;
    if !metadata.is_dir() {
        return Err(TokenError::NotDirectory(directory.to_path_buf()));
    }
    // The mode alone is not enough. A symlink at this path can point to a
    // directory of mode 0700 that another user owns, and that user then writes
    // the token that pirate reads.
    owner_is_this_user(directory, &metadata)?;
    let mode = metadata.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(TokenError::DirectoryMode {
            path: directory.to_path_buf(),
            mode,
        });
    }
    Ok(())
}

/// Read a token file that exists.
fn read_token(path: &Path, mut file: File) -> Result<Token, TokenError> {
    // The metadata comes from the open handle. A test on the path and then an
    // open is a time-of-check to time-of-use race: another process can move a
    // different file into the path between the two calls.
    let metadata = file.metadata().map_err(|source| TokenError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(TokenError::NotRegularFile(path.to_path_buf()));
    }
    owner_is_this_user(path, &metadata)?;
    let mode = metadata.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(TokenError::FileMode {
            path: path.to_path_buf(),
            mode,
        });
    }

    let mut content = Vec::new();
    file.read_to_end(&mut content)
        .map_err(|source| TokenError::Io {
            path: path.to_path_buf(),
            source,
        })?;

    // An editor adds a newline at the end of the file. That file still works.
    let token = content.trim_ascii_end();
    if token.is_empty() {
        return Err(TokenError::Empty(path.to_path_buf()));
    }
    if token.len() < MIN_TOKEN_BYTES {
        return Err(TokenError::TooShort {
            path: path.to_path_buf(),
            minimum: MIN_TOKEN_BYTES,
        });
    }
    Ok(Token(token.to_vec()))
}

/// Refuse a path that another user owns.
///
/// The user that runs pirate is the only user that gets the shell of pirate,
/// so the token must come from that same user.
fn owner_is_this_user(path: &Path, metadata: &std::fs::Metadata) -> Result<(), TokenError> {
    let expected = rustix::process::getuid().as_raw();
    let owner = metadata.uid();
    if owner != expected {
        return Err(TokenError::WrongOwner {
            path: path.to_path_buf(),
            owner,
            expected,
        });
    }
    Ok(())
}

/// Write a new token file with 32 random bytes in hexadecimal form.
fn create_token(path: &Path) -> Result<Token, TokenError> {
    let mut raw = [0u8; RANDOM_BYTES];
    getrandom::fill(&mut raw).map_err(TokenError::Random)?;
    let mut token = Vec::with_capacity(SESSION_ID_LEN);
    write_hex(&raw, &mut token);

    // `create_new` and `mode` belong to the same `open` call. A write and then
    // a `chmod` leaves the file world readable for the time between them, and
    // `create_new` stops a second process from losing its own new token.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|source| TokenError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    let mut written = token.clone();
    written.push(b'\n');
    file.write_all(&written).map_err(|source| TokenError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| TokenError::Io {
        path: path.to_path_buf(),
        source,
    })?;

    Ok(Token(token))
}

/// One lowercase hexadecimal digit for a value of 0 to 15.
fn hex_digit(value: u8) -> u8 {
    match value {
        0..=9 => b'0'.saturating_add(value),
        10..=15 => b'a'.saturating_add(value - 10),
        // The callers give 4 bits only. This arm never runs.
        _ => b'0',
    }
}

/// Append the hexadecimal form of `raw` to `out`.
fn write_hex(raw: &[u8], out: &mut Vec<u8>) {
    for byte in raw {
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0f));
    }
}

/// One live session: an opaque identifier and the time when it ends.
struct Session {
    id: [u8; SESSION_ID_LEN],
    expires: Instant,
}

/// Everything behind the lock.
struct Guarded {
    sessions: Vec<Session>,
}

impl Guarded {
    /// Drop every session that has ended.
    fn expire(&mut self, now: Instant) {
        self.sessions.retain(|session| session.expires > now);
    }

    /// Create a session and give its identifier.
    fn insert(&mut self, now: Instant) -> Result<[u8; SESSION_ID_LEN], getrandom::Error> {
        self.expire(now);
        if self.sessions.len() >= MAX_SESSIONS {
            // The store is full of live sessions. The one that ends first
            // costs the operator the least.
            let oldest = self
                .sessions
                .iter()
                .enumerate()
                .min_by_key(|(_, session)| session.expires)
                .map(|(index, _)| index);
            if let Some(index) = oldest {
                self.sessions.remove(index);
            }
        }

        let mut raw = [0u8; RANDOM_BYTES];
        getrandom::fill(&mut raw)?;
        let mut id = [0u8; SESSION_ID_LEN];
        for (slot, byte) in id.chunks_exact_mut(2).zip(raw) {
            if let [high, low] = slot {
                *high = hex_digit(byte >> 4);
                *low = hex_digit(byte & 0x0f);
            }
        }

        // The sum of the clock and 12 hours fits in an `Instant` on every real
        // platform. The fallback ends the session at once and never panics.
        let expires = now.checked_add(SESSION_TTL).unwrap_or(now);
        self.sessions.push(Session { id, expires });
        Ok(id)
    }

    /// True when one of `candidates` names a live session.
    ///
    /// The scan reads every entry for every candidate and it stops at no
    /// match, so its duration tells an attacker nothing about the stored
    /// identifiers.
    fn holds_any(&self, candidates: &[[u8; SESSION_ID_LEN]]) -> bool {
        let mut found = Choice::from(0u8);
        for session in &self.sessions {
            for candidate in candidates {
                found |= session.id.as_slice().ct_eq(candidate.as_slice());
            }
        }
        bool::from(found)
    }
}

/// The state of the token gate.
#[derive(Clone)]
pub struct Auth {
    /// `None` turns authentication off.
    inner: Option<Arc<Inner>>,
}

struct Inner {
    /// The SHA-256 digest of the token. The plain token ends with
    /// `Auth::enabled`, and a digest is enough for the comparison.
    digest: [u8; 32],
    secure_cookie: bool,
    guarded: Mutex<Guarded>,
}

impl Inner {
    /// Take the lock and recover from poison.
    ///
    /// Nothing under this lock can panic, so a poisoned lock means that
    /// another thread died for a different reason. The sessions stay
    /// correct after the recovery.
    fn lock(&self) -> MutexGuard<'_, Guarded> {
        self.guarded
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

impl fmt::Debug for Auth {
    /// The token and the session identifiers never reach this output.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Auth")
            .field("enabled", &self.inner.is_some())
            .finish()
    }
}

impl Auth {
    /// No token and no sessions. Every request passes.
    pub fn disabled() -> Self {
        Self { inner: None }
    }

    /// Take the token. `secure_cookie` adds `Secure` to the session cookie.
    pub fn enabled(token: Token, secure_cookie: bool) -> Self {
        let mut digest = [0u8; 32];
        // `Sha256` gives 32 bytes, which is the length of this array.
        digest.copy_from_slice(&Sha256::digest(&token.0));
        drop(token);

        Self {
            inner: Some(Arc::new(Inner {
                digest,
                secure_cookie,
                guarded: Mutex::new(Guarded {
                    sessions: Vec::new(),
                }),
            })),
        }
    }

    /// True when the server holds a token and asks for it.
    pub fn is_enabled(&self) -> bool {
        self.inner.is_some()
    }

    /// True when authentication is off, or when the headers carry a live
    /// session.
    pub fn is_authorized(&self, headers: &HeaderMap) -> bool {
        let Some(inner) = &self.inner else {
            return true;
        };
        let candidates = session_cookies(headers);
        if candidates.is_empty() {
            return false;
        }

        let now = Instant::now();
        let mut guarded = inner.lock();
        // A session that has ended is absent, and it leaves the store here.
        guarded.expire(now);
        guarded.holds_any(&candidates)
    }
}

/// `GET /auth`. 204 with a live session. 401 without one.
pub async fn get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    // This route tests no `Origin` header, and that is deliberate. A browser
    // sends no `Origin` on a same-origin GET, so the test would refuse the
    // probe of the client of pirate. The route starts no process and it
    // answers with a status only, so a cross-origin read of that status tells
    // the attacker only what its own cookie jar already says.
    if state.auth.is_authorized(&headers) {
        answer(StatusCode::NO_CONTENT)
    } else {
        answer(StatusCode::UNAUTHORIZED)
    }
}

/// `POST /auth`. The body is the token, as bytes.
pub async fn post(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(inner) = &state.auth.inner else {
        return answer(StatusCode::NO_CONTENT);
    };

    // A page on another origin can post a form to this route. Without this
    // test, that page plants a session cookie in the browser of the operator.
    if !origin_ok(&headers, state.tls) {
        return answer(StatusCode::FORBIDDEN);
    }

    // The digests are both 32 bytes, so the comparison reads a fixed length
    // and the duration tells the attacker nothing about the length of the
    // token. A comparison of the raw bytes returns early on a length
    // difference, which is that leak.
    let candidate = Sha256::digest(body.as_ref().trim_ascii());
    let matched = bool::from(candidate.as_slice().ct_eq(inner.digest.as_slice()));

    let now = Instant::now();
    let mut guarded = inner.lock();

    if !matched {
        // A message for each attempt is a way to flood stderr, so a failed
        // attempt writes nothing.
        return answer(StatusCode::UNAUTHORIZED);
    }

    let Ok(id) = guarded.insert(now) else {
        return answer(StatusCode::INTERNAL_SERVER_ERROR);
    };
    drop(guarded);

    let mut cookie = String::with_capacity(128);
    cookie.push_str(COOKIE_NAME);
    cookie.push('=');
    for byte in id {
        cookie.push(char::from(byte));
    }
    // No `Max-Age` and no `Expires`, so the browser drops the cookie when it
    // closes.
    cookie.push_str("; HttpOnly; SameSite=Strict; Path=/");
    if inner.secure_cookie {
        cookie.push_str("; Secure");
    }

    let Ok(value) = HeaderValue::from_str(&cookie) else {
        // The cookie holds hexadecimal characters and ASCII punctuation only,
        // so this arm never runs.
        return answer(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut response = answer(StatusCode::NO_CONTENT);
    response.headers_mut().insert(SET_COOKIE, value);
    response
}

/// An empty answer that no cache keeps.
fn answer(status: StatusCode) -> Response {
    let mut response = status.into_response();
    // A proxy or a browser that keeps a 204 answers the next request from the
    // cache, and the client then believes that a dead session is live.
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Every session identifier in the `Cookie` headers.
///
/// The reader takes each `pirate_session` pair and not the first one only. A
/// cookie carries no port, so a page on another port of the same host can set
/// a second `pirate_session` pair. RFC 6265 sorts the pair with the longer path
/// first, and a reader of the first pair alone then reads the junk pair. That
/// is a way to stop the terminal of the operator for good.
///
/// The result drops a value that is not 64 lowercase hexadecimal characters.
fn session_cookies(headers: &HeaderMap) -> Vec<[u8; SESSION_ID_LEN]> {
    let mut candidates = Vec::new();
    for value in headers.get_all(COOKIE) {
        for pair in value.as_bytes().split(|byte| *byte == b';') {
            let pair = pair.trim_ascii();
            let mut parts = pair.splitn(2, |byte| *byte == b'=');
            let (Some(name), Some(raw)) = (parts.next(), parts.next()) else {
                continue;
            };
            if name.trim_ascii() != COOKIE_NAME.as_bytes() {
                continue;
            }
            if let Some(id) = hex_id(raw.trim_ascii()) {
                candidates.push(id);
            }
        }
    }
    candidates
}

/// Copy `raw` into a fixed array when it is 64 lowercase hexadecimal
/// characters.
///
/// `Guarded::insert` writes lowercase only. This reader takes lowercase only,
/// so the two agree by rule and not by accident.
fn hex_id(raw: &[u8]) -> Option<[u8; SESSION_ID_LEN]> {
    if raw.len() != SESSION_ID_LEN {
        return None;
    }
    let lowercase = raw
        .iter()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if !lowercase {
        return None;
    }
    let mut id = [0u8; SESSION_ID_LEN];
    // Both slices are 64 bytes long, which the test above holds.
    id.copy_from_slice(raw);
    Some(id)
}

/// True when the `Origin` header names this server.
///
/// This test closes one attack: a page on another origin opens a WebSocket to
/// pirate in the browser of the operator. The browser sends the session cookie
/// with that handshake, because a WebSocket obeys no same-origin rule of its
/// own, and the page then reads and writes the terminal of the operator.
///
/// This function compares `Origin` with `Host` only. It makes no claim about
/// which names the server answers to. Under TLS the certificate makes that
/// claim, and the browser checks it before it opens the connection. This
/// server compares no name against the certificate.
pub fn origin_ok(headers: &HeaderMap, tls: bool) -> bool {
    // Two `Host` headers are a request-smuggling shape: a front proxy reads one
    // header and pirate reads the other. The same holds for `Origin`. One
    // header of each, or the request stops here.
    if headers.get_all(HOST).iter().count() != 1 || headers.get_all(ORIGIN).iter().count() != 1 {
        return false;
    }

    // A browser sends `Origin` on a WebSocket handshake and on a cross-origin
    // `fetch`. A request without the header is therefore not a browser that
    // pirate serves.
    let Some(origin) = headers.get(ORIGIN).map(HeaderValue::as_bytes) else {
        return false;
    };
    let Some(host) = headers.get(HOST).map(HeaderValue::as_bytes) else {
        return false;
    };

    let Some((host_host, host_port)) = split_authority(host) else {
        return false;
    };

    let (scheme, default_port) = if tls {
        (b"https".as_slice(), 443u16)
    } else {
        (b"http".as_slice(), 80u16)
    };
    let Some(authority) = strip_scheme(origin, scheme) else {
        return false;
    };
    let Some((origin_host, origin_port)) = split_authority(authority) else {
        return false;
    };

    // A host name is not case sensitive, and a missing port is the default
    // port of the scheme.
    origin_host.eq_ignore_ascii_case(host_host)
        && origin_port.unwrap_or(default_port) == host_port.unwrap_or(default_port)
}

/// The authority of `origin`, after `scheme` and `://`.
fn strip_scheme<'a>(origin: &'a [u8], scheme: &[u8]) -> Option<&'a [u8]> {
    let prefix = scheme.len().checked_add(3)?;
    if origin.len() < prefix {
        return None;
    }
    let (head, rest) = origin.split_at(scheme.len());
    // The comparison reads the case. No browser writes an uppercase scheme in
    // `Origin`, so the parser stays as narrow as the check needs.
    if head != scheme {
        return None;
    }
    let (separator, authority) = rest.split_at(3);
    if separator != b"://" {
        return None;
    }
    Some(authority)
}

/// The host and the port of an authority, without a URL crate.
fn split_authority(authority: &[u8]) -> Option<(&[u8], Option<u16>)> {
    let host_end = if authority.first() == Some(&b'[') {
        // An IPv6 address in brackets holds colons of its own, so the closing
        // bracket ends the host.
        authority
            .iter()
            .position(|byte| *byte == b']')?
            .saturating_add(1)
    } else {
        authority
            .iter()
            .position(|byte| *byte == b':')
            .unwrap_or(authority.len())
    };
    let host = authority.get(..host_end)?;
    if host.is_empty() {
        return None;
    }
    match authority.get(host_end..) {
        None | Some([]) => Some((host, None)),
        Some([b':', digits @ ..]) => Some((host, Some(parse_port(digits)?))),
        Some(_) => None,
    }
}

/// A port of 1 to 5 decimal digits.
fn parse_port(digits: &[u8]) -> Option<u16> {
    if digits.is_empty() || digits.len() > 5 {
        return None;
    }
    let mut port: u16 = 0;
    for byte in digits {
        let digit = char::from(*byte).to_digit(10)?;
        let digit = u16::try_from(digit).ok()?;
        port = port.checked_mul(10)?.checked_add(digit)?;
    }
    Some(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            let name = axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
            map.append(name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn an_origin_that_names_this_server_passes() {
        let same_port = headers(&[
            ("origin", "http://localhost:8080"),
            ("host", "localhost:8080"),
        ]);
        assert!(origin_ok(&same_port, false));

        // The default port of the scheme and a `Host` with no port agree.
        let default_port = headers(&[
            ("origin", "http://Pirate.Example"),
            ("host", "pirate.example:80"),
        ]);
        assert!(origin_ok(&default_port, false));
        let tls_port = headers(&[
            ("origin", "https://pirate.example:443"),
            ("host", "pirate.example"),
        ]);
        assert!(origin_ok(&tls_port, true));

        let literal = headers(&[("origin", "http://[::1]:8080"), ("host", "[::1]:8080")]);
        assert!(origin_ok(&literal, false));
        let ipv4 = headers(&[
            ("origin", "http://127.0.0.1:8080"),
            ("host", "127.0.0.1:8080"),
        ]);
        assert!(origin_ok(&ipv4, false));
    }

    #[test]
    fn a_host_and_origin_that_disagree_fail_on_every_transport() {
        // The server compares no name against a certificate now. A browser
        // enforces that match before it opens the connection, so this function
        // asserts only the rule that remains: `Host` and `Origin` must agree.
        let agree = headers(&[
            ("origin", "http://evil.example:8080"),
            ("host", "evil.example:8080"),
        ]);
        assert!(origin_ok(&agree, false), "plain HTTP, the headers agree");
        let agree_tls = headers(&[
            ("origin", "https://evil.example:8080"),
            ("host", "evil.example:8080"),
        ]);
        assert!(
            origin_ok(&agree_tls, true),
            "the certificate makes no difference here: the headers agree"
        );

        let disagree = headers(&[
            ("origin", "http://evil.example:8080"),
            ("host", "pirate.example:8080"),
        ]);
        assert!(
            !origin_ok(&disagree, false),
            "plain HTTP, the headers disagree"
        );
        let disagree_tls = headers(&[
            ("origin", "https://evil.example:8080"),
            ("host", "pirate.example:8080"),
        ]);
        assert!(
            !origin_ok(&disagree_tls, true),
            "the certificate makes no difference here: the headers disagree"
        );
    }

    #[test]
    fn a_second_host_or_origin_header_fails() {
        // Two headers of one name are a request-smuggling shape, and that is
        // not a question about a name. Both transports refuse it.
        let two_hosts = headers(&[
            ("origin", "http://localhost:8080"),
            ("host", "localhost:8080"),
            ("host", "evil.example"),
        ]);
        assert!(!origin_ok(&two_hosts, false));
        assert!(!origin_ok(&two_hosts, true));

        let two_origins = headers(&[
            ("origin", "http://localhost:8080"),
            ("origin", "http://evil.example"),
            ("host", "localhost:8080"),
        ]);
        assert!(!origin_ok(&two_origins, false));
        assert!(!origin_ok(&two_origins, true));
    }

    #[test]
    fn every_other_origin_fails() {
        // A missing header on either side.
        assert!(!origin_ok(&headers(&[("host", "localhost")]), false));
        assert!(!origin_ok(
            &headers(&[("origin", "http://localhost")]),
            false
        ));

        let cases = [
            // The scheme is not the scheme of this server.
            ("http://localhost:443", "localhost:443", true),
            // An uppercase scheme. No browser writes one.
            ("HTTP://localhost", "localhost", false),
            // The port and then the host do not agree.
            ("http://localhost:81", "localhost:80", false),
            ("http://pirate.example", "localhost", false),
            // Values that a parser can fail on.
            ("null", "localhost", false),
            ("htt", "localhost", false),
            ("http://", "localhost", false),
            ("http://:80", ":80", false),
            ("http://localhost:99999", "localhost", false),
            ("http://localhost:", "localhost", false),
            ("http://[::1", "localhost", false),
        ];
        for (origin, host, tls) in cases {
            let map = headers(&[("origin", origin), ("host", host)]);
            assert!(!origin_ok(&map, tls), "{origin} and {host}");
        }
    }

    #[test]
    fn the_reader_takes_every_session_cookie_of_every_header() {
        let first = "a".repeat(64);
        let second = "b".repeat(64);
        let map = headers(&[
            ("cookie", &format!("x=1; pirate_session={first} ; y=2")),
            ("cookie", &format!("pirate_session={second}")),
        ]);
        assert_eq!(session_cookies(&map), vec![[b'a'; 64], [b'b'; 64]]);
    }

    #[test]
    fn a_shadowing_cookie_does_not_stop_the_real_session() {
        let now = Instant::now();
        let mut guarded = Guarded {
            sessions: Vec::new(),
        };
        let id = guarded.insert(now).unwrap();
        let real = String::from_utf8(id.to_vec()).unwrap();

        // A page on another port sets its own pair with a longer path, and the
        // browser sends that pair first.
        let junk = "0".repeat(64);
        let map = headers(&[(
            "cookie",
            &format!("pirate_session={junk}; pirate_session={real}"),
        )]);
        let candidates = session_cookies(&map);
        assert_eq!(candidates.len(), 2);
        assert!(guarded.holds_any(&candidates));
    }

    #[test]
    fn a_pile_of_junk_pairs_does_not_hide_the_real_session() {
        // An attacker that reaches the cookie jar plants junk `pirate_session`
        // pairs, and RFC 6265 sorts them before the real one. A reader that
        // stops too early never compares the real session, and the operator
        // gets 401 for good. A measurement against the real binary found that
        // at the earlier bound of 8.
        let now = Instant::now();
        let mut guarded = Guarded {
            sessions: Vec::new(),
        };
        let id = guarded.insert(now).unwrap();
        let real = String::from_utf8(id.to_vec()).unwrap();

        let junk = "0".repeat(64);
        let mut text = String::new();
        for _ in 0..31 {
            text.push_str(&format!("pirate_session={junk}; "));
        }
        text.push_str(&format!("pirate_session={real}"));

        let candidates = session_cookies(&headers(&[("cookie", &text)]));
        assert_eq!(candidates.len(), 32);
        assert!(
            guarded.holds_any(&candidates),
            "the real session must survive 31 junk pairs before it",
        );
    }

    #[test]
    fn a_pile_of_junk_pairs_that_are_not_sessions_does_not_hide_the_real_one() {
        // A bound on the pairs that the reader walks would refuse this header,
        // and that is a lockout an attacker reaches by setting cookies that
        // are not session cookies at all. Only a pair that parses as an
        // identifier may cost a candidate slot.
        let mut text = String::new();
        for index in 0..1000 {
            text.push_str(&format!("junk{index}=1; "));
        }
        let real = "b".repeat(64);
        text.push_str(&format!("pirate_session={real}"));
        assert_eq!(
            session_cookies(&headers(&[("cookie", &text)])),
            vec![[b'b'; 64]],
            "the real session must survive a header of junk pairs"
        );
    }

    #[test]
    fn a_cookie_that_is_not_an_identifier_gives_nothing() {
        let cases = [
            "pirate_session=short",
            "pirate_session=zzzz",
            "pirate_sessions=x",
            // Uppercase. `insert` writes lowercase only.
            &"A".repeat(64),
            ";;;=;=;",
            "",
        ];
        for case in cases {
            let text = if case.len() == 64 {
                format!("pirate_session={case}")
            } else {
                case.to_string()
            };
            assert!(
                session_cookies(&headers(&[("cookie", &text)])).is_empty(),
                "{text}"
            );
        }
    }

    /// A directory that no other test uses.
    fn scratch_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("pirate-auth-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn set_mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn a_new_token_file_is_64_hexadecimal_characters_at_mode_0600() {
        let directory = scratch_directory("new");
        let path = directory.join("auth_token");

        let first = load_or_create(&path).unwrap();
        assert_eq!(first.0.len(), SESSION_ID_LEN);
        assert!(first.0.iter().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(format!("{first:?}"), "Token(redacted)");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );

        // The second start reads the file that the first start wrote.
        let second = load_or_create(&path).unwrap();
        assert_eq!(first.0, second.0);

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_mode_that_another_user_can_read_gives_the_chmod_command() {
        let directory = scratch_directory("mode");
        let path = directory.join("auth_token");
        load_or_create(&path).unwrap();

        set_mode(&path, 0o644);
        let error = load_or_create(&path).unwrap_err();
        assert!(format!("{error}").contains("chmod 600"), "{error}");

        set_mode(&path, 0o600);
        set_mode(&directory, 0o755);
        let error = load_or_create(&path).unwrap_err();
        assert!(format!("{error}").contains("chmod 700"), "{error}");

        set_mode(&directory, 0o700);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_path_of_this_user_passes_the_owner_test() {
        let directory = scratch_directory("owner");
        let path = directory.join("auth_token");
        load_or_create(&path).unwrap();

        // A file that another user owns needs another user, which a test
        // cannot make. The message of the error is what the operator reads.
        let error = TokenError::WrongOwner {
            path: path.clone(),
            owner: 4242,
            expected: 1000,
        };
        let text = format!("{error}");
        assert!(text.contains("4242"), "{text}");
        assert!(text.contains("1000"), "{text}");
        assert!(text.contains(&path.display().to_string()), "{text}");

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_large_short_or_empty_token_file_is_an_error() {
        let directory = scratch_directory("content");
        let path = directory.join("auth_token");
        load_or_create(&path).unwrap();

        std::fs::write(&path, b"  \n").unwrap();
        set_mode(&path, 0o600);
        assert!(matches!(load_or_create(&path), Err(TokenError::Empty(_))));

        std::fs::write(&path, b"deadbeef\n").unwrap();
        set_mode(&path, 0o600);
        assert!(matches!(
            load_or_create(&path),
            Err(TokenError::TooShort { .. })
        ));

        // A trailing newline from an editor still gives the token.
        let written = "z".repeat(MIN_TOKEN_BYTES);
        std::fs::write(&path, format!("{written}\n")).unwrap();
        set_mode(&path, 0o600);
        assert_eq!(load_or_create(&path).unwrap().0, written.as_bytes());

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn the_store_holds_64_sessions_and_drops_the_ones_that_ended() {
        let now = Instant::now();
        let mut guarded = Guarded {
            sessions: Vec::new(),
        };

        let first = guarded.insert(now).unwrap();
        for _ in 0..MAX_SESSIONS + 10 {
            guarded.insert(now).unwrap();
        }
        assert_eq!(guarded.sessions.len(), MAX_SESSIONS);
        assert!(!guarded.holds_any(&[first]));

        let last = guarded.insert(now).unwrap();
        assert!(guarded.holds_any(&[last]));
        guarded.expire(now + SESSION_TTL + Duration::from_secs(1));
        assert!(guarded.sessions.is_empty());
        assert!(!guarded.holds_any(&[last]));
    }

    #[test]
    fn the_debug_output_holds_no_secret() {
        let auth = Auth::enabled(Token(b"a-token-that-must-not-appear".to_vec()), true);
        let text = format!("{auth:?}");
        assert!(!text.contains("token"), "{text}");
        assert!(auth.is_enabled());
        assert!(!auth.is_authorized(&HeaderMap::new()));

        assert!(!Auth::disabled().is_enabled());
        assert!(Auth::disabled().is_authorized(&HeaderMap::new()));
    }
}
