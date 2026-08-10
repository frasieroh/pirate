# Building pirate

The build spans four toolchains. Zig builds libghostty-vt, Rust builds the server and the
vendored beamterm renderer, and Vite builds the web client. wasm-bindgen writes the
JavaScript side of that renderer. `mise` installs all four from one file, and `crates/xtask`
runs them in order.

## Install mise

mise is the only program you install by hand. It reads `mise.toml` and installs every other
tool at the pinned version.

```
curl https://mise.run | sh
```

On macOS you can also run `brew install mise`.

Then activate mise in your shell.

```
eval "$(mise activate zsh)"
```

Activation puts the pinned Rust, Zig and bun on your path. It also sets
`RUSTUP_TOOLCHAIN` to the pinned Rust for every command in this
repository. Without activation, a plain `cargo test` or `cargo clippy` uses the default
toolchain of your machine instead of the pinned one.

## Building

```
cargo xtask dist
```

It installs the tools and builds the web assets and release targets. It writes one tarball
for each target and one `SHA256SUMS` file into `dist/`.

To build one target only, name it:

```
cargo xtask dist --target aarch64-apple-darwin
```

If you have no Rust toolchain yet, install the tools first. mise reads a configuration file
only after you trust it. Trust this repository once:

```
mise trust
mise install
mise exec -- cargo xtask dist
```

## Other build targets

| Command | Result |
|---|---|
| `cargo xtask wasm` | Builds `vendor/beamterm` for wasm32 and writes the local npm package into `vendor/beamterm/pkg`. |
| `cargo xtask web` | Builds the wasm package first, then `web/dist`, and writes `web/build-info.toml`. |
| `cargo xtask build [--release] [--target T]` | Builds the web assets, then the binary. |
| `cargo xtask dist [--target T]...` | Builds each target, then writes the tarballs. |
| `cargo xtask verify-pins` | Fails when any pin is not exact. |
| `cargo xtask version <x.y.z>` | Writes one version to every manifest. |

## The vendored beamterm renderer

`vendor/beamterm/` holds vendored Rust source of the WebGL2 terminal renderer.
`cargo xtask wasm` builds this source for `wasm32-unknown-unknown` and writes the local npm
package into `vendor/beamterm/pkg`.

CAUTION: Run `cargo xtask wasm` under mise. mise puts the pinned `wasm-bindgen` on PATH. A
`wasm-bindgen` from your machine writes bindings that do not match the wasm module.

The source comes from `https://github.com/junkdog/beamterm`, tag `beamterm-v1.0.0`, at commit
`fd8066e840ebf4d7ad26dbfcc0ac5f4b7b34b7e3`. `vendor/beamterm/UPSTREAM.toml` records this pin.

`web/package.json` resolves `@beamterm/renderer` to `vendor/beamterm/pkg`. The package no
longer comes from the npm registry.

pirate does not use `wasm-pack`. wasm-pack downloads `wasm-bindgen` and `wasm-opt` at build
time, and no file of this repository pins those two downloads. mise pins `wasm-bindgen`
instead.

The build runs no `wasm-opt` pass. The local module is 1.58 MB, against 1.39 MB for the
module of the npm package.

## A plain `cargo build`

`cargo build` needs no JavaScript toolchain. When `web/dist` is absent, the build prints a
warning and continues. The binary then holds no web assets, and it stops at startup with
`no embedded assets`.

`cargo build` does need `zig` on PATH. libghostty-vt-sys compiles libghostty-vt with Zig, and
that crate runs `zig build` itself. Without `zig` the build stops with
`failed to execute zig build: No such file or directory`. mise puts the pinned Zig on PATH,
so activate mise in your shell, or write `mise exec -- cargo build`.

## Versioning

| Input | File |
|---|---|
| zig, bun, rust, cargo-zigbuild, cargo-deny, wasm-bindgen | `mise.toml` |
| The SHA-256 of every tool download, per platform | `mise.lock` |
| The Ghostty commit | `toolchain/ghostty.toml` |
| The beamterm commit and the wasm-bindgen version of the vendored tree | `vendor/beamterm/UPSTREAM.toml` |
| The dependencies of the vendored renderer | `vendor/beamterm/Cargo.lock` |
| Rust dependencies | `Cargo.toml` and `Cargo.lock` |
| Web dependencies | `web/package.json` and `web/bun.lock` |
| GitHub Actions | a full commit SHA in each `uses:` line |
| Container base images | a `sha256:` digest in the `Dockerfile` |

Renovate opens a pull request for each of these, with one exception.
`vendor/beamterm/UPSTREAM.toml` has no Renovate manager and no rule in
`.github/renovate.json5`, so that pin gets no pull request. A person raises the beamterm
commit by hand, with the steps in `vendor/beamterm/UPSTREAM.toml`.

`cargo xtask verify-pins` fails when a pin is a range, and it fails when `mise.lock` does
not match `mise.toml`.

After you change a version in `mise.toml`, write the lock file again. Then commit it:

```
mise lock --platform linux-x64,linux-arm64,macos-arm64,macos-x64
```

## macOS builds

Zig 0.15.2 cannot link against macOS 26 SDK.

xtask finds an SDK that lists the host architecture and writes an `xcrun` shim into
`.toolchain/shim`. Zig runs `xcrun --sdk macosx --show-sdk-path`, and that explicit `--sdk`
makes `xcrun` ignore `SDKROOT`, so a shim earlier on the path is the only control. Every
`cargo xtask` command writes the shim and puts it first on the path.

On macOS, run `cargo xtask build` before plain cargo commands.
The shim is only on PATH for `cargo xtask`.

To run a plain cargo command yourself, run both of these lines first, in this order:

```
eval "$(mise env --shell bash)"
export PATH="$PWD/.toolchain/shim:$PATH"
```

The base PATH puts the Homebrew Zig ahead of the pinned Zig of mise. `mise env` fixes that
order. Without it, the Homebrew Zig fails the version check of Ghostty before the linker
runs. Run the `export` line after the `eval` line. `mise env` writes a new PATH, and it
removes the shim when you export the shim first.

Do not add `.toolchain/shim` to `mise.toml` [env]. It breaks PATH order.

This step is for macOS only. Linux needs no shim, and CI runs `cargo clippy` and `cargo test`
on `ubuntu-24.04`.

CI pins the runner image to `macos-15` for the same reason.

## Cross-compiling

The four Linux targets link through `cargo-zigbuild`, which uses Zig as the linker driver.
mise installs it. The two `gnu` targets carry the suffix `.2.28`, which sets the glibc floor.
Cargo writes the artifact into the directory of the plain triple.

The two Apple targets link with the system linker and build with plain `cargo build`.

## Docker

```
cargo xtask dist --target x86_64-unknown-linux-musl
docker build -t pirate:0.1.0 .
```

The build context needs `dist/` only.
