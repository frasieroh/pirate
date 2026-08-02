# Building pirate

The build spans three toolchains. Zig builds libghostty-vt, Rust builds the server, and Vite
builds the web client. `mise` installs all three from one file, and `crates/xtask` runs them
in order.

## Install mise

mise is the only program you install by hand. It reads `mise.toml` and installs every other
tool at the pinned version.

```
curl https://mise.run | sh
```

On macOS you can also run `brew install mise`.

Then activate mise in your shell. Obey the instructions that the installer prints. For zsh
the line is:

```
eval "$(mise activate zsh)"
```

Activation matters for more than convenience. It puts the pinned Rust, Zig and bun on your
path. It also sets `RUSTUP_TOOLCHAIN` to the pinned Rust for every command in this
repository. Without activation, a plain `cargo test` or `cargo clippy` uses the default
toolchain of your machine instead of the pinned one. `cargo xtask` always uses the pinned
tools, because it asks mise for them itself.

## Build a static binary

```
cargo xtask dist
```

This one command works in a fresh clone. It installs the tools and builds the web assets.
Then it builds all six release targets. It writes one tarball for each target and one
`SHA256SUMS` file into `dist/`.

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

`cargo xtask` needs no `mise trust`, because it grants that trust to its own child process
and writes nothing to your mise trust store.

## The other commands

| Command | Result |
|---|---|
| `cargo xtask web` | Builds `web/dist` and writes `web/build-info.toml`. |
| `cargo xtask build [--release] [--target T]` | Builds the web assets, then the binary. |
| `cargo xtask dist [--target T]...` | Builds each target, then writes the tarballs. |
| `cargo xtask verify-pins` | Fails when any pin is not exact. |
| `cargo xtask version <x.y.z>` | Writes one version to every manifest. |

## A plain `cargo build`

`cargo build` needs no JavaScript toolchain. When `web/dist` is absent, the build prints a
warning and continues. The binary then holds no web assets, and it stops at startup with
`no embedded assets`.

`cargo build` does need `zig` on PATH. libghostty-vt-sys compiles libghostty-vt with Zig, and
that crate runs `zig build` itself. Without `zig` the build stops with
`failed to execute zig build: No such file or directory`. mise puts the pinned Zig on PATH,
so activate mise in your shell, or write `mise exec -- cargo build`.

To get a binary that serves the client, run `cargo xtask web` first, or run
`cargo xtask build`.

## The pins

Every version is exact, and each one lives in one place only.

| Input | File |
|---|---|
| zig, bun, rust, cargo-zigbuild, cargo-deny | `mise.toml` |
| The SHA-256 of every tool download, per platform | `mise.lock` |
| The Ghostty commit | `toolchain/ghostty.toml` |
| Rust dependencies | `Cargo.toml` and `Cargo.lock` |
| Web dependencies | `web/package.json` and `web/bun.lock` |
| GitHub Actions | a full commit SHA in each `uses:` line |
| Container base images | a `sha256:` digest in the `Dockerfile` |

Renovate opens a pull request for each of these. `cargo xtask verify-pins` fails when a pin
is a range, and it fails when `mise.lock` does not match `mise.toml`.

Renovate cannot write `mise.lock`. After you change a version in `mise.toml`, write the lock
file again. Then commit it:

```
mise lock --platform linux-x64,linux-arm64,macos-arm64,macos-x64
```

## macOS: the SDK

CAUTION: Keep a macOS 15 SDK on the machine. Zig 0.15.2 cannot link against the macOS 26
SDK. The `libSystem.B.tbd` of that SDK lists `arm64e-macos` and does not list `arm64-macos`.
Every libc symbol stays undefined then, and the link stops.

xtask finds an SDK that lists the host architecture and writes an `xcrun` shim into
`.toolchain/shim`. Zig runs `xcrun --sdk macosx --show-sdk-path`, and that explicit `--sdk`
makes `xcrun` ignore `SDKROOT`, so a shim earlier on the path is the only control. Every
`cargo xtask` command writes the shim and puts it first on the path.

CAUTION: On macOS, run `cargo xtask build` before a plain `cargo build`, `cargo clippy` or
`cargo test`. Only `cargo xtask` puts the shim on the path. A plain cargo command that must
compile libghostty-vt-sys again stops with about twenty `undefined symbol` errors, such as
`_sigaction` and `_waitpid`. Prefix the path to run a plain cargo command yourself:

```
PATH="$PWD/.toolchain/shim:$PATH" cargo clippy --all-targets -- -D warnings
```

This step is for macOS only. Linux needs no shim, and CI runs `cargo clippy` and `cargo test`
on `ubuntu-24.04`.

CI pins the runner image to `macos-15` for the same reason.

## Cross-compiling

The four Linux targets link through `cargo-zigbuild`, which uses Zig as the linker driver.
mise installs it. The two `gnu` targets carry the suffix `.2.28`, which sets the glibc floor.
Cargo writes the artifact into the directory of the plain triple.

The two Apple targets link with the system linker and build with plain `cargo build`.

## The container image

```
cargo xtask dist --target x86_64-unknown-linux-musl
docker build -t pirate:0.1.0 .
```

The build context needs `dist/` only. Read the header of the `Dockerfile` for the two-
architecture command and for the bind-address warning.
