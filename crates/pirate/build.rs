//! Stage 3 guard, and the build information block.
//!
//! A `cargo build` must never need a JavaScript toolchain, so this script does
//! not run bun, npm, or Vite. It makes sure that stage 1 already ran, then it
//! reads the pinned values that `pirate --version --long` shows. Every value
//! comes from a file or from git, so a machine with no Node still builds.

use std::path::Path;
use std::process::Command;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/pirate is two levels below the repository root");

    let dist = root.join("web/dist");
    println!("cargo:rerun-if-changed={}", dist.display());

    if !dist.join("index.html").is_file() {
        println!("cargo:warning=web/dist not found. Run `cargo xtask web` first.");
        panic!(
            "web/dist not found at {}. Run `cargo xtask web` first.",
            dist.display()
        );
    }

    // `cargo xtask web` writes web/build-info.toml. It holds the two values
    // that only the JavaScript side knows.
    let web_info = read_pin_file(&root.join("web/build-info.toml"));
    let ghostty = read_pin_file(&root.join("toolchain/ghostty.toml"));
    let zig = read_pin_file(&root.join(".zigversion"));

    track_git(root);

    emit("PIRATE_GIT_SHA", &git_sha(root));
    emit("PIRATE_ZIG_VERSION", zig.trim());
    emit(
        "PIRATE_GHOSTTY_COMMIT",
        &value(&ghostty, "commit", "toolchain/ghostty.toml"),
    );
    emit(
        "PIRATE_GHOSTTY_WEB_VERSION",
        &value(&web_info, "ghostty_web_version", "web/build-info.toml"),
    );
    emit(
        "PIRATE_WASM_SHA256",
        &value(&web_info, "wasm_sha256", "web/build-info.toml"),
    );
}

fn emit(key: &str, value: &str) {
    println!("cargo:rustc-env={key}={value}");
}

/// Read a pin file and track it. The build stops when the file is absent,
/// because a missing pin gives a binary that reports the wrong inputs.
fn read_pin_file(path: &Path) -> String {
    println!("cargo:rerun-if-changed={}", path.display());
    match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) => panic!(
            "cannot read {}: {e}. Run `cargo xtask web` first.",
            path.display()
        ),
    }
}

/// Read one `key = "value"` pair from a small pin file.
///
/// These files hold a few string keys and comments, so a full TOML parser is
/// not necessary here. A parser would also add the first build-dependency of
/// pirate, and every dependency must stay pinned and justified.
fn value(text: &str, key: &str, source: &str) -> String {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
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
        return rest[..end].to_string();
    }
    panic!("{source} has no `{key}`");
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
