//! Build orchestration for pirate.
//!
//! The build spans three toolchains: Zig builds libghostty-vt, Rust builds the
//! server, and Vite builds the web client. xtask owns the order and the
//! environment so that no other command needs to know about them.
//!
//! The web build owns its own output. Two Vite plugins compress web/dist and
//! write web/build-info.toml, so xtask starts that build and then reads the
//! result.

mod dist;
mod pins;
mod toolchain;

use std::path::{Path, PathBuf};
use std::process::Command;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const HELP: &str = "\
cargo xtask <command>

Commands:
  web                    Build the web assets. The web build compresses them.
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
        "web" => cmd_web_alone(),
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

/// The outputs of the web build that the Rust build reads.
///
/// The two Vite plugins write them. `cargo build` embeds web/dist, and the
/// `build.rs` script of pirate reads web/build-info.toml.
const WEB_OUTPUTS: &[&str] = &["dist/index.html", "build-info.toml"];

/// The `web` command on its own. It builds the same environment that a full
/// build gives, because `bun` must come from mise here too.
fn cmd_web_alone() -> Result<()> {
    let env = toolchain::build_env()?;
    cmd_web(&env)
}

/// The web build. Vite writes web/dist, compresses every large asset into a gzip
/// and a brotli copy, and writes web/build-info.toml. The Rust build embeds all
/// three forms of each asset.
///
/// CAUTION: Run `bun` with the build environment of mise. mise pins the bun
/// version and puts that bun on PATH. A bun from the machine ignores the pin,
/// and two machines then build different web assets.
pub fn cmd_web(env: &[(String, String)]) -> Result<()> {
    let web = repo_root().join("web");
    if !web.join("package.json").is_file() {
        return Err(format!("no package.json in {}", web.display()).into());
    }

    run_with_env("bun", &["install", "--frozen-lockfile"], &web, env)
        .or_else(|_| run_with_env("bun", &["install"], &web, env))?;
    run_with_env("bun", &["run", "build"], &web, env)?;

    // A missing output means that a Vite plugin stopped without an error. Fail
    // here, because the Rust build gives a worse message for the same fault.
    for output in WEB_OUTPUTS {
        let path = web.join(output);
        if !path.is_file() {
            return Err(format!("`bun run build` wrote no {}", path.display()).into());
        }
    }
    eprintln!("xtask: web assets are complete");
    Ok(())
}

/// The web build, then the Rust build.
fn cmd_build(args: &[String]) -> Result<()> {
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

    // One call for both builds. The web build needs the bun of mise, and
    // the Rust build needs the Zig and the rustup toolchain of mise.
    let env = toolchain::build_env()?;
    cmd_web(&env)?;
    build_target(target, release, &env)
}

/// The Rust build for one target. `dist` calls this once for each target, so it
/// takes the build environment as an argument and does not rebuild the web
/// assets.
pub fn build_target(target: Option<&str>, release: bool, env: &[(String, String)]) -> Result<()> {
    // cargo-zigbuild is needed for Linux targets only. The Apple targets link
    // with the system linker and build with plain cargo.
    let linux = target.is_some_and(|t| t.contains("linux"));
    let mut argv: Vec<&str> = vec![if linux { "zigbuild" } else { "build" }];

    // CAUTION: Keep `--locked` on both forms. Cargo.lock is a pin. Without this
    // flag cargo writes the file again from the manifests, and the release then
    // holds a dependency set that nobody committed. cargo-zigbuild passes the
    // flag through to cargo.
    argv.push("--locked");

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
    // Cargo.lock records the version of each workspace member. CI runs
    // `cargo fetch --locked`, which fails when the lock file still holds the
    // old version.
    run_with_env(
        "cargo",
        &["update", "--workspace", "--offline"],
        &repo_root(),
        &[],
    )?;
    eprintln!("xtask: version set to {version}");
    Ok(())
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
