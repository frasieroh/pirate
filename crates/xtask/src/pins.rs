//! Pin discipline.
//!
//! Every input is pinned in exactly one place, and every dependency is exact.
//! Cargo treats a bare `"1.2.3"` as `^1.2.3`, so this module requires the
//! explicit `=` prefix. npm treats a bare `"1.2.3"` as exact, so this module
//! rejects any prefix character there. The build tools live in mise.toml, and
//! this module compares that file against mise.lock.

use crate::{repo_root, Result};
use std::path::{Path, PathBuf};

/// The four platforms of the release, in the naming that mise.lock uses. An
/// extra key such as `linux-x64-musl` is allowed and stays unchecked.
const LOCK_PLATFORMS: &[&str] = &["linux-x64", "linux-arm64", "macos-arm64", "macos-x64"];

/// The command that writes mise.lock for all four release platforms.
const LOCK_FIX: &str = "mise lock --platform linux-x64,linux-arm64,macos-arm64,macos-x64";

/// The tools whose mise.lock entry carries no per-platform checksum.
///
/// mise drives rustup for the `core:rust` backend, and rustup verifies the
/// signature of every file it downloads. mise therefore records
/// `[tools.rust.options]` and no checksum. A missing checksum for this tool is
/// correct, not a fault.
///
/// CAUTION: Read this exemption from the tool name in mise.toml. A read of the
/// backend in mise.lock lets that file grant itself the exemption, and a forged
/// `backend = "core:rust"` line then drops the checksum rule for any tool.
const NO_CHECKSUM_TOOLS: &[&str] = &["rust", "core:rust"];

/// The variable that keeps the Zig cache inside the repository.
const ZIG_CACHE_VAR: &str = "ZIG_GLOBAL_CACHE_DIR";

/// The compile target of the vendored beamterm renderer. `cargo xtask wasm`
/// needs it, and mise installs the rustup targets.
const WASM_TARGET: &str = "wasm32-unknown-unknown";

/// The mise tool that writes the JavaScript bindings of the wasm module.
const BINDGEN_TOOL: &str = "github:rustwasm/wasm-bindgen";

/// The npm package name of the vendored renderer.
const BEAMTERM_PACKAGE: &str = "@beamterm/renderer";

/// The prefix of an npm dependency that names a directory instead of a version.
const LOCAL_PREFIX: &str = "file:";

pub fn verify() -> Result<()> {
    let mut errors: Vec<String> = Vec::new();

    // mise.toml holds every tool version, and mise.lock holds every checksum.
    check_mise(&mut errors);
    if errors.is_empty() {
        eprintln!("xtask: mise tools are exact and locked");
    }

    // toolchain/ghostty.toml against the crate source, when that source is here.
    match check_ghostty_pin() {
        Ok(commit) => eprintln!("xtask: ghostty pinned at {commit}"),
        Err(e) => errors.push(e.to_string()),
    }

    // vendor/beamterm/UPSTREAM.toml against the vendored lock file, mise.toml,
    // and web/package.json.
    match check_beamterm_pin() {
        Ok(commit) => eprintln!("xtask: beamterm pinned at {commit}"),
        Err(e) => errors.push(e.to_string()),
    }

    let root = repo_root();
    let mut manifests = vec![root.join("Cargo.toml")];
    for entry in std::fs::read_dir(root.join("crates"))? {
        let path = entry?.path().join("Cargo.toml");
        if path.is_file() {
            manifests.push(path);
        }
    }
    for manifest in &manifests {
        check_cargo_manifest(manifest, &mut errors)?;
    }

    let package_json = root.join("web/package.json");
    if package_json.is_file() {
        check_package_json(&package_json, &mut errors)?;
    }

    // The wasm module of vendor/beamterm against the graph that cargo-deny and
    // cargo-about read.
    check_lock_containment(
        &std::fs::read_to_string(root.join("Cargo.lock"))?,
        &std::fs::read_to_string(root.join(crate::wasm::VENDOR_DIR).join("Cargo.lock"))?,
        &mut errors,
    );

    if errors.is_empty() {
        eprintln!("xtask: all pins are exact");
        return Ok(());
    }
    let count = errors.len();
    for e in errors {
        eprintln!("  {e}");
    }
    Err(format!("{count} pin error(s)").into())
}

