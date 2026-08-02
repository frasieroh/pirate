//! Toolchain acquisition: the tools of mise.toml, and the macOS SDK shim.
//!
//! mise installs every build tool. It compares each download against the
//! SHA-256 in mise.lock. Some backends add a signature check, and `core:bun`
//! and the two `aqua:` tools get the checksum only. This module therefore holds
//! no downloader and no version number. mise does not solve the macOS SDK
//! fault, so the shim stays here.

use crate::{repo_root, run_with_env, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

/// mise reads a configuration file only when the file is trusted. This variable
/// grants that trust for one child process.
const TRUST_VAR: &str = "MISE_TRUSTED_CONFIG_PATHS";

/// The install command for the host.
#[cfg(target_os = "macos")]
const INSTALL_MISE: &str = "brew install mise";
#[cfg(not(target_os = "macos"))]
const INSTALL_MISE: &str = "curl https://mise.run | sh";

/// The first `mise` program on PATH that this process can run.
fn find_mise() -> Result<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("mise");
        if is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "`mise` is not on PATH. mise installs every tool of mise.toml. \
         Install mise with `{INSTALL_MISE}`. Then run this command again."
    )
    .into())
}

/// True when the path is a file that holds an executable bit.
///
/// `execvp` steps over a PATH entry that it cannot run and reads the next one. A
/// plain file test stops the whole run on a data file named `mise` that sits
/// earlier on PATH.
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The value of MISE_TRUSTED_CONFIG_PATHS for the child process.
///
/// The variable is colon-separated, and a bare assignment drops every path that
/// the caller already trusts. This function puts the repository first and keeps
/// the rest. `join_paths` refuses a path that holds a colon, because such a path
/// cannot survive the list form.
fn trusted_paths(root: &Path) -> Result<String> {
    let mut dirs: Vec<PathBuf> = vec![root.to_path_buf()];
    if let Some(current) = std::env::var_os(TRUST_VAR) {
        dirs.extend(std::env::split_paths(&current).filter(|dir| dir.as_path() != root));
    }
    let joined =
        std::env::join_paths(&dirs).map_err(|e| format!("cannot build {TRUST_VAR}: {e}"))?;
    joined
        .into_string()
        .map_err(|_| format!("{TRUST_VAR} holds bytes that are not UTF-8").into())
}

/// The pinned Zig version, from the one file that declares it.
#[cfg(target_os = "macos")]
fn zig_version() -> Result<String> {
    let path = repo_root().join("mise.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
    let version = doc
        .get("tools")
        .and_then(|t| t.get("zig"))
        .and_then(|v| v.as_str())
        .ok_or("mise.toml has no `zig` under [tools]")?;
    Ok(version.to_string())
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
    // Name the Zig version when mise.toml gives one. An unreadable mise.toml is
    // a different fault, and a blank version there reads as a broken message.
    let zig = match zig_version() {
        Ok(version) => format!("Zig {version}"),
        Err(_) => "Zig".to_string(),
    };
    usable.pop().ok_or_else(|| {
        format!(
            "no macOS SDK lists the target `{wanted}` in the first document of \
             libSystem.B.tbd. {zig} cannot link without one. Install the macOS 15 \
             SDK, or build on a host whose SDK lists {wanted}."
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
///
/// mise installs the tools first, and every part of the build runs with the
/// result. A fresh clone therefore runs `cargo xtask dist` with no setup step.
pub fn build_env() -> Result<Vec<(String, String)>> {
    let root = repo_root();
    let mise = find_mise()?;
    let mise = mise.to_string_lossy().into_owned();

    // CAUTION: Set MISE_TRUSTED_CONFIG_PATHS on the child process only. A write
    // to the global trust store of mise changes the machine outside this
    // repository. `cargo xtask` already runs code from this repository, so trust
    // in the mise.toml of this repository adds no new trust boundary.
    let trusted = trusted_paths(&root)?;
    let trust = vec![(TRUST_VAR.to_string(), trusted.clone())];

    run_with_env(&mise, &["install"], &root, &trust)?;

    let output = Command::new(&mise)
        .args(["env", "--json"])
        .current_dir(&root)
        .env(TRUST_VAR, &trusted)
        .output()
        .map_err(|e| format!("failed to start `{mise}`: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`mise env --json` exited with {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }

    let doc: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let table = doc
        .as_object()
        .ok_or("`mise env --json` did not print a JSON object")?;
    let mut env: Vec<(String, String)> = Vec::with_capacity(table.len());
    for (key, value) in table {
        let Some(value) = value.as_str() else {
            continue;
        };
        env.push((key.clone(), value.to_string()));
    }

    #[cfg(target_os = "macos")]
    {
        let sdk = find_usable_sdk()?;
        eprintln!("xtask: using macOS SDK {}", sdk.display());
        let shim = ensure_shim(&sdk)?;
        let path = env
            .iter_mut()
            .find(|(key, _)| key == "PATH")
            .ok_or("`mise env --json` gave no PATH")?;

        // CAUTION: Put the shim directory at the front of PATH. The shim must
        // answer first. Otherwise Zig reads the newest SDK. The link then stops
        // with about twenty undefined libc symbols.
        //
        // mise puts its Zig directory near the front, and /usr/bin holds the
        // real `xcrun`. `join_paths` refuses a directory that holds a colon,
        // because such a directory cannot survive a PATH string.
        let mut dirs: Vec<PathBuf> = vec![shim];
        dirs.extend(std::env::split_paths(path.1.as_str()));
        path.1 = std::env::join_paths(&dirs)
            .map_err(|e| format!("cannot put the shim directory on PATH: {e}"))?
            .into_string()
            .map_err(|_| "PATH holds bytes that are not UTF-8")?;
    }

    Ok(env)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}
