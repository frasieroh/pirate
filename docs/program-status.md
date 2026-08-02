# Program status

This file records the improvement program for pirate. It states what the
product manager asked for, what is complete, what is in progress, and what
remains. The engineering director wrote it on 2026-08-01.

## 1. The request

The product manager asked for four areas of work.

**Security.** The web server must serve HTTPS. It takes a certificate and key
pair, or it generates a self-signed certificate. A `plaintext` mode serves
plain HTTP. The server must also prompt the browser for a token before it
starts the shell. The token lives in `$HOME/.pirate/auth_token`, with mode 0700
on the directory and 0600 on the file. pirate generates the token when the file
is absent, uses it when the file is present, and never prints it. A wrong mode
stops the server. `--no-password` removes the gate. The token input uses
standard HTML elements, so the browser can offer to save it.

**Interface.** The client uses the full screen and holds no status bar at the
bottom. A menu in the top right corner holds the session status and the
configuration controls. A minus and plus control collapses and expands the
menu. A hotkey hides the menu. The user configures the terminal theme on the
client, in a format compatible with iTerm, and imports a theme by file upload.
The user also changes the size of the terminal characters, which resizes the
terminal.

**Keystrokes.** Some control characters do not reach the shell. The reported
example is `ctrl-a` and then `ctrl-j` or `ctrl-k`, which resizes a tmux pane. A
held key must also repeat, at 10 per second after a 0.6 second debounce. The
rate is configurable and the debounce is not.

**Other.** Preferences persist in browser cookies, and the token does not. The
client must read as an elite unix utility, with deliberate and restrained
design. Drop shadows and glows are forbidden. The build pipeline must become
simpler and more maintainable. The application needs an audit for correctness,
security, and simplicity, in that order, with end-to-end test coverage. The
repository needs a README.

## 2. The decisions

The product manager settled four questions before the work started.

| Question | Decision |
|---|---|
| How the browser carries the token | The client posts the token to `/auth`. The server answers with an opaque session id in a HttpOnly, SameSite=Strict cookie. The raw token reaches no client storage. |
| What a reconnect does | Nothing changes. A dropped socket ends the shell, and a reconnect starts a new one. Session resumption is out of scope. |
| How the build gets simpler | mise declares every toolchain in one file. Renovate opens the version bump pull requests. Pins stay exact. The hand-rolled downloader goes. |
| The default keybindings | Alt+H hides the menu. Alt+minus and Alt+equals change the font size. |

The keybinding decision corrects the original request. On macOS, Cmd+H is Hide
Application, and the keystroke never reaches the page. In every browser, Cmd or
Ctrl with minus or equals is page zoom, and a page cannot cancel it. Alt
combinations are reserved by neither the operating system nor any browser. All
three bindings stay configurable in the menu.

The director made three further rulings during the work.

1. **The macOS SDK shim stays out of the mise PATH.** mise controls the order
   of its own entries. A shim that lands after Zig builds against the wrong SDK
   and reports no error. A loud link failure is better than a silent wrong
   build. The cost is one `cargo xtask build` before a plain `cargo build` on
   macOS. `docs/building.md` states this.
2. **cargo-dist stays out.** It regenerates `release.yml` and writes its own
   `uses:` lines with tags, not with 40-character commit SHA values. That
   breaks the pinning requirement. The gap it fills is installers, and pirate
   ships tarballs only. Revisit it when installers become a requirement.
3. **The startup line `pirate: token file <path>` stays.** It prints the path
   and never the token. An operator who must correct the mode needs the path.

## 3. Complete

Three commits are on `main`.

```
0f84409  Merge branch 'worktree-agent-ad03e4b2c596accae'
5468e58  Declare the build tools in mise.toml and simplify xtask
c982213  Serve TLS and authenticate the browser
```

### 3.1 Security, commit c982213

TLS is a second `axum::serve::Listener` that wraps the existing `NoDelay`
listener. The server therefore keeps TCP_NODELAY, graceful shutdown, and
`axum::serve`, and the build adds no `axum-server` dependency. `--cert` with
`--key` takes a PEM pair. `--selfsigned` generates a certificate and prints the
SHA-256 fingerprint, and the private key stays in memory. `--plaintext` serves
plain HTTP. A loopback bind needs no flag, and any other bind refuses to start
until one of the three flags is present.

An adversarial review found six defects that a client can reach. Each one has a
test.

