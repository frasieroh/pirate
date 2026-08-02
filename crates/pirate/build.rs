//! The build information block, and the guard for the generated web assets.
//!
//! A `cargo build` must never need a JavaScript toolchain, so this script does
//! not run bun, npm, or Vite. It reads the pinned values that
//! `pirate --version --long` shows. Every value comes from a file or from git,
//! so a machine with no Node still builds.
//!
//! This script reads two classes of file, and it treats them differently. A file
//! that the repository commits is necessary, and a missing one stops the build.
//! A file that a build generates is optional, and a missing one gives a warning
//! and a degraded binary. The reason is that a clean checkout holds the
//! committed files only, and a plain `cargo build` must succeed there.

use std::path::Path;
use std::process::Command;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/pirate is two levels below the repository root");

    // `root` is two levels up from the manifest, which is the repository root
    // in this layout only. `cargo package` copies this crate on its own, and
    // the registry unpacks that copy under ~/.cargo/registry/src. The computed
    // root is then an unrelated directory, and a new web/dist under it is
    // litter outside the repository. This marker file is present in the
    // repository and absent in a packaged copy.
    let in_repository = root.join("crates/pirate/Cargo.toml").is_file();

    // rust-embed 8.12 with the `interpolate-folder-path` feature alone gives
    // two behaviors. A release build embeds the files of web/dist at compile
    // time. A debug build holds the absolute path and reads the files at run
    // time, so a later web build reaches a debug binary with no rebuild. Both
    // profiles need the folder to exist at compile time, because an absent
    // folder stops the compilation of assets.rs.
    let dist = root.join("web/dist");
    if !dist.join("index.html").is_file() {
        // The warning comes before the write. A write that fails stops this
        // script, and a reader needs the reason for the write first.
        println!(
            "cargo:warning=Run `cargo xtask web`, then build again. \
             web/dist holds no index.html. \
             A release binary embeds web/dist at compile time, so it holds no web assets. \
             A debug binary reads web/dist at run time, so a later web build gives it the assets. \
             pirate stops with `no embedded assets` while the folder stays empty."
        );
        if in_repository {
            if let Err(e) = std::fs::create_dir_all(&dist) {
                panic!(
                    "cannot create {}: {e}. \
                     Give the source tree write permission, then build again.",
                    dist.display()
                );
            }
        } else {
            println!(
                "cargo:warning={} is not the pirate repository. \
                 This script creates no folder outside the repository. \
                 The build continues with no web assets.",
                root.display()
            );
        }
    }
    // A `cargo:rerun-if-changed` line for a path that does not exist makes
    // Cargo run this script on every build. The path is absent in a packaged
    // copy only, where this script creates nothing.
    if dist.is_dir() {
        println!("cargo:rerun-if-changed={}", dist.display());
    }

    // The web build writes web/build-info.toml. It holds the two values that
    // only the JavaScript side knows.
    let web_info = read_generated(&root.join("web/build-info.toml"));
    let ghostty = read_committed(&root.join("toolchain/ghostty.toml"));
    let mise = read_committed(&root.join("mise.toml"));

    track_git(root);

    emit("PIRATE_GIT_SHA", &git_sha(root));
    emit(
        "PIRATE_ZIG_VERSION",
        &require(&mise, "tools", "zig", "mise.toml"),
    );
    emit(
        "PIRATE_GHOSTTY_COMMIT",
        &require(&ghostty, "", "commit", "toolchain/ghostty.toml"),
    );

    let source = "web/build-info.toml";
    let (web_version, wasm_sha256) = match &web_info {
        Some(text) => (
            or_unknown(text, "ghostty_web_version", source),
            or_unknown(text, "wasm_sha256", source),
        ),
        None => ("unknown".to_string(), "unknown".to_string()),
    };
    emit("PIRATE_GHOSTTY_WEB_VERSION", &web_version);
    emit("PIRATE_WASM_SHA256", &wasm_sha256);
}

fn emit(key: &str, value: &str) {
    println!("cargo:rustc-env={key}={value}");
}

