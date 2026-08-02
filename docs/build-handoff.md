# Build pipeline handoff

State of branch `worktree-agent-ad03e4b2c596accae`. Update this file after each
verification round.

## Verified on this host (macOS 15, arm64, mise 2026.8.0)

| Command | Result | Note |
|---|---|---|
| `cargo fmt --all -- --check` | FAIL, then fixed | `build.rs:163` was unformatted. `cargo fmt --all` corrected it. |
| `cargo clippy --all-targets -- -D warnings` | PASS | Exit 0. |
| `cargo test` | PASS | Exit 0. Includes the integration targets. |
| `cargo build` with no `web/dist` | PASS | Two `cargo:warning` lines name the fault. The build is not silent. |
| `cargo xtask verify-pins` | PASS | Reports the mise tools, the Ghostty commit, and the crate pins. |
| `bun run typecheck` | PASS | Exit 0. |
| `bun run test` | PASS | 20 pass, 0 fail. |
| `cargo xtask dist --target aarch64-apple-darwin` | PASS | From an empty `dist/`, `web/dist` and `.toolchain/shim`. |
| `actionlint` on both workflows | PASS | Exit 0, zero findings. actionlint 1.7.12. |
| PyYAML parse of both workflows | PASS | 4 jobs each. |

## Artifact evidence, aarch64-apple-darwin

- `otool -L` lists `/usr/lib/libiconv.2.dylib` and `/usr/lib/libSystem.B.dylib`
  only. The macOS "system libraries only" rule holds.
- `pirate --version --long` shows the real Ghostty commit, Zig 0.15.2,
  ghostty-web 0.4.0, and the wasm SHA-256. No value is `unknown`.
- The binary serves the index page, and the page holds `id="terminal"`.
- A request with `Accept-Encoding: br` returns `content-encoding: br`. The Vite
  compression plugin output reaches the binary.

## Decided, with the reason

- The macOS SDK shim stays. mise does not remove the need for it. `ensure_shim`
  chose `MacOSX15.sdk`, not the macOS 26 SDK, on this host.
- The shim directory goes first on PATH. `toolchain.rs` builds the list as
  `vec![shim]` and then extends it. A later position takes the wrong SDK and no
  test catches that.
- The numbered "stage" words in xtask named a three-stage build that no longer
  exists. The comments now name the web build and the Rust build.

## The macOS shim and plain cargo commands

A plain `cargo clippy`, `cargo test` or `cargo build` on macOS stops with about
twenty `undefined symbol` errors when libghostty-vt-sys must compile again. Only
`cargo xtask` writes the shim and puts it on PATH. Proof:

- `mise exec -- cargo clippy --all-targets -- -D warnings` after
  `cargo clean -p libghostty-vt-sys`: exit 101, `undefined symbol: _sigaction`.
- The same command with `PATH="$PWD/.toolchain/shim:$PATH"`: exit 0.

CI does not hit this. `cargo clippy` and `cargo test` run in the `linux` job on
`ubuntu-24.04` (ci.yml lines 502 and 505). The `macos` job calls
`cargo xtask build`, which writes the shim (ci.yml line 272).

The shim directory is NOT added to the `[env]` table of mise.toml. mise controls
the order of its own PATH entries. A shim that lands after the Zig directory
gives a silent build against the wrong SDK, which is worse than the loud failure.
`docs/building.md` states the rule instead.

## Outstanding

- The four Linux targets were never built on this host. CI is the only evidence
  for them.
- Docker is not installed on this host, so no image was built. The Dockerfile
  inputs were compared against `dist.rs` by reading, and they agree.