| Defect | Correction |
|---|---|
| DNS rebinding. An attacker-owned name resolves to the address of pirate, the browser puts that name in both `Origin` and `Host`, the two agree, and a same-origin test passes. | `--hostname` declares the names that this server answers to. An unlisted name is refused, even when the two headers agree and the session cookie is valid. |
| The rate limiter spent its budget on correct tokens, so a flood locked the operator out of a shell. | The server compares the token first. A correct token is never refused. The limiter spends on wrong guesses only. |
| A second `pirate_session` cookie shadowed the first one. | The lookup scans every candidate in constant time, with a bound of 8. |
| A symlinked directory reached a token file that another user owns. | The server compares the owning user id on the directory and on the open file handle. |
| A duplicate `Host` or `Origin` header split the two tests apart. | The server refuses a request that carries more than one of either header. |
| The TLS listener stopped its accept loop at 256 handshakes in flight, so 400 idle sockets refused every other client. | The accept loop always accepts. At the bound it aborts the oldest handshake. |

The director verified the result independently against the release binary.

| Check | Result |
|---|---|
| Token file permissions | Directory 0700, file 0600, 32 bytes of entropy |
| The token in any output stream | Absent. The path prints and the token does not. |
| `POST /auth` with a wrong token | 401 |
| `POST /auth` with the correct token | 204, with `HttpOnly; SameSite=Strict; Secure` |
| `Origin` and `Host` agreeing on an unlisted name, correct token | 403 |
| A request with no `Origin` | 403. The check fails closed. |
| `/ws` with no session cookie | 401 |
| `/ws` with a valid session cookie | The socket upgrades |

### 3.2 Build pipeline, commits 5468e58 and 0f84409

`mise.toml` declares zig, bun, rust, cargo-zigbuild and cargo-deny. `mise.lock`
holds a SHA-256 for every platform. Every version carries the reason that it
cannot move, which includes the chain from libghostty-vt-sys 0.2.1 to a Ghostty
commit that declares `.minimum_zig_version = "0.15.2"`.

The hand-rolled Zig downloader is gone. `.zigversion`, `rust-toolchain.toml`,
and `toolchain/zig.toml` are deleted. `cargo xtask setup` is gone, because
`cargo xtask dist` now works from a clean checkout. The compression pass and
the build-info pass moved into Vite plugins, so `crates/xtask/src/buildinfo.rs`
and `crates/xtask/src/compress.rs` are deleted. A plain `cargo build` no longer
stops when `web/dist` is absent. It warns, names the fix, and the binary
reports the fault at run time.

`.github/renovate.json5` covers four ecosystems: cargo, bun, GitHub Actions
pinned by commit SHA, and the mise tool versions. `cargo xtask verify-pins` now
also polices `mise.toml` and `mise.lock`.

The second build manager proved the result after it cleared the build cache.
That step found the one real defect in the wave: on macOS a plain `cargo
build`, `cargo clippy` or `cargo test` fails when libghostty-vt-sys must
compile again, because only `cargo xtask` writes the shim onto PATH. The first
verification runs had passed only because an earlier run had cached that crate.
CI is unaffected, because the Linux job runs clippy and the tests, and the
macOS job calls `cargo xtask build`.

### 3.3 The state of `main`

```
cargo clippy --all-targets -- -D warnings    clean
cargo fmt --all -- --check                   clean
cargo test                                   90 passed, 0 failed
cargo xtask verify-pins                      every pin exact and locked
cd web && bun run test                       20 passed, 0 failed
```

## 4. The client, commit a651779 — COMPLETE

This section described work in progress. That work landed. The text below
records what shipped and what stays open. Section 4.2 holds a dependency limit
that the next director must not re-litigate.

The client uses the full screen. The menu holds the session status and every
control. `position: fixed` keeps it out of the layout flow, and a test proves
that four menu changes send no resize frame. A font size change sends exactly
one.

The verification, run by the director: `bun run typecheck` clean, 63 client
tests pass and 0 fail, `cargo clippy --all-targets -- -D warnings` clean, all
eight Rust suites pass. The client CSS holds no shadow and no glow. The client
touches no `localStorage` and no `sessionStorage`.

### 4.0 The cause of the control-character fault

The fault was FOCUS, not encoding. ghostty-web listens for keys on `#terminal`
alone. The old status bar was a dead click zone across the whole window, under
the tmux status line that an operator watches. One click there moved focus to
the body, and every keystroke then died with no message.

