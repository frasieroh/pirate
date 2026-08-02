//! Static asset serving.
//!
//! Assets come from one of two places. By default they are embedded in the
//! binary at compile time, so the binary runs from any directory with no files
//! beside it. With `--assets-dir` they come from disk instead, which lets the
//! Vite dev server supply them without a Rust rebuild.
//!
//! A Vite plugin writes a `.gz` and a `.br` beside each compressible file in
//! web/dist. This module chooses one from the Accept-Encoding header, and falls
//! back to the plain file.

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;
use std::borrow::Cow;
use std::path::{Path, PathBuf};

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Embedded;

/// Where a request body came from, and how it was encoded.
struct Payload {
    bytes: Vec<u8>,
    encoding: Option<&'static str>,
}

pub async fn serve(path: &str, headers: &HeaderMap, assets_dir: Option<&PathBuf>) -> Response {
    // Strip the leading slash and fall back to index.html for the root.
    let mut rel = path.trim_start_matches('/');
    if rel.is_empty() {
        rel = "index.html";
    }

    // Reject traversal before it reaches the filesystem.
    if rel.split('/').any(|c| c == ".." || c == ".") {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let accepts = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let Some(payload) = load(rel, accepts, assets_dir) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    // The content type belongs to the original file, not to the compressed copy.
    let mime = mime_guess::from_path(rel).first_or_octet_stream();

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        // The browser must read the type that pirate states, and not guess one
        // from the bytes. A guess turns an asset into a document.
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // No page may put pirate in a frame. The terminal of the operator is
        // not a widget for another origin.
        //
        // CAUTION: Keep this policy at `frame-ancestors`. The client loads a
        // WebAssembly module and inline styles, so a `default-src` or a
        // `script-src` here stops the terminal from starting.
        .header(header::CONTENT_SECURITY_POLICY, "frame-ancestors 'none'");
    if let Some(encoding) = payload.encoding {
        response = response
            .header(header::CONTENT_ENCODING, encoding)
            .header(header::VARY, "accept-encoding");
    }
    response
        .body(Body::from(payload.bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Try brotli, then gzip, then the plain file.
fn load(rel: &str, accepts: &str, assets_dir: Option<&PathBuf>) -> Option<Payload> {
    let candidates: [(Option<&'static str>, String); 3] = [
        (Some("br"), format!("{rel}.br")),
        (Some("gzip"), format!("{rel}.gz")),
        (None, rel.to_string()),
    ];

    for (encoding, name) in candidates {
        match encoding {
            Some("br") if !accepts.contains("br") => continue,
            Some("gzip") if !accepts.contains("gzip") => continue,
            _ => {}
        }
        if let Some(bytes) = read(&name, assets_dir) {
            return Some(Payload { bytes, encoding });
        }
    }
    None
}

fn read(name: &str, assets_dir: Option<&PathBuf>) -> Option<Vec<u8>> {
    match assets_dir {
        Some(dir) => read_from_disk(dir, name),
        None => Embedded::get(name).map(|f| match f.data {
            Cow::Borrowed(b) => b.to_vec(),
            Cow::Owned(b) => b,
        }),
    }
}

fn read_from_disk(dir: &Path, name: &str) -> Option<Vec<u8>> {
    let path = dir.join(name);
    // Make sure the resolved path stays inside the assets directory.
    let root = dir.canonicalize().ok()?;
    let resolved = path.canonicalize().ok()?;
    if !resolved.starts_with(&root) {
        return None;
    }
    std::fs::read(resolved).ok()
}

/// The number of embedded files. Zero means stage 1 output never made it in.
pub fn embedded_count() -> usize {
    Embedded::iter().count()
}
