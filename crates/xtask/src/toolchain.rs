//! Toolchain acquisition: a pinned Zig, and the macOS SDK shim it needs.

use crate::{repo_root, run, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The Zig host triple, in the naming that ziglang.org uses.
pub fn host_zig_triple() -> Result<&'static str> {
    Ok(match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-macos",
        ("x86_64", "macos") => "x86_64-macos",
        ("x86_64", "linux") => "x86_64-linux",
        ("aarch64", "linux") => "aarch64-linux",
        (a, o) => return Err(format!("unsupported host {a}-{o}").into()),
    })
}

pub struct ZigPin {
    pub version: String,
    pub sha256: String,
}

/// Read toolchain/zig.toml and check it against .zigversion.
pub fn read_pin() -> Result<ZigPin> {
    let root = repo_root();
    let manifest = std::fs::read_to_string(root.join("toolchain/zig.toml"))?;
    let doc: toml::Value = toml::from_str(&manifest)?;

    let version = doc
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or("toolchain/zig.toml has no `version`")?
        .to_string();

    let declared = std::fs::read_to_string(root.join(".zigversion"))?;
    let declared = declared.trim();
    if declared != version {
        return Err(format!(
            ".zigversion says {declared}, toolchain/zig.toml says {version}. \
             These must be equal."
        )
        .into());
    }

    let triple = host_zig_triple()?;
    let sha256 = doc
        .get("checksums")
        .and_then(|c| c.get(triple))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("toolchain/zig.toml has no checksum for {triple}"))?
        .to_string();

    Ok(ZigPin { version, sha256 })
}

/// Download and unpack the pinned Zig, unless it is already present.
/// Returns the directory that holds the `zig` program.
pub fn ensure_zig() -> Result<PathBuf> {
    let pin = read_pin()?;
    let triple = host_zig_triple()?;
    let tc = repo_root().join(".toolchain");
    let dir = tc.join(format!("zig-{triple}-{}", pin.version));

    if dir.join("zig").is_file() {
        return Ok(dir);
    }

    std::fs::create_dir_all(&tc)?;
    let url = format!(
        "https://ziglang.org/download/{v}/zig-{triple}-{v}.tar.xz",
        v = pin.version
    );
    let tarball = tc.join("zig-download.tar.xz");

    eprintln!("xtask: downloading zig {} for {triple}", pin.version);
    run(
        "curl",
        &["-fsSL", &url, "-o", &tarball.to_string_lossy()],
        &tc,
    )?;

    let got = sha256_file(&tarball)?;
    if got != pin.sha256 {
        let _ = std::fs::remove_file(&tarball);
        return Err(format!(
            "checksum mismatch for {url}\n  expected {}\n  got      {got}",
            pin.sha256
        )
        .into());
    }
    eprintln!("xtask: checksum ok");

    run("tar", &["xJf", &tarball.to_string_lossy()], &tc)?;
    std::fs::remove_file(&tarball)?;

    if !dir.join("zig").is_file() {
        return Err(format!("zig not found at {} after unpack", dir.display()).into());
    }
    Ok(dir)
}

/// A macOS SDK that Zig 0.15.2 can link against.
///
/// The macOS 26 SDK lists `arm64e-macos` and does not list `arm64-macos` in the
/// first document of libSystem.B.tbd. Zig 0.15.2 needs an exact target match, so
/// that SDK leaves every libc symbol undefined. Find an SDK that lists the host
/// architecture, and prefer the newest one that does.
#[cfg(target_os = "macos")]
pub fn find_usable_sdk() -> Result<PathBuf> {
    // TBD files use Apple's architecture names, not Rust's. Note that
    // `arm64e-macos` does not satisfy `arm64-macos`: Zig needs an exact match,
    // and that difference is the whole fault this function works around.
    let wanted = match std::env::consts::ARCH {
        "aarch64" => "arm64-macos",
        "x86_64" => "x86_64-macos",
        other => return Err(format!("unsupported macOS architecture {other}").into()),
    };
    let mut usable: Vec<PathBuf> = Vec::new();

    for base in [
        "/Library/Developer/CommandLineTools/SDKs",
        "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs",
    ] {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Skip the MacOSX.sdk symlink; it tracks the newest SDK, which is
            // the one that breaks.
            if path.file_name().is_some_and(|n| n == "MacOSX.sdk") {
                continue;
            }
            let tbd = path.join("usr/lib/libSystem.B.tbd");
            let Ok(text) = std::fs::read_to_string(&tbd) else {
                continue;
            };
            let Some(targets) = text.lines().find(|l| l.starts_with("targets:")) else {
                continue;
            };
            // Split on the delimiters so that `arm64e-macos` cannot match
            // `arm64-macos` as a substring.
            if targets.split(['[', ']', ',']).any(|t| t.trim() == wanted) {
                usable.push(path);
            }
        }
    }

    usable.sort();
    usable.pop().ok_or_else(|| {
        format!(
            "no macOS SDK lists the target `{wanted}` in the first document of \
             libSystem.B.tbd. Zig {} cannot link without one. Install the macOS 15 \
             SDK, or build on a host whose SDK lists {wanted}.",
            read_pin().map(|p| p.version).unwrap_or_default()
        )
        .into()
    })
}

/// Write a PATH shim for `xcrun` that answers with the chosen SDK.
///
/// SDKROOT does not work here. Zig runs `xcrun --sdk macosx --show-sdk-path`, and
/// the explicit `--sdk` makes xcrun ignore SDKROOT. Zig runs `xcrun` by name, so a
/// shim earlier in PATH controls the answer.
#[cfg(target_os = "macos")]
pub fn ensure_shim(sdk: &Path) -> Result<PathBuf> {
    let dir = repo_root().join(".toolchain/shim");
    std::fs::create_dir_all(&dir)?;
    let shim = dir.join("xcrun");

    let body = format!(
        "#!/bin/bash\n\
         # Generated by `cargo xtask`. Do not edit.\n\
         if [ \"$1\" = \"--sdk\" ] && [ \"$2\" = \"macosx\" ] && [ \"$3\" = \"--show-sdk-path\" ]; then\n\
         \x20 echo \"{}\"\n\
         \x20 exit 0\n\
         fi\n\
         exec /usr/bin/xcrun \"$@\"\n",
        sdk.display()
    );
    std::fs::write(&shim, body)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dir)
}

/// Every environment change that a build of libghostty-vt-sys needs.
/// Returns pairs to set on the child process.
pub fn build_env() -> Result<Vec<(String, String)>> {
    let zig_dir = ensure_zig()?;

    // The shim comes before zig on the path, so that its `xcrun` wins. Only
    // macOS needs it, and a `mut` binding on Linux would be an unused one.
    #[cfg(target_os = "macos")]
    let prefix = {
        let sdk = find_usable_sdk()?;
        eprintln!("xtask: using macOS SDK {}", sdk.display());
        vec![ensure_shim(&sdk)?, zig_dir]
    };
    #[cfg(not(target_os = "macos"))]
    let prefix = vec![zig_dir];

    let existing = std::env::var("PATH").unwrap_or_default();
    let mut path = std::env::join_paths(prefix)?.to_string_lossy().into_owned();
    path.push(':');
    path.push_str(&existing);

    let mut env = vec![("PATH".to_string(), path)];
    env.push((
        "ZIG_GLOBAL_CACHE_DIR".to_string(),
        repo_root()
            .join(".toolchain/zig-cache")
            .to_string_lossy()
            .into_owned(),
    ));
    Ok(env)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}