The status bar is gone, and a mousedown guard returns focus. The sweep of the
control space also found five encoder faults in ghostty-web that no one had
reported. Ctrl+V sent nothing. Ctrl+I, Ctrl+M, Ctrl+[ and Ctrl+minus sent Kitty
sequences that arrive in vim and tmux as literal text. Shift+Tab sent the wrong
bytes. Alt with a letter sent the bare letter, which killed readline word
motion and every tmux Meta binding. One `customKeyEventHandler` corrects them.

## 4-OLD. The state during the wave, kept for the record

The client manager owns requirements 2a, 2b, 2c, 3a, 3b, 4a and 4b. Its work is
uncommitted in the working tree.

The scaffold is in place and its tests pass, at 28 passing and 0 failing. New
files: `web/src/prefs.ts`, `menu.ts`, `theme.ts`, `font.ts`, `input.ts`,
`keys.ts`, `runtime.ts`, plus `web/tests/menu.spec.ts` and a fixtures
directory. Modified files: `web/index.html`, `web/src/main.ts`,
`web/src/style.css`, `web/tests/harness.ts`. The manager keeps its state in
`web/CLIENT-NOTES.md`.

The manager reached the wave that runs three workers in parallel, one for
themes, one for font size, and one for input. An API session limit stopped it
once, and it started again.

### 4.1 The state of the client tests

The director ran the tests in `/Users/oscarfrasier/pirate/web`. `bun run
typecheck` is clean. `bun run test` gives 56 passing and 2 failing, across 11
files. The two failures are open work, and neither assertion is weak.

```
(fail) tests/prefs.spec.ts   an over-long theme name is clamped, and the
                             record still persists across a reload
(fail) tests/theme.spec.ts   a file with extra Color Space and Alpha
                             Component keys still parses
```

The second failure describes reality. A real `.itermcolors` file carries the
Color Space and Alpha Component keys.

### 4.2 A limit of ghostty-web, and the accepted answer

ghostty-web does not repaint the background. The client manager proved that
`renderer.setTheme` recolors nothing, and that even NEW output after a theme
change still paints in the earlier colors.

This is a limit of the dependency. The product manager accepts it. A theme
change that cannot repaint requires a page reload. The client stores the
preference before the reload, so the new theme paints on the way back.

CAUTION: A reload ends the session, and a reconnect starts a new shell. The
menu must state that result before the reload happens.

Four constraints in its brief decide whether this wave succeeds.

1. The menu must sit over the terminal and not in the layout flow. A menu in
   the flow changes the box of the terminal, which makes the terminal refit and
   send a second resize frame for one window size. `web/src/style.css` already
   documents that fault.
2. The manager must find the cause of the control-character fault before it
   writes a fix. A fix aimed at the wrong layer looks correct and is not.
3. A second key handler beside the ghostty-web `InputHandler` can send every
   keystroke twice. The manager must prove that it does not.
4. The operating system already repeats a held key, and the browser marks those
   events. Repeat added on top doubles the rate.

The login view is a contract. `web/src/login.css` consumes five CSS custom
properties: `--pirate-bg`, `--pirate-fg`, `--pirate-surface`,
`--pirate-border`, and `--pirate-error`. It also uses the selector
`body[data-auth="required"]`. The client manager can add properties and cannot
rename those five.

## 5. Remaining

### 5.1 The audit wave, requirement 4c

The audit examines correctness, then security, then simplicity, in that order.
It carries three items forward.

- **Open from the security wave.** TLS carries no ALPN, and neither transport
  holds a timeout on the read of the request headers. A slow client can
  therefore hold a connection open, which is the slowloris shape. The security
  manager disclosed both, and neither was in its brief.
- **End-to-end coverage.** The product manager named this as hard and
  necessary. The browser tests today run against a stub server. No test drives
  a real Chromium against the real Rust binary over TLS, through the login
  form, into a shell.
- **Simplicity.** The client gained seven modules in one wave. That is the
  right time to look for the seams that a refactor removes.

### 5.2 The README, requirement 4e

The README documents the application, its usage, and its license. Write it
after the client wave lands, so that it documents what shipped. It must cover
the three transport flags, the token file and its modes, `--no-password`,
`--hostname` and the reason it exists, the default keybindings, and the theme
import.

### 5.3 Unverified on this host

- The four Linux targets were never built here. CI is the only evidence for
  them. The glibc 2.28 floor check and the musl static-linkage check have never
  run outside CI, and CI has not run on this branch.
- `x86_64-apple-darwin` was not built here.
- Docker is not installed here, so no image was built. The Dockerfile inputs
  were compared against `dist.rs` by reading.
- Both workflows parse and actionlint reports nothing. Neither has run.

## 6. The shape of the history, and how to reconcile it

`git log --oneline` gives a confusing order. The next director must read this
section before any rewrite.

### 6.1 What happened

The director created the build worktree from `554f3e0`, the initial commit,
and not from `26efa42`, the head of `main`. The first build commit `b58febd`
therefore has the root commit as its parent. The manager found the fault, and
`39e8011` merges the correct base into that branch. `0f84409` then merges the
branch into `main`.

The graph reads as though the build work started before the benchmarking
commit. It did not. The tree is correct, and only the shape is wrong.

```
*   0f84409 Merge branch 'worktree-agent-ad03e4b2c596accae'
|\
| * 5468e58 Declare the build tools in mise.toml and simplify xtask
| *   39e8011 Merge the correct base 26efa42
| |\
| * | b58febd WIP: declare the build tools in mise.toml
* | | c982213 Serve TLS and authenticate the browser
| |/
|/|
* | 26efa42 Benchmarking and performance improvements
|/
* 554f3e0 Initial commit: pirate, tty astral projector
```

`git log --first-parent --oneline` gives the clean view, and that view is
correct.

### 6.2 The content is proven complete

The director compared the merge result against each side.

| Comparison | Result |
|---|---|
| `git diff c982213 HEAD` over `crates/pirate/src`, `crates/pirate/tests`, `crates/pirate/Cargo.toml`, `web/src/login.*` | One file differs. `crates/pirate/src/assets.rs` holds a comment correction that the director authorized. No code differs. |
| `git diff 5468e58 HEAD` over `crates/xtask`, `.github`, `mise.toml`, `mise.lock`, `Dockerfile`, `deny.toml`, `web/vite.config.ts`, `crates/pirate/build.rs`, `docs` | No differences. |

The merge lost nothing. `main` also passes clippy at `-D warnings`, 90 Rust
tests, 20 browser tests, and `cargo xtask verify-pins`.

### 6.3 Whether to reconcile

`origin/main` is at `26efa42`. The three commits are local, so a rewrite is
safe and breaks no other clone.

**CAUTION: Do not reconcile while the client work is uncommitted.** The working
tree holds seven new modules that no commit records. A `git reset` mixes that
work into the rewrite and can lose it.

The director recommends one of two courses.

1. **Leave the history alone.** The tree is correct and the content is proven.
   `git log --first-parent` reads correctly. This option costs nothing and
   risks nothing.
2. **Linearize before the first push.** Take this course only after the client
   wave lands and its work is committed.

### 6.4 The linearization recipe, if you take course 2

1. Commit the client work. Then confirm that `git status` is clean.
2. Record the target: `git rev-parse HEAD`. Call it `TARGET`. Keep a safety
   branch: `git branch backup-main`.
3. Build a linear branch from the correct base:
   ```
   git checkout -B linear 26efa42
   git cherry-pick c982213
   git checkout $TARGET -- .
   git commit -m "Declare the build tools in mise.toml and simplify xtask"
   git checkout $TARGET -- .
   git commit -m "<the client commit message>"
   ```
4. **PROVE THE REWRITE.** Run `git diff --stat $TARGET linear`. The output must
   be empty. An empty output means that the linear branch holds the same tree
   as the verified merge. If any line prints, stop and keep the merge.
5. Run the full verification again: `cargo clippy --all-targets -- -D
   warnings`, `cargo test`, `cargo xtask verify-pins`, and `cd web && bun run
   typecheck && bun run test`.
6. Move `main` only after step 4 prints nothing and step 5 passes.

The identity check in step 4 is the point of the recipe. A rewrite that changes
the tree is a defect, and only that command finds it.

## 7. What the organization taught us

Managers dispatched workers, and reviewers that were not the author examined
each deliverable. Four failures repeated, and each one is now a standing rule.

1. **A build command that skips test targets proves almost nothing.** Two
   workers reported a green tree from `cargo build --workspace` and from `cargo
   test -p pirate --lib`. Neither compiles the integration tests, and the tests
   had not compiled for some time. The verification command is `cargo clippy
   --all-targets -- -D warnings`, and then `cargo test`.
2. **A worker cannot reach its manager by agent type.** Two reports were lost
   that way. A worker returns its result as final text.
3. **A manager that stops to wait for a child stops the whole program.** One
   manager ended its turn while waiting for a worker that had already died, and
   left the tree in a state that did not compile.
4. **A manager that exhausts its context starts to trust its own summaries.**
   One did, and its replacement began by establishing ground truth from the
   tree. Each manager now keeps a short state file and stops cleanly when it
   runs low.

A fifth lesson belongs to the director. A worktree was cut from the wrong
commit, and the manager in it worked for some time against a workspace that was
missing a crate. Check the base of an isolated worktree before the work starts.
