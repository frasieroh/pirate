//! The wasm build of the vendored beamterm renderer.
//!
//! `vendor/beamterm` holds the Rust source of `@beamterm/renderer` at the commit
//! that `vendor/beamterm/UPSTREAM.toml` records. This module compiles that source
//! for `wasm32-unknown-unknown`, writes the JavaScript bindings with
//! `wasm-bindgen`, and writes one `package.json`. The result is a local npm
//! package at `vendor/beamterm/pkg`, and `web/package.json` resolves
//! `@beamterm/renderer` to that directory.
//!
//! pirate does not use wasm-pack. wasm-pack downloads `wasm-bindgen` and
//! `wasm-opt` at build time, and no file of this repository pins those two
//! downloads. mise pins both binaries instead, and `cargo xtask verify-pins`
//! compares the `wasm-bindgen` pin against `vendor/beamterm/Cargo.lock`. The
//! pass order matches wasm-pack: cargo, then wasm-bindgen, then wasm-opt.

use crate::{repo_root, run_with_env, Result};
use std::path::{Path, PathBuf};

/// The vendored source tree, relative to the repository root.
pub const VENDOR_DIR: &str = "vendor/beamterm";

/// The crate that holds the JavaScript interface.
const CRATE: &str = "beamterm-renderer";

/// The feature that turns on the JavaScript interface. `js/build.js` of the
/// upstream repository passes the same feature.
const FEATURE: &str = "js-api";

/// The compile target of the wasm module.
const RUST_TARGET: &str = "wasm32-unknown-unknown";

/// The two wasm-bindgen targets that the local package carries.
///
/// `bundler` serves the bare specifier `@beamterm/renderer`. `web` serves
/// `@beamterm/renderer/web`, and the TypeScript of `web/src` imports that
/// subpath for its default `init` export. The upstream npm package carries the
/// same two subpaths. pirate builds no `nodejs` target and no CDN bundle.
const BINDGEN_TARGETS: &[&str] = &["bundler", "web"];

/// The name that wasm-bindgen gives to every generated file.
const OUT_NAME: &str = "beamterm_renderer";

/// The optimizer pass of wasm-opt.
///
/// wasm-pack runs `wasm-opt -O` on a release build. Without the pass the module
/// grows by about 13 percent, and the paint budget of `web/bench` fails.
const OPT_LEVEL: &str = "-O";

/// The generated package directory, relative to `VENDOR_DIR`.
pub const PKG_DIR: &str = "pkg";

/// The absolute path of the vendored source tree.
pub fn vendor_root() -> PathBuf {
    repo_root().join(VENDOR_DIR)
}

/// The absolute path of the generated npm package.
pub fn pkg_root() -> PathBuf {
    vendor_root().join(PKG_DIR)
}

/// Compile the vendored renderer and write the local npm package.
///
/// CAUTION: Run this command with the build environment of mise. mise puts the
/// pinned `wasm-bindgen` and the pinned `wasm-opt` on PATH. A `wasm-bindgen`
/// from the machine writes bindings that do not match the wasm module.
pub fn build(env: &[(String, String)]) -> Result<()> {
    let vendor = vendor_root();
    if !vendor.join("Cargo.toml").is_file() {
        return Err(format!("no Cargo.toml in {}", vendor.display()).into());
    }

    // `--locked` holds vendor/beamterm/Cargo.lock. Without it cargo resolves the
    // dependencies again, and the wasm-bindgen crate can then leave the version
    // that mise.toml pins for the command-line tool.
    run_with_env(
        "cargo",
        &[
            "build",
            "--locked",
            "--release",
            "--target",
            RUST_TARGET,
            "--package",
            CRATE,
            "--features",
            FEATURE,
        ],
        &vendor,
        env,
    )?;

    let wasm = vendor
        .join("target")
        .join(RUST_TARGET)
        .join("release")
        .join(format!("{}.wasm", CRATE.replace('-', "_")));
    if !wasm.is_file() {
        return Err(format!("the cargo build wrote no {}", wasm.display()).into());
    }

    let pkg = pkg_root();
    // Delete the package first. wasm-bindgen writes over a file of the same
    // name and leaves a file of an older run in place.
    if pkg.exists() {
        std::fs::remove_dir_all(&pkg)?;
    }

    for target in BINDGEN_TARGETS {
        let out_dir = pkg.join("dist").join(target);
        run_with_env(
            "wasm-bindgen",
            &[
                "--target",
                target,
                "--out-dir",
                &out_dir.to_string_lossy(),
                "--out-name",
                OUT_NAME,
                "--typescript",
                &wasm.to_string_lossy(),
            ],
            &vendor,
            env,
        )?;
        for suffix in ["js", "d.ts"] {
            let file = out_dir.join(format!("{OUT_NAME}.{suffix}"));
            if !file.is_file() {
                return Err(format!("wasm-bindgen wrote no {}", file.display()).into());
            }
        }

        // wasm-opt writes no file in place, so the output goes to a new name and
        // then replaces the input.
        let module = out_dir.join(format!("{OUT_NAME}_bg.wasm"));
        let optimized = out_dir.join(format!("{OUT_NAME}_bg.opt.wasm"));
        run_with_env(
            "wasm-opt",
            &[
                OPT_LEVEL,
                &module.to_string_lossy(),
                "--output",
                &optimized.to_string_lossy(),
            ],
            &vendor,
            env,
        )?;
        std::fs::rename(&optimized, &module)?;
    }

    write_package_json(&pkg, &read_version(&vendor)?)?;
    std::fs::copy(vendor.join("LICENSE"), pkg.join("LICENSE"))?;

    eprintln!("xtask: {} is complete", pkg.display());
    Ok(())
}

/// The version of the vendored crates, from the workspace manifest.
fn read_version(vendor: &Path) -> Result<String> {
    let path = vendor.join("Cargo.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
    doc.get("workspace")
        .and_then(|w| w.get("package"))
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "no `version` under [workspace.package] in {}",
                path.display()
            )
            .into()
        })
}

/// Write the manifest of the local npm package.
///
/// The two export subpaths hold the names that the npm package 1.0.0 holds, so
/// the TypeScript of `web/src` needs no change. The package carries no `cdn`
/// subpath, because pirate builds no CDN bundle.
fn write_package_json(pkg: &Path, version: &str) -> Result<()> {
    let manifest = serde_json::json!({
        "name": "@beamterm/renderer",
        "version": version,
        "description": "WebGL2 terminal renderer, built from vendor/beamterm",
        "license": "MIT",
        "private": true,
        "main": "./dist/bundler/beamterm_renderer.js",
        "types": "./dist/bundler/beamterm_renderer.d.ts",
        "exports": {
            ".": {
                "types": "./dist/bundler/beamterm_renderer.d.ts",
                "import": "./dist/bundler/beamterm_renderer.js",
                "require": "./dist/bundler/beamterm_renderer.js",
                "default": "./dist/bundler/beamterm_renderer.js"
            },
            "./web": {
                "types": "./dist/web/beamterm_renderer.d.ts",
                "default": "./dist/web/beamterm_renderer.js"
            }
        },
        "files": ["dist/", "LICENSE"],
    });
    std::fs::write(
        pkg.join("package.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    Ok(())
}