/// The exact-version rule for mise.toml.
///
/// A version is exact when it holds three or more parts, and when every part
/// holds digits only. That rule rejects "latest" and "lts", and it rejects every
/// range character: `^`, `~`, `>`, `<` and `*`. It also rejects "1.2", because
/// mise reads a two-part version as a prefix and resolves it to the newest
/// release under that prefix.
fn is_exact_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() >= 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// mise.toml against mise.lock.
///
/// Every tool needs an exact version, and every tool needs a checksum for each
/// of the four release platforms. Together the two rules give an install on
/// Linux and an install on macOS the same bytes.
fn check_mise(errors: &mut Vec<String>) {
    let root = repo_root();
    let path = root.join("mise.toml");

    // An unreadable mise.toml is one error among many. A `?` here stops the
    // ghostty check, the Cargo manifests and package.json as well.
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) => {
            errors.push(format!("{}: {e}", path.display()));
            return;
        }
    };
    let config: toml::Value = match toml::from_str(&text) {
        Ok(config) => config,
        Err(e) => {
            errors.push(format!("{}: {e}", path.display()));
            return;
        }
    };

    check_zig_cache_var(&config, errors);
    check_rust_targets(&config, errors);

    let Some(tools) = config.get("tools").and_then(|t| t.as_table()) else {
        errors.push("mise.toml has no [tools] table".to_string());
        return;
    };

    let lock_path = root.join("mise.lock");
    let lock: Option<toml::Value> = match std::fs::read_to_string(&lock_path) {
        Ok(text) => match toml::from_str(&text) {
            Ok(lock) => Some(lock),
            Err(e) => {
                errors.push(format!("{}: {e}", lock_path.display()));
                None
            }
        },
        Err(_) => {
            errors.push(format!(
                "mise.lock is absent. Without it mise takes the bytes that the \
                 remote serves today. Write the file with `{LOCK_FIX}`."
            ));
            None
        }
    };

    for (tool, spec) in tools {
        // A tool is a bare version string, or a table that holds `version`.
        let version = match spec {
            toml::Value::String(s) => Some(s.as_str()),
            toml::Value::Table(t) => t.get("version").and_then(|v| v.as_str()),
            _ => None,
        };
        let Some(version) = version else {
            errors.push(format!("mise.toml: `{tool}` has no version"));
            continue;
        };
        if !is_exact_version(version) {
            errors.push(format!(
                "mise.toml: `{tool} = \"{version}\"` is not an exact version. \
                 Write three or more parts of digits, for example \"1.2.3\". \
                 mise reads a shorter version as a prefix and resolves it."
            ));
        }
        if let Some(lock) = &lock {
            check_lock_entry(lock, tool, version, errors);
        }
    }
}

/// The [env] table of mise.toml against the one variable that the build needs.
///
/// CAUTION: Keep ZIG_GLOBAL_CACHE_DIR in the [env] table. Zig writes about
/// 868 MB of cache to ~/.cache/zig without it. The cache key of CI then stops
/// matching, and no other check finds the deletion.
fn check_zig_cache_var(config: &toml::Value, errors: &mut Vec<String>) {
    let present = config
        .get("env")
        .and_then(|e| e.as_table())
        .is_some_and(|table| table.contains_key(ZIG_CACHE_VAR));
    if !present {
        errors.push(format!(
            "mise.toml: [env] holds no `{ZIG_CACHE_VAR}`. Zig then writes its \
             cache to ~/.cache/zig, and the cache key of CI stops matching. \
             Write `{ZIG_CACHE_VAR} = \"{{{{config_root}}}}/.toolchain/zig-cache\"`."
        ));
    }
}

/// True when a comma-separated rustup target list holds one target.
///
/// The comparison is exact per element. A substring test lets
/// `wasm32-unknown-unknown-foo` satisfy `wasm32-unknown-unknown`.
fn has_target(targets: &str, wanted: &str) -> bool {
    targets.split(',').any(|t| t.trim() == wanted)
}

