//! Build orchestration for pirate.
//!
//! The build spans three toolchains: Zig builds libghostty-vt, Rust builds the
//! server, and Vite builds the web client. xtask owns the order and the
//! environment so that no other command needs to know about them.

mod buildinfo;
mod compress;
mod dist;
mod pins;
mod toolchain;

use std::path::{Path, PathBuf};
use std::process::Command;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const HELP: &str = "\
cargo xtask <command>

Commands:
  setup                  Download the pinned Zig and write the macOS SDK shim.
  web                    Build the web assets into web/dist and compress them.
  build [--release]      Build the web assets, then the binary.
        [--target T]     Cross-compile. Linux targets use cargo-zigbuild.
  dist [--target T]...   Build each target, then write a tarball for each one
                         and one SHA256SUMS file. Default: all six targets.
  verify-pins            Fail if any dependency uses a version range.
  version <x.y.z>        Write one version to every manifest.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");

    let result = match cmd {
        "setup" => cmd_setup(),
        "web" => cmd_web(),
        "build" => cmd_build(&args[1..]),
        "dist" => dist::run(&args[1..]),
        "verify-pins" => pins::verify(),
        "version" => match args.get(1) {
            Some(v) => cmd_version(v),
            None => Err("usage: cargo xtask version <x.y.z>".into()),
        },
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            return;
        }
        other => Err(format!("unknown command `{other}`\n\n{HELP}").into()),
    };

    if let Err(e) = result {
        eprintln!("\nerror: {e}");
        std::process::exit(1);
    }
}

/// The repository root, resolved from this crate's location at compile time.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/xtask is two levels below the repository root")
        .to_path_buf()
}

fn cmd_setup() -> Result<()> {
    let env = toolchain::build_env()?;
    for (k, v) in &env {
        if k == "PATH" {
            continue;
        }
        eprintln!("xtask: {k}={v}");
    }
    eprintln!("xtask: setup complete");
    Ok(())
}

/// Stage 1. Vite builds web/dist, then every compressible file gets a gzip and a
/// brotli copy beside it. The Rust build embeds all three forms.
pub fn cmd_web() -> Result<()> {
    let web = repo_root().join("web");
    if !web.join("package.json").is_file() {
        return Err(format!("no package.json in {}", web.display()).into());
    }

    run("bun", &["install", "--frozen-lockfile"], &web)
        .or_else(|_| run("bun", &["install"], &web))?;
    run("bun", &["run", "build"], &web)?;

    let dist = web.join("dist");
    if !dist.is_dir() {
        return Err(format!("bun run build did not create {}", dist.display()).into());
    }
    let saved = compress::compress_tree(&dist)?;
    eprintln!("xtask: compressed {saved} files in web/dist");

    // The ghostty-web version and the wasm checksum come from node_modules.
    // Only stage 1 can read them, because build.rs must not run bun.
    buildinfo::write(&web)?;
    Ok(())
}

/// Stage 1, then stages 2 and 3.
fn cmd_build(args: &[String]) -> Result<()> {
    cmd_web()?;

    let mut target: Option<&str> = None;
    let mut release = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--release" => release = true,
            "--target" => {
                target = Some(args.get(i + 1).ok_or("--target needs a value")?);
                i += 1;
            }
            other => return Err(format!("unknown build argument `{other}`").into()),
        }
        i += 1;
    }

    let env = toolchain::build_env()?;
    build_target(target, release, &env)
}

/// Stages 2 and 3 for one target. `dist` calls this once for each target, so it
/// takes the build environment as an argument and does not rebuild the web
/// assets.
pub fn build_target(target: Option<&str>, release: bool, env: &[(String, String)]) -> Result<()> {
    // cargo-zigbuild is needed for Linux targets only. The Apple targets link
    // with the system linker and build with plain cargo.
    let linux = target.is_some_and(|t| t.contains("linux"));
    let mut argv: Vec<&str> = vec![if linux { "zigbuild" } else { "build" }];
    if release {
        argv.push("--release");
    }
    argv.push("--package");
    argv.push("pirate");
    if let Some(t) = target {
        argv.push("--target");
        argv.push(t);
    }

    run_with_env("cargo", &argv, &repo_root(), env)
}

fn cmd_version(version: &str) -> Result<()> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.parse::<u32>().is_err()) {
        return Err(format!("`{version}` is not x.y.z").into());
    }
    pins::write_version(version)?;
    eprintln!("xtask: version set to {version}");
    Ok(())
}

pub fn run(program: &str, args: &[&str], cwd: &Path) -> Result<()> {
    run_with_env(program, args, cwd, &[])
}

pub fn run_with_env(
    program: &str,
    args: &[&str],
    cwd: &Path,
    env: &[(String, String)],
) -> Result<()> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }

    eprintln!("xtask: {program} {}", args.join(" "));
    let status = cmd
        .status()
        .map_err(|e| format!("failed to start `{program}`: {e}"))?;
    if !status.success() {
        return Err(format!("`{program}` exited with {status}").into());
    }
    Ok(())
}