/// Read a file that the repository commits.
///
/// The build stops when the file is absent, because a clean checkout always
/// holds it. A missing pin gives a binary that reports the wrong inputs.
fn read_committed(path: &Path) -> String {
    println!("cargo:rerun-if-changed={}", path.display());
    match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => panic!("cannot read {}: {e}", path.display()),
    }
}

/// Read a file that a build generates. An absent file gives a warning and
/// `None`.
///
/// The `cargo:rerun-if-changed` line is unconditional, and the rerun in the
/// degraded case is deliberate. The web build writes this file later. The line
/// makes Cargo run this script again then, so the real values reach the next
/// binary.
fn read_generated(path: &Path) -> Option<String> {
    println!("cargo:rerun-if-changed={}", path.display());
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(_) => {
            println!(
                "cargo:warning={} is absent. \
                 `pirate --version --long` will show `unknown` for two values. \
                 Run `cargo xtask web` to write the file.",
                path.display()
            );
            None
        }
    }
}

/// Read one `key = "value"` pair from a section of a small pin file. The
/// top-level section is `""`.
///
/// These files hold a few string keys and comments, so a full TOML parser is
/// not necessary. A parser also adds the first build-dependency of pirate, and
/// every dependency must stay pinned and justified. The section test makes the
/// hand-written form safe for mise.toml. A key `zig` under `[tools]` cannot
/// match a key of the same name under `[env]` or `[settings]`.
///
/// This function reads a plain string value only. The inline table form,
/// `zig = { version = "0.15.2" }`, gives `None`, and `require` then names the
/// necessary form.
fn value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut current = "";
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        // A header can carry a trailing comment, for example `[env] # note`.
        // The comment goes first. Without this step the header matches no
        // section, `current` keeps the previous name, and the keys of the new
        // table answer for the previous table. mise.toml puts `[env]` directly
        // under `[tools]`, so one trailing comment corrupts the `zig` lookup.
        if line.starts_with('[') {
            let head = line
                .split_once('#')
                .map_or(line, |(before, _)| before.trim());
            if let Some(name) = head.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                current = name.trim();
            }
            continue;
        }
        if current != section {
            continue;
        }
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('"') else {
            continue;
        };
        let Some(end) = rest.find('"') else { continue };
        return Some(rest[..end].to_string());
    }
    None
}

/// Read a key that a committed file must hold.
fn require(text: &str, section: &str, key: &str, source: &str) -> String {
    match value(text, section, key) {
        Some(found) => found,
        None => panic!(
            "{source} has no `{key}` as a plain string. \
             This parser does not read the inline table form. \
             Write `{key} = \"…\"`, then build again."
        ),
    }
}

/// Read a key from a generated file. A missing key gives a warning and
/// `unknown`, for the same reason that a missing file does.
fn or_unknown(text: &str, key: &str, source: &str) -> String {
    match value(text, "", key) {
        Some(found) => found,
        None => {
            println!("cargo:warning={source} has no `{key}`. The value becomes `unknown`.");
            "unknown".to_string()
        }
    }
}

/// The short commit of the working tree.
///
/// A source tarball has no `.git` directory, and a build machine can have no
/// git at all. Both cases give `unknown` and the build continues.
fn git_sha(root: &Path) -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(root)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let sha = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if sha.is_empty() {
                "unknown".to_string()
            } else {
                sha
            }
        }
        _ => "unknown".to_string(),
    }
}

/// Track the files that change when HEAD moves.
///
/// A `cargo:rerun-if-changed` line for a path that does not exist makes Cargo
/// run this script on every build. Therefore test each path first.
fn track_git(root: &Path) {
    let git = root.join(".git");
    if !git.is_dir() {
        return;
    }
    let head = git.join("HEAD");
    if !head.is_file() {
        return;
    }
    println!("cargo:rerun-if-changed={}", head.display());

    let Ok(text) = std::fs::read_to_string(&head) else {
        return;
    };
    let Some(name) = text.trim().strip_prefix("ref: ") else {
        return;
    };
    // A loose ref is one file. A packed ref lives in .git/packed-refs instead.
    let loose = git.join(name);
    if loose.is_file() {
        println!("cargo:rerun-if-changed={}", loose.display());
        return;
    }
    let packed = git.join("packed-refs");
    if packed.is_file() {
        println!("cargo:rerun-if-changed={}", packed.display());
    }
}