/// The rustup target list of mise.toml against the wasm target.
///
/// `cargo xtask wasm` builds vendor/beamterm for wasm32-unknown-unknown. Without
/// the target in this list, mise installs no wasm standard library, and the
/// build stops with a message about a missing target.
fn check_rust_targets(config: &toml::Value, errors: &mut Vec<String>) {
    let targets = config
        .get("tools")
        .and_then(|t| t.get("rust"))
        .and_then(|r| r.get("targets"))
        .and_then(|t| t.as_str());
    let Some(targets) = targets else {
        errors.push("mise.toml: `rust` has no `targets`".to_string());
        return;
    };
    if !has_target(targets, WASM_TARGET) {
        errors.push(format!(
            "mise.toml: the `targets` of `rust` hold no `{WASM_TARGET}`. \
             `cargo xtask wasm` builds vendor/beamterm for that target. \
             Add it to the list."
        ));
    }
}

/// One tool in mise.lock, at the version that mise.toml asks for.
///
/// The version match is the point of this function. Renovate can raise a version
/// in mise.toml, and Renovate cannot write mise.lock. A lock that still holds the
/// old version passes a bare presence check, and then the build installs bytes
/// that nobody locked.
fn check_lock_entry(lock: &toml::Value, tool: &str, version: &str, errors: &mut Vec<String>) {
    // mise writes `[[tools.<name>]]`, an array of tables, one table for each
    // locked version. The platform tables attach to one of those tables.
    let entries: Vec<&toml::Value> = match lock.get("tools").and_then(|t| t.get(tool)) {
        Some(toml::Value::Array(array)) => array.iter().collect(),
        Some(other) => vec![other],
        None => Vec::new(),
    };
    if entries.is_empty() {
        errors.push(format!(
            "mise.lock has no entry for `{tool}`. Write the file with `{LOCK_FIX}`."
        ));
        return;
    }

    let locked: Vec<&str> = entries
        .iter()
        .filter_map(|e| e.get("version").and_then(|v| v.as_str()))
        .collect();
    let entry = entries
        .iter()
        .copied()
        .find(|e| e.get("version").and_then(|v| v.as_str()) == Some(version));
    let Some(entry) = entry else {
        let held = if locked.is_empty() {
            "no version".to_string()
        } else {
            locked.join(", ")
        };
        errors.push(format!(
            "mise.lock: `{tool}` holds {held}, and mise.toml asks for {version}. \
             Write mise.lock again with `{LOCK_FIX}`."
        ));
        return;
    };

    // The one documented exception, and it covers the checksum only. See
    // NO_CHECKSUM_TOOLS for the reason and for the name rule. The version above
    // still needs a match.
    if NO_CHECKSUM_TOOLS.contains(&tool) {
        return;
    }

    for platform in LOCK_PLATFORMS {
        let key = format!("platforms.{platform}");
        let checksum = entry
            .get(key.as_str())
            .and_then(|p| p.get("checksum"))
            .and_then(|c| c.as_str());
        if checksum.is_none_or(str::is_empty) {
            errors.push(format!(
                "mise.lock: `{tool}` has no checksum for {platform}. \
                 Write the file with `{LOCK_FIX}`."
            ));
        }
    }
}

/// The Ghostty commit that libghostty-vt-sys builds.
///
/// That crate declares `links = "ghostty-vt"`, but its build script emits
/// `cargo:include` only. Cargo therefore gives a dependent no way to read the
/// commit, and the value stays a private constant in that build script. pirate
/// records it in toolchain/ghostty.toml. When the crate source is in the cargo
/// registry cache, compare the two values and fail on a difference.
fn check_ghostty_pin() -> Result<String> {
    let path = repo_root().join("toolchain/ghostty.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;

    let commit = doc
        .get("commit")
        .and_then(|v| v.as_str())
        .ok_or("toolchain/ghostty.toml has no `commit`")?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(
            format!("`{commit}` in toolchain/ghostty.toml is not a full git commit").into(),
        );
    }
    let version = doc
        .get("libghostty_vt_sys")
        .and_then(|v| v.as_str())
        .ok_or("toolchain/ghostty.toml has no `libghostty_vt_sys`")?;

    match crate_commit(version)? {
        Some(found) if found != commit => Err(format!(
            "toolchain/ghostty.toml says {commit}, and libghostty-vt-sys {version} \
             builds {found}. Correct toolchain/ghostty.toml."
        )
        .into()),
        Some(_) => Ok(commit.to_string()),
        // CAUTION: Fail on an absent source. A note left this pin unchecked in
        // every CI job that holds no registry cache. CI exports
        // GHOSTTY_SOURCE_DIR from this same file, and the build script of
        // libghostty-vt-sys accepts any tree that holds build.zig. A drifted
        // commit therefore compiles a different Ghostty and stays green.
        None => Err(format!(
            "libghostty-vt-sys {version} is not in the cargo registry cache, so \
             the Ghostty commit of toolchain/ghostty.toml stays unchecked. Unpack \
             the source with `cargo fetch --locked`. Then run this command again."
        )
        .into()),
    }
}

