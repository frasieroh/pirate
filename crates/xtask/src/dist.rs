//! Release packaging.
//!
//! `dist` builds each target, then writes one tarball for each target and one
//! `SHA256SUMS` file for all of them. The release workflow uploads exactly these
//! files, so a local `cargo xtask dist` gives the same result as a tag push.
//!
//! This module shells out to `tar` and reuses the `sha2` dependency of the
//! toolchain module. xtask must compile before any other command can run, so its
//! build time is a floor on every command. Do not add a crate here for work that
//! a system program already does.

use crate::{build_target, cmd_web, pins, repo_root, run_with_env, toolchain, Result};
use std::path::{Path, PathBuf};

/// The six targets of the release. The `.2.28` suffix is the glibc floor.
/// cargo-zigbuild reads that suffix. Cargo writes the artifact into the
/// directory of the plain triple.
const DEFAULT_TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu.2.28",
    "aarch64-unknown-linux-gnu.2.28",
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
];

/// Files that ship beside the binary, when the repository has them.
const EXTRA_FILES: &[&str] = &["LICENSE", "README.md", "THIRD-PARTY-LICENSES.md"];

pub fn run(args: &[String]) -> Result<()> {
    let targets = parse_targets(args)?;

    let root = repo_root();
    let version = pins::read_version()?;
    let out = root.join("dist");

    // CAUTION: This command removes dist/ before it writes. Move any file that
    // you want to keep out of dist/ first.
    if out.exists() {
        std::fs::remove_dir_all(&out)?;
    }
    std::fs::create_dir_all(&out)?;

    // Stage 1 runs once. Every target embeds the same web assets.
    cmd_web()?;

    let mut env = toolchain::build_env()?;
    // ReleaseFast is for release builds only. Local work and tests use the
    // default, because the Zig compile is the slowest step of the build.
    env.push((
        "LIBGHOSTTY_VT_SYS_OPTIMIZE".to_string(),
        "ReleaseFast".to_string(),
    ));

    let mut sums = String::new();
    for target in &targets {
        build_target(Some(target), true, &env)?;
        let archive = package(&root, &out, &version, target)?;
        let name = file_name(&archive)?;
        let sum = toolchain::sha256_file(&archive)?;
        eprintln!("xtask: {sum}  {name}");
        // The `<hex>  <name>` form of GNU coreutils. `sha256sum -c SHA256SUMS`
        // reads it, and so does `shasum -a 256 -c SHA256SUMS` on macOS.
        sums.push_str(&format!("{sum}  {name}\n"));
    }

    let checksums = out.join("SHA256SUMS");
    std::fs::write(&checksums, &sums)?;
    eprintln!(
        "xtask: wrote {} archive(s) and SHA256SUMS to {}",
        targets.len(),
        out.display()
    );
    Ok(())
}

fn parse_targets(args: &[String]) -> Result<Vec<String>> {
    let mut targets: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--target" => {
                let value = args.get(i + 1).ok_or("--target needs a value")?;
                targets.push(value.clone());
                i += 1;
            }
            other => return Err(format!("unknown dist argument `{other}`").into()),
        }
        i += 1;
    }
    if targets.is_empty() {
        targets = DEFAULT_TARGETS.iter().map(|t| t.to_string()).collect();
    }
    Ok(targets)
}

/// The directory that Cargo writes for a build target.
///
/// cargo-zigbuild accepts a glibc floor as a suffix, for example
/// `x86_64-unknown-linux-gnu.2.28`. Cargo knows the plain triple only, so remove
/// the suffix. No Rust target triple contains a period.
fn artifact_triple(target: &str) -> &str {
    match target.find('.') {
        Some(i) => &target[..i],
        None => target,
    }
}

/// Copy the binary and the license files into a staging directory, then write
/// one tarball. Returns the path of the tarball.
fn package(root: &Path, out: &Path, version: &str, target: &str) -> Result<PathBuf> {
    let triple = artifact_triple(target);
    let binary = root
        .join("target")
        .join(triple)
        .join("release")
        .join("pirate");
    if !binary.is_file() {
        return Err(format!("no binary at {}", binary.display()).into());
    }

    let stem = format!("pirate-{version}-{triple}");
    let stage = out.join(&stem);
    std::fs::create_dir_all(&stage)?;
    // std::fs::copy keeps the Unix permission bits, so the binary stays
    // executable inside the tarball.
    std::fs::copy(&binary, stage.join("pirate"))?;
    for extra in EXTRA_FILES {
        let src = root.join(extra);
        if src.is_file() {
            std::fs::copy(&src, stage.join(extra))?;
        }
    }

    let archive = out.join(format!("{stem}.tar.gz"));
    let archive_arg = archive.to_string_lossy().into_owned();
    let out_arg = out.to_string_lossy().into_owned();
    // COPYFILE_DISABLE stops bsdtar on macOS from adding an AppleDouble member
    // for each file that has an extended attribute.
    run_with_env(
        "tar",
        &["-czf", &archive_arg, "-C", &out_arg, &stem],
        out,
        &[("COPYFILE_DISABLE".to_string(), "1".to_string())],
    )?;

    std::fs::remove_dir_all(&stage)?;
    Ok(archive)
}

fn file_name(path: &Path) -> Result<String> {
    Ok(path
        .file_name()
        .ok_or("archive path has no file name")?
        .to_string_lossy()
        .into_owned())
}
