//! Precompression of the web assets.
//!
//! The server embeds the plain file and both compressed forms, then chooses one
//! from the Accept-Encoding header. Compressing once at build time costs nothing
//! at run time.

use crate::Result;
use std::io::Write;
use std::path::Path;

const COMPRESSIBLE: &[&str] = &["html", "js", "css", "json", "svg", "wasm", "map", "txt"];

/// Write a `.gz` and a `.br` beside every compressible file. Returns the count.
pub fn compress_tree(dir: &Path) -> Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            count += compress_tree(&path)?;
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if ext == "gz" || ext == "br" || !COMPRESSIBLE.contains(&ext) {
            continue;
        }

        let bytes = std::fs::read(&path)?;
        // Skip files too small for compression to pay for its own headers.
        if bytes.len() < 1024 {
            continue;
        }

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        gz.write_all(&bytes)?;
        std::fs::write(path.with_extension(format!("{ext}.gz")), gz.finish()?)?;

        let mut br = Vec::new();
        let mut writer = brotli::CompressorWriter::new(&mut br, 4096, 11, 22);
        writer.write_all(&bytes)?;
        drop(writer);
        std::fs::write(path.with_extension(format!("{ext}.br")), br)?;

        count += 1;
    }
    Ok(count)
}