/// Read GHOSTTY_COMMIT from the build script of libghostty-vt-sys in the cargo
/// registry cache. The result is None when that source is absent.
fn crate_commit(version: &str) -> Result<Option<String>> {
    let home = match std::env::var("CARGO_HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => PathBuf::from(std::env::var("HOME")?).join(".cargo"),
    };
    let Ok(entries) = std::fs::read_dir(home.join("registry/src")) else {
        return Ok(None);
    };
    for entry in entries.flatten() {
        let build_rs = entry
            .path()
            .join(format!("libghostty-vt-sys-{version}/build.rs"));
        let Ok(text) = std::fs::read_to_string(&build_rs) else {
            continue;
        };
        for line in text.lines() {
            let Some((_, rest)) = line.split_once("GHOSTTY_COMMIT") else {
                continue;
            };
            let Some(open) = rest.find('"') else { continue };
            let rest = &rest[open + 1..];
            let Some(close) = rest.find('"') else {
                continue;
            };
            return Ok(Some(rest[..close].to_string()));
        }
    }
    Ok(None)
}

/// The version of one package in a Cargo.lock.
///
/// The file holds one `[[package]]` table for each package. The function reads
/// the first table whose `name` matches.
fn lock_version(lock: &str, name: &str) -> Option<String> {
    let doc: toml::Value = toml::from_str(lock).ok()?;
    let packages = doc.get("package")?.as_array()?;
    packages
        .iter()
        .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Every package of a Cargo.lock, as name and version.
fn lock_packages(lock: &str) -> Result<Vec<(String, String)>> {
    let doc: toml::Value = toml::from_str(lock)?;
    let Some(packages) = doc.get("package").and_then(|p| p.as_array()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(packages.len());
    for package in packages {
        let name = package.get("name").and_then(|n| n.as_str());
        let version = package.get("version").and_then(|v| v.as_str());
        if let (Some(name), Some(version)) = (name, version) {
            out.push((name.to_string(), version.to_string()));
        }
    }
    Ok(out)
}

/// Every package of the vendored lock file, at the same version, in the root
/// lock file.
///
/// cargo-deny and cargo-about read the root workspace. The wasm build reads
/// vendor/beamterm/Cargo.lock. The two resolvers run apart, so a package can
/// carry one version in the license report and another version in the shipped
/// wasm module. This rule keeps the report true: every package that the wasm
/// module holds is a package that the root graph holds, at that same version.
///
/// To repair a difference, run `cargo update -p <name> --precise <version>` in
/// vendor/beamterm, or in the repository root.
fn check_lock_containment(root_lock: &str, vendor_lock: &str, errors: &mut Vec<String>) {
    let root: std::collections::BTreeSet<(String, String)> = match lock_packages(root_lock) {
        Ok(packages) => packages.into_iter().collect(),
        Err(e) => {
            errors.push(format!("Cargo.lock: {e}"));
            return;
        }
    };
    let vendor = match lock_packages(vendor_lock) {
        Ok(packages) => packages,
        Err(e) => {
            errors.push(format!("vendor/beamterm/Cargo.lock: {e}"));
            return;
        }
    };
    for (name, version) in vendor {
        if !root.contains(&(name.clone(), version.clone())) {
            errors.push(format!(
                "Cargo.lock holds no `{name} {version}`, and \
                 vendor/beamterm/Cargo.lock does. `cargo deny check` then reads \
                 a version that the wasm module does not hold. Run \
                 `cargo update -p {name} --precise {version}` in the repository \
                 root."
            ));
        }
    }
}

/// The version of one tool in mise.toml.
fn mise_tool_version(config: &toml::Value, tool: &str) -> Option<String> {
    match config.get("tools")?.get(tool)? {
        toml::Value::String(s) => Some(s.clone()),
        toml::Value::Table(t) => t
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    }
}

/// The vendored beamterm tree against the three files that must agree with it.
///
/// 1. `UPSTREAM.toml` records the upstream commit. It must be a full commit,
///    for the same reason as the Ghostty pin: a short commit or a tag can move.
/// 2. The `wasm-bindgen` crate of `vendor/beamterm/Cargo.lock` and the
///    `wasm-bindgen` binary of mise.toml write the two halves of one binding
///    layer. A different version pair gives a module that fails at import time,
///    and no compiler reports it.
/// 3. `web/package.json` must resolve `@beamterm/renderer` to the directory that
///    `cargo xtask wasm` writes. A registry version there takes the npm package
///    again, and the vendored source then reaches no browser.
fn check_beamterm_pin() -> Result<String> {
    let root = repo_root();
    let vendor = root.join(crate::wasm::VENDOR_DIR);
    let path = vendor.join("UPSTREAM.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;

    let commit = doc
        .get("commit")
        .and_then(|v| v.as_str())
        .ok_or("vendor/beamterm/UPSTREAM.toml has no `commit`")?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "`{commit}` in vendor/beamterm/UPSTREAM.toml is not a full git commit"
        )
        .into());
    }

    let recorded = doc
        .get("wasm_bindgen")
        .and_then(|v| v.as_str())
        .ok_or("vendor/beamterm/UPSTREAM.toml has no `wasm_bindgen`")?;

    let lock = std::fs::read_to_string(vendor.join("Cargo.lock"))?;
    let crate_version = lock_version(&lock, "wasm-bindgen")
        .ok_or("vendor/beamterm/Cargo.lock holds no `wasm-bindgen` package")?;
    if crate_version != recorded {
        return Err(format!(
            "vendor/beamterm/UPSTREAM.toml says wasm_bindgen {recorded}, and \
             vendor/beamterm/Cargo.lock holds the crate at {crate_version}. \
             Correct UPSTREAM.toml."
        )
        .into());
    }

    let mise: toml::Value = toml::from_str(&std::fs::read_to_string(root.join("mise.toml"))?)?;
    let tool_version = mise_tool_version(&mise, BINDGEN_TOOL)
        .ok_or_else(|| format!("mise.toml has no `{BINDGEN_TOOL}` under [tools]"))?;
    if tool_version != crate_version {
        return Err(format!(
            "mise.toml installs wasm-bindgen {tool_version}, and \
             vendor/beamterm/Cargo.lock holds the crate at {crate_version}. \
             The tool writes the JavaScript side of the bindings, and the crate \
             writes the wasm side. Set both to one version."
        )
        .into());
    }

    check_beamterm_specifier(&root)?;
    Ok(commit.to_string())
}

/// The `@beamterm/renderer` entry of web/package.json against the directory that
/// `cargo xtask wasm` writes.
fn check_beamterm_specifier(root: &Path) -> Result<()> {
    let path = root.join("web/package.json");
    if !path.is_file() {
        return Ok(());
    }
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let spec = doc
        .get("dependencies")
        .and_then(|d| d.get(BEAMTERM_PACKAGE))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            format!("web/package.json has no `{BEAMTERM_PACKAGE}` under `dependencies`")
        })?;

    // bun resolves the path against the directory of web/package.json.
    let wanted = format!(
        "{LOCAL_PREFIX}../{}/{}",
        crate::wasm::VENDOR_DIR,
        crate::wasm::PKG_DIR
    );
    if spec != wanted {
        return Err(format!(
            "web/package.json: `{BEAMTERM_PACKAGE}` is \"{spec}\", and \
             `cargo xtask wasm` writes \"{wanted}\". A registry version here \
             takes the npm package, and the source of vendor/beamterm then \
             reaches no browser."
        )
        .into());
    }
    Ok(())
}

/// The dependency tables of one Cargo manifest, with the name of each table.
fn dependency_tables(doc: &toml::Value) -> Vec<(String, &toml::Value)> {
    const KINDS: &[&str] = &["dependencies", "dev-dependencies", "build-dependencies"];
    let mut tables: Vec<(String, &toml::Value)> = Vec::new();

    for table in ["workspace.dependencies"].iter().chain(KINDS) {
        let mut node = Some(doc);
        for key in table.split('.') {
            node = node.and_then(|n| n.get(key));
        }
        if let Some(node) = node {
            tables.push(((*table).to_string(), node));
        }
    }

    // `[target."cfg(...)".dependencies]` holds the dependencies of one platform.
    // No manifest of this workspace declares one today. The rule covers them so
    // that the first one cannot arrive as a range.
    if let Some(targets) = doc.get("target").and_then(|t| t.as_table()) {
        for (cfg, spec) in targets {
            for kind in KINDS {
                if let Some(node) = spec.get(kind) {
                    tables.push((format!("target.\"{cfg}\".{kind}"), node));
                }
            }
        }
    }
    tables
}

fn check_cargo_manifest(path: &Path, errors: &mut Vec<String>) -> Result<()> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let doc: toml::Value = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path.strip_prefix(repo_root()).unwrap_or(path).display();

    for (table, node) in dependency_tables(&doc) {
        let Some(deps) = node.as_table() else {
            continue;
        };

        for (dep, spec) in deps {
            let version = match spec {
                toml::Value::String(s) => Some(s.as_str()),
                toml::Value::Table(t) => {
                    // Path and workspace dependencies carry no version to pin.
                    if t.contains_key("path") || t.contains_key("workspace") {
                        continue;
                    }
                    t.get("version").and_then(|v| v.as_str())
                }
                _ => None,
            };
            let Some(version) = version else {
                errors.push(format!("{name}: `{dep}` in [{table}] has no version"));
                continue;
            };
            if !version.starts_with('=') {
                // Remove the range characters first. A `=` in front of the whole
                // string gives advice such as `Write "=^0.29.0".`, and that is
                // not a valid requirement.
                let exact = version.trim_start_matches(['^', '~', '>', '<', '=', ' ']);
                errors.push(format!(
                    "{name}: `{dep} = \"{version}\"` is a range. Write \"={exact}\"."
                ));
            }
        }
    }
    Ok(())
}

fn check_package_json(path: &Path, errors: &mut Vec<String>) -> Result<()> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    for table in ["dependencies", "devDependencies"] {
        let Some(deps) = doc.get(table).and_then(|d| d.as_object()) else {
            continue;
        };
        for (dep, spec) in deps {
            let Some(version) = spec.as_str() else {
                continue;
            };

            // A `file:` specifier names a directory of this repository, not a
            // version. It carries no range, and the bytes come from the build of
            // this repository. The path must be relative, because an absolute
            // path resolves to a different directory on another machine.
            if let Some(path) = version.strip_prefix(LOCAL_PREFIX) {
                if Path::new(path).is_absolute() {
                    errors.push(format!(
                        "web/package.json: `{dep}`: \"{version}\" is an absolute path. \
                         Write a path that is relative to web/."
                    ));
                }
                continue;
            }

            let exact = version.chars().next().is_some_and(|c| c.is_ascii_digit())
                && !version.contains('*')
                && !version.contains(" - ")
                && !version.contains("||");
            if !exact {
                errors.push(format!(
                    "web/package.json: `{dep}`: \"{version}\" is a range. Write the exact version."
                ));
            }
        }
    }
    Ok(())
}

/// Read the one version number of the workspace.
pub fn read_version() -> Result<String> {
    let path = repo_root().join("Cargo.toml");
    let doc: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
    let version = doc
        .get("workspace")
        .and_then(|w| w.get("package"))
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .ok_or("no `version` under [workspace.package] in Cargo.toml")?;
    Ok(version.to_string())
}

/// Write one version number to every manifest that carries one.
pub fn write_version(version: &str) -> Result<()> {
    let root = repo_root();

    let cargo_path = root.join("Cargo.toml");
    let cargo = std::fs::read_to_string(&cargo_path)?;
    let mut out = String::with_capacity(cargo.len());
    let mut in_workspace_package = false;
    let mut replaced = false;
    for line in cargo.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_workspace_package = trimmed == "[workspace.package]";
        }
        if in_workspace_package && trimmed.starts_with("version") && !replaced {
            out.push_str(&format!("version = \"{version}\"\n"));
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !replaced {
        return Err("no `version` under [workspace.package] in Cargo.toml".into());
    }
    std::fs::write(&cargo_path, out)?;

    let pkg_path = root.join("web/package.json");
    if pkg_path.is_file() {
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pkg_path)?)?;
        doc["version"] = serde_json::Value::String(version.to_string());
        std::fs::write(
            &pkg_path,
            format!("{}\n", serde_json::to_string_pretty(&doc)?),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write one package.json into a new temporary directory and check it.
    ///
    /// The tests of one binary run at the same time in one process, so the
    /// directory name carries the name of the test.
    fn check_json(name: &str, body: &str) -> Vec<String> {
        let dir = std::env::temp_dir().join(format!("xtask-pins-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.json");
        std::fs::write(&path, body).unwrap();
        let mut errors = Vec::new();
        let result = check_package_json(&path, &mut errors);
        std::fs::remove_dir_all(&dir).unwrap();
        result.unwrap();
        errors
    }

    #[test]
    fn a_local_directory_dependency_is_not_a_range() {
        let errors = check_json(
            "local",
            r#"{"dependencies": {"@beamterm/renderer": "file:../vendor/beamterm/pkg"}}"#,
        );
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn an_absolute_local_dependency_fails() {
        let errors = check_json("absolute", r#"{"dependencies": {"a": "file:/opt/pkg"}}"#);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("absolute path"), "{errors:?}");
    }

    #[test]
    fn a_registry_range_still_fails() {
        let errors = check_json("range", r#"{"dependencies": {"a": "^1.2.3"}}"#);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("is a range"), "{errors:?}");
    }

    #[test]
    fn a_target_list_matches_one_element_at_a_time() {
        assert!(has_target(
            "a,wasm32-unknown-unknown,b",
            "wasm32-unknown-unknown"
        ));
        assert!(has_target(
            "a, wasm32-unknown-unknown",
            "wasm32-unknown-unknown"
        ));
        assert!(!has_target(
            "wasm32-unknown-unknown-x",
            "wasm32-unknown-unknown"
        ));
        assert!(!has_target(
            "aarch64-apple-darwin",
            "wasm32-unknown-unknown"
        ));
    }

    #[test]
    fn the_rust_target_list_needs_the_wasm_target() {
        let config: toml::Value = toml::from_str(
            "[tools]\nrust = { version = \"1.0.0\", targets = \"x86_64-apple-darwin\" }",
        )
        .unwrap();
        let mut errors = Vec::new();
        check_rust_targets(&config, &mut errors);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains(WASM_TARGET), "{errors:?}");
    }

    #[test]
    fn a_lock_file_gives_the_version_of_one_package() {
        let lock = "\
[[package]]\n\
name = \"js-sys\"\n\
version = \"0.3.81\"\n\
\n\
[[package]]\n\
name = \"wasm-bindgen\"\n\
version = \"0.2.115\"\n";
        assert_eq!(
            lock_version(lock, "wasm-bindgen").as_deref(),
            Some("0.2.115")
        );
        assert_eq!(lock_version(lock, "glow"), None);
    }

    /// The three files that hold the wasm-bindgen version must agree.
    #[test]
    fn the_beamterm_pin_holds() {
        check_beamterm_pin().unwrap();
    }

    #[test]
    fn a_vendored_package_outside_the_root_graph_fails() {
        let root = "[[package]]\nname = \"glow\"\nversion = \"0.17.0\"\n";
        let vendor = "[[package]]\nname = \"glow\"\nversion = \"0.18.0\"\n";
        let mut errors = Vec::new();
        check_lock_containment(root, vendor, &mut errors);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("glow 0.18.0"), "{errors:?}");

        let mut errors = Vec::new();
        check_lock_containment(root, root, &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
    }

    /// The two lock files of this repository must agree today.
    #[test]
    fn the_two_lock_files_agree() {
        let root = repo_root();
        let mut errors = Vec::new();
        check_lock_containment(
            &std::fs::read_to_string(root.join("Cargo.lock")).unwrap(),
            &std::fs::read_to_string(root.join(crate::wasm::VENDOR_DIR).join("Cargo.lock"))
                .unwrap(),
            &mut errors,
        );
        assert!(errors.is_empty(), "{errors:?}");
    }
}
