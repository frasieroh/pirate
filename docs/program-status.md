# Program status

This file records the improvement program for pirate. Three directors have
worked on it. The second director wrote this version on 2026-08-02, for the
third.

Read section 5 if you want the work. Read section 3 before you change the
command line, because it holds decisions that you must not re-open.

## 1. The request

The product manager asked for four areas of work.

**Security.** The web server serves HTTPS. It takes a certificate and key pair,
or it generates a self-signed certificate. A plaintext mode serves plain HTTP.
The server prompts the browser for a token before it starts the shell. The
token lives in `$HOME/.pirate/auth_token`, with mode 0700 on the directory and
0600 on the file. pirate generates the token when the file is absent, uses it
when the file is present, and never prints it. A wrong mode stops the server.
`--no-password` removes the gate. The token input uses standard HTML elements,
so the browser can offer to save it.

**Interface.** The client uses the full screen and holds no status bar. A menu
in the top right corner holds the session status and the controls. A hotkey
hides the menu. The user configures the terminal theme on the client, in a
format compatible with iTerm, and imports a theme by file upload. The user also
changes the size of the terminal characters.

**Keystrokes.** Some control characters did not reach the shell. A held key
repeats at 10 per second after a 0.6 second debounce.

**Other.** Preferences persist in browser cookies, and the token does not. The
client reads as an elite unix utility. Drop shadows and glows are forbidden.
The build pipeline is simple. The application gets an audit for correctness,
security and simplicity, in that order, with end-to-end coverage. The
repository holds a README.

## 2. What shipped

Eight commits carry the program. `git log --first-parent --oneline` gives the
clean view.

```
41c10ac  Bound the request head, the ALPN list and the live terminals
675d010  Delete --hostname and take every name from the transport
cedbef1  Drive a real browser against the real binary over TLS
67003ef  Repaint the terminal on a theme change, with no page reload
e682b2d  Document the application, its usage and its license
a651779  Use the full screen, and add a menu, themes and key repeat
0f84409  Merge branch 'worktree-agent-ad03e4b2c596accae'
c982213  Serve TLS and authenticate the browser
```

### 2.1 Security, commit c982213

TLS is a second `axum::serve::Listener` that wraps the existing `NoDelay`
listener. The server keeps TCP_NODELAY, graceful shutdown and `axum::serve`,
and the build adds no `axum-server` dependency. `--cert` with `--key` takes a
PEM pair. `--selfsigned` generates a certificate and prints the SHA-256
fingerprint. `--plaintext` serves plain HTTP.

An adversarial review found six defects that a client can reach. Each one has a
test: DNS rebinding, a rate limiter that spent its budget on correct tokens, a
second session cookie that shadowed the first, a symlinked directory that
reached a token file of another user, a duplicate `Host` or `Origin` header,
and a TLS accept loop that stopped at 256 handshakes in flight.

### 2.2 Build pipeline, commits 5468e58 and 0f84409

`mise.toml` declares zig, bun, rust, cargo-zigbuild and cargo-deny. `mise.lock`
holds a SHA-256 for every platform. The hand-rolled Zig downloader is gone. The
compression pass and the build-info pass are Vite plugins.
`.github/renovate.json5` covers cargo, bun, GitHub Actions pinned by commit
SHA, and the mise tool versions. `cargo xtask verify-pins` polices all of it.

### 2.3 The client, commit a651779

The client uses the full screen. The menu holds the session status and every
control, and `position: fixed` keeps it out of the layout flow.

The control-character fault was FOCUS and not encoding. ghostty-web listens for
keys on `#terminal` alone. The old status bar was a dead click zone, and one
click there moved focus to the body. Every keystroke then died with no message.
The status bar is gone and a mousedown guard returns focus.

The sweep of the control space also found five encoder faults in ghostty-web
that nobody had reported. Ctrl+V sent nothing. Ctrl+I, Ctrl+M, Ctrl+[ and
Ctrl+minus sent Kitty sequences that arrive as literal text. Shift+Tab sent the
wrong bytes. Alt with a letter sent the bare letter. One
`customKeyEventHandler` corrects them.

Three design rules carry the most weight, and `web/CLIENT-NOTES.md` records
them.

1. A chord reads `KeyboardEvent.code` and never `.key`. On macOS, Option+H
   gives `˙`, so `.key` cannot express a hotkey.
2. One capture-phase listener on the window owns every chord. That is the whole
   defense against a keystroke that sends twice.
3. The menu is `position: fixed`. A menu in the layout flow makes the terminal
   refit and send a second resize frame for one window size.

### 2.4 The README, commit e682b2d

`README.md` documents the application, its usage and its license. It follows
ASD-STE100 Simplified Technical English, pragmatic mode. It uses "make sure
that" as its only check verb and "preference" as its only noun for the
preference concept. Keep both when you edit it.

A checker worker read every claim against the code and killed eight wrong ones
in the draft. The two most useful: a loopback bind legally takes none of the
transport flags, and `DirBuilder::mode(0o700)` is masked by the umask.

### 2.5 The dump frame, commit 67003ef

ghostty-web 0.4.0 bakes the cell colors into the wasm terminal at `open()`.
`renderer.setTheme` paints nothing. Only the constructor honors a theme. A
theme change therefore left the terminal in its old colors until a page reload,
and a reload ends the shell.

The product manager authorized a client-initiated dump frame, which corrects
this. Client tag `0x02` carries no payload. The server answers with the same
`0x01` full-state dump that it sends when a socket opens, over the same
`Command::Resync` path. A theme change builds a new terminal with the new
theme, opens it on the same container, and refills it from a dump. The socket
stays open and the shell survives.

The flood bound is COALESCING and not dropping. A request sets one flag, and at
most one dump goes out per 250 ms per socket. A dropped request would leave the
new terminal blank until the next output, which an operator reads as a lost
session. The bound must cost latency and never a repaint.

The adversarial review killed one defect worth knowing about. A theme change on
a CLOSED socket disposed the terminal and sent the dump request into nothing,
so one click destroyed the last output of a dead shell forever. A rebuild now
requires an open socket.

### 2.6 End-to-end coverage, commit cedbef1

`web/e2e/pirate.e2e.ts` drives one real Chromium against one real `pirate`
process, over TLS, through the login form, into a shell. Eight tests cover that
path, including the `ctrl-a` then `ctrl-j` case that the product manager
reported, all five ghostty-web encoder faults, and the theme repaint of 2.5.

Three properties make this suite worth keeping.

1. The certificate has a NEGATIVE CONTROL. A browser context without
   `ignoreHTTPSErrors` must fail with `ERR_CERT`. Without that control the
   suite would pass silently over plain HTTP if TLS regressed.
2. `HOME` points at a fresh temporary directory. The suite asserts mode 0700,
   mode 0600, 64 hex characters, and that the token appears in neither stdout
   nor stderr. It proves the secrecy requirement and not only the flow.
3. It was proven able to FAIL. Disabling the Ctrl+V branch in `input.ts` turned
   exactly one test red. Deleting the dump request from the theme rebuild
   turned the theme test red.

The suite runs in 4.9 seconds. It stays out of `bun run test` and has its own
`bun run test:e2e`. CI runs it in the linux job. It needs no new dependency,
because Playwright was already an exact devDependency.

CAUTION: The suite serves the client with `--assets-dir web/dist`. It does not
cover the embedded assets. Only the CI musl step covers those.

### 2.7 The name of the server, commit 675d010

This commit deletes `--hostname`. Section 3.3 holds the reasoning.

Under TLS the leaf certificate is the whole rule. pirate answers to the names
that the certificate covers, wildcards included, by the match that a browser
makes. `rustls::client::verify_server_name` does the match, so no new crate
enters the graph. Under plain HTTP pirate carries no certificate, claims no
name, and runs no name test.

`--selfsigned` now covers the loopback names and the name of this machine.
Covering loopback only was the defect that started this work.

pirate reads the names back from the certificate that it serves and prints them
at startup. It stops when the leaf carries no subject alternative name, because
that certificate names nothing and the server would answer 403 to every
browser. Each generated name goes through the same gate that the request path
uses, so pirate never puts a name in a certificate that it will later refuse.
That gate exists because of a real defect: `rcgen` writes an all-digit last
label into a SAN, and `ServerName::try_from` then refuses that same string.

The commit also corrects three defects that the correctness hunt found.

| Defect | Correction |
|---|---|
| The exit frame was lost when the client queue was full. The socket then hung on a dead shell, with no status and no close. | Hold the status and send it again on every resync. |
| `shutdown` signaled a process group that was already reaped. | Guard it with the test that `drop` already used. |
| A read or a write that returned `EINTR` ended the session. | Retry it. |

### 2.8 Three bounds, commit 41c10ac

A read deadline covers the request head on both transports. `axum::serve`
builds its hyper connection inline and takes no configuration, so the deadline
goes UNDER the server, in the IO. `crates/pirate/src/timeout.rs` holds it. A
client that writes one byte a minute now loses its connection instead of
holding a worker. This is the slowloris shape, and the previous handoff carried
it as open.

The ALPN list holds `http/1.1` alone. An empty list leaves the protocol to the
client and to the defaults of two libraries, which is where a cross-protocol
confusion starts.

A live terminal count bounds concurrent shells at 64, which matches
`auth::MAX_SESSIONS`. A request over the bound gets 503 and starts no process.
Before this, one cookie could fork any number of shells.

This commit got its adversarial review late, and that review found three ways
to defeat the deadline. Section 5.3 holds them. All three are corrected and
each one carries a test.

## 3. The decisions

Do not re-open a decision in this section. Each one cost a round trip with the
product manager.

### 3.1 Decisions of the first program

| Question | Decision |
|---|---|
| How the browser carries the token | The client posts the token to `/auth`. The server answers with an opaque session id in a HttpOnly, SameSite=Strict cookie. The raw token reaches no client storage. |
| What a reconnect does | Nothing changes. A dropped socket ends the shell, and a reconnect starts a new one. Session resumption is out of scope. |
| How the build gets simpler | mise declares every toolchain in one file. Renovate opens the version bump pull requests. Pins stay exact. |
| The default keybindings | Alt+H hides the menu. Alt+minus and Alt+equals change the font size. Cmd+H is Hide Application on macOS, and Cmd or Ctrl with minus or equals is page zoom, which a page cannot cancel. |
| The macOS SDK shim | It stays out of the mise PATH. A shim that lands after Zig builds against the wrong SDK and reports no error. A loud link failure is better than a silent wrong build. |
| cargo-dist | Out. It regenerates `release.yml` with tags instead of 40-character commit SHA values, which breaks the pinning requirement. Revisit it when installers become a requirement. |

### 3.2 D1. The dump frame is authorized

The product manager authorized it on 2026-08-01. It shipped in `67003ef`. See
section 2.5.

### 3.3 D2. Delete `--hostname`. The transport gives the name.

The product manager ruled three times on this, and the third ruling replaced
the first two. The operator states no name.

| Mode | The certificate covers | The server answers to |
|---|---|---|
| `--selfsigned` | The loopback names and the system hostname | The same names |
| `--cert` with `--key` | Whatever the operator supplied | Every name in that certificate |
| `--plaintext` | No certificate | Every name. No test runs. |

A wildcard entry matches by the normal wildcard rule and it is ACCEPTED. An
operator who configures a wildcard certificate did so on purpose.

The director proposed two extra constraints and the product manager removed
both. Do not reintroduce them.

1. A rejected wildcard entry. Wildcards are accepted.
2. A name test in plaintext mode. Plaintext accepts every name.

The server keeps its refusal of a request that carries more than one `Host` or
more than one `Origin` header. That test is not about names.

Two consequences are recorded, and neither is a defect to correct.

- In plaintext mode no name test runs, so DNS rebinding is possible in that
  mode. `--plaintext` with `--no-password` gives a shell to any name that
  resolves to the address of pirate. The README states this.
- An operator whose serving name matches neither the system hostname nor a
  certificate cannot declare that name, and gets a 403. A reverse proxy in
  front of `--plaintext` is the realistic case. The director disclosed this and
  the product manager did not change the ruling. If the product manager later
  wants that operator served, the correction is a NEW flag and not a revival of
  the old one.

### 3.4 D3. The git history stays as it is

Earlier commits are pushed, so the linearization recipe that the first handoff
carried is off the table. Nobody rewrites this history.
`git log --first-parent --oneline` reads correctly.

### 3.5 D4. Two corrections to the older handoff text

Both were proven against the code.

1. The cleartext-token warning belongs to `--plaintext` and to a non-loopback
   bind with no TLS. It does NOT belong to `--no-password`, which skips the
   token entirely.
2. The token file has EIGHT stop conditions and not two. It also stops on an
   unset `HOME`, a foreign owner, a path that is not a regular file, a file
   over 4096 bytes, and a token under 32 bytes. The mode test is
   `mode & 0o077 != 0` and not a test for equality with 0700 and 0600. The
   error message names 0700 and 0600.

## 4. The state of main

The second director ran these on 2026-08-02, against the tree and not against a
report.

```
cargo clippy --all-targets -- -D warnings    clean
cargo fmt --all -- --check                   clean
cargo test                                   118 passed, 0 failed
cargo xtask verify-pins                      every pin exact and locked
cd web && bun run typecheck                  clean
cd web && bun run test                       69 passed, 0 failed
cd web && bun run test:e2e                   8 passed, 0 failed
```

CAUTION: On macOS, run `cargo xtask build` once before a plain `cargo build`,
`cargo test` or `cargo clippy`. Only xtask writes the xcrun shim that Zig
needs. Without the shim the link step fails with undefined symbols, and the
fault looks like a code fault.

## 5. The work that remains

### 5.1 Contracts that a refactor must not break

Read this before the simplicity phase. Each line is a coupling that a
reasonable refactor breaks by accident.

`web/src/login.css` consumes five CSS custom properties: `--pirate-bg`,
`--pirate-fg`, `--pirate-surface`, `--pirate-border` and `--pirate-error`. It
also uses the selector `body[data-auth="required"]`. A later change can add
properties. A later change cannot rename those five.

`web/vite.config.ts` holds two build plugins. One compresses `web/dist` and one
writes `web/build-info.toml`. The Rust build reads both outputs. After any
change to that file, run `cargo xtask web` and confirm that both outputs exist.

One capture-phase listener on the window owns every chord. Do not add a second
path into the terminal. See section 2.3, rule 2.

The menu is `position: fixed`. See section 2.3, rule 3.

The protocol tables in `crates/pirate/src/protocol.rs` and
`web/src/protocol.ts` must agree, tag for tag.

### 5.2 The simplicity phase, requirement 4c

This is the third dimension of the audit and NOBODY HAS STARTED IT. The product
manager holds it for the third director on purpose. Correctness and security
came first, and both are done.

The ground is ready in a way it was not before. `web/e2e` now covers the whole
path from the login form into a shell, so a refactor lands on top of real
coverage instead of under it.

Scope for the phase:

- The client gained seven modules in one wave: `prefs.ts`, `keys.ts`,
  `menu.ts`, `theme.ts`, `iterm.ts`, `font.ts` and `input.ts`, with
  `runtime.ts` and `main.ts` around them. That is the right place to look for
  seams that a refactor removes.
- The server holds two known seams, both reported and neither corrected.
  `tls: bool` and `hosts` in `AppState` are two fields with one invariant.
  `covers` reparses the leaf certificate on every request, which was measured
  and found not to be a lever, so treat it as clarity and not as speed.
- Run the whole verification of section 4 after every step. A refactor that
  changes behavior is a defect.

### 5.3 The security phase, and a correction to an earlier reading of it

The manager of the correctness and security wave lost its session in the middle
of the second phase. It resumed, established the state of the tree by reading
it, and finished the phase. `41c10ac` holds the transport work: the ALPN list,
`timeout.rs`, and the terminal bound. The code of `237b090` holds the seven
corrections that the audit asked for.

CAUTION: An earlier draft of this section credited four of these corrections to
commits that never held them, and it closed two findings as NOT REAL that were
real. Every claim in the table below is the output of `git log -S`, and two of
them are proven twice. Take a claim about history out of the history.

| Finding | Where it was corrected | How that is known |
|---|---|---|
| An unbounded stderr flood from malformed frames | `237b090` | `git log -S OnceFlag -- crates/pirate/src/ws.rs` |
| A resize frame of 65535 by 65535 takes 4 GB | `237b090` | `git log -S MAX_COLS -- crates/pirate/src/terminal.rs`. The initial commit `554f3e0` holds no `MAX_COLS`. |
| The cap of 8 cookie candidates can lock the operator out | `237b090` | `git log -S MAX_COOKIE_PAIRS -- crates/pirate/src/auth.rs`. The bound is now 32 candidates and 256 pairs. |
| No `nosniff` and no `frame-ancestors` on the assets | `237b090` | `git log -S nosniff -- crates/pirate/src/assets.rs`. `5468e58` holds no `nosniff`. |
| The ALPN comment states a false fact about the axum `http2` feature | `41c10ac` | The comment now states that axum 0.8 carries no `http2` in its default set and that `Cargo.lock` holds no `h2` crate. The ALPN line itself was always right. |
| `tls: bool` and `hosts` are one invariant in two fields | Open | Simplicity phase, section 5.2. |
| `covers` reparses the leaf per request | Open, measured, not a lever | Section 5.2. |

Five of the seven are corrected and each one carries a test. Two remain, and
both belong to the simplicity phase.

**The late review of `41c10ac` found three ways to defeat the read deadline.**
The reviewer wrote a test for each one, and each test failed. All three are
corrected in `crates/pirate/src/timeout.rs`.

| The hole | What it cost | The correction |
|---|---|---|
| The two bytes `\n\n` counted as a complete head | RFC 9112 lets a server ignore an empty line before the request line, and httparse skips it, so hyper was still waiting for a request line. Two bytes disarmed the deadline for the life of the connection. | A newline counts only after a byte that is not a newline. The `started` flag holds that. |
| A body that dribbles after a complete head | `POST /auth` reads 1024 bytes. One byte a minute held the connection and its task for seventeen hours. | The deadline covers every head, and it is armed BEFORE the read. A client can send the end of a head and the first body byte in one segment, so an arm beside the scan never runs again. |
| A second head on a keep-alive connection | The first request completed, and the next head had no deadline at all. | The same correction. An upgrade, and only an upgrade, makes the wrapper a pass-through. |

The wrapper now watches the WRITE side for `HTTP/1.1 101` and stops there. That
answer, and not the end of the first head, is what makes a connection a
WebSocket. `an_idle_websocket_survives_many_deadlines` is the test that holds
this rule, and it is the one to run first after any change to that file.

**The reviewer then found a fourth hole, in the correction itself.** The flag
that noted the `HTTP/1.1 101` answer latched on the FIRST write of the
connection. A client that sent `GET /auth` first and the `/ws` upgrade second
on the same connection therefore got its 101 unseen, and the wrapper kept
arming a deadline on a live terminal. The operator would have lost the terminal
ten seconds after they stopped typing. `arm` now clears that flag, so the
status line of every answer is read. `an_upgrade_on_a_reused_connection_still_becomes_a_pass_through`
is the test, and it failed before the correction.

The reviewer found four more, all corrected here.

| Finding | The correction |
|---|---|
| Four client-driven `eprintln!` calls had no guard, one of them on every socket close where the signal gives EPERM. The reviewer watched that one fire. | Each is behind its own `OnceFlag`. |
| `MAX_COOKIE_PAIRS` reintroduced the lockout that the CAUTION beside it forbids, at a lower cost: 256 junk pairs that are NOT session cookies pushed the real session past the cut. | The bound is deleted. hyper already bounds the size of a header. The CAUTION now forbids adding it back. |
| `ScreenTerminal::new` and `Session::spawn` reached libghostty-vt with no ceiling, although the CAUTION beside `resize` says the clamp is there because the type is public. | Both carry the clamp. The "one choke point" claim is corrected. |
| `tests/tls.rs` justified the ALPN test with the same false premise that `src/tls.rs` had just corrected. | Corrected. |

Two findings are open and neither is a defect in what shipped. The terminal
bound is global, so under `--no-password` any client on the network can take
all 64 slots and deny the operator. The asset headers reach the 200 answer and
not the 400, the 404, the 500, `/auth`, or a `/ws` refusal, all of which have
empty bodies.

The auditor named its next step and never took it: fuzz `vt_write` and then
`dump` in libghostty-vt.

### 5.4 Findings that were reported and not corrected

The correctness hunt reported these. Each one needs a ruling before it needs a
worker.

1. **A blocked PTY write freezes the whole pump.** `apply` is awaited inside
   the `stream.next()` arm of the select. The manager did not correct it,
   because the correction is a redesign of the input path with a memory
   tradeoff. THIS NEEDS A DECISION FROM THE PRODUCT MANAGER. It is the largest
   open correctness item in the program.
2. A false exit status of -1 after `STATUS_WAIT`.
3. `Accept-Encoding` is matched as a substring, so it ignores `q=0`.
4. `assets.rs` handles no conditional request.
5. No test covers a dump request from a client that is already behind on
   backpressure. `request_dump` reuses `Command::Resync`, which clears the
   `behind` flag. The behavior looks right and is unproven.

### 5.5 Unverified on this host

Two directors have now carried this section without moving it. State it to the
product manager rather than inherit it quietly.

- Nothing in this program has been built or run outside one Mac.
- The four Linux targets, `x86_64-apple-darwin` and the Docker image have no
  evidence but CI. Docker is not installed on this host.
- The glibc 2.28 floor check and the musl static-linkage check have never run
  outside CI.
- CI HAS NEVER RUN ON THIS WORK. Both workflows parse and actionlint reports
  nothing, and neither has executed. `cedbef1` added an end-to-end job to
  `ci.yml` that has also never run.
- Six commits are local and unpushed: `e682b2d`, `67003ef`, `cedbef1`,
  `675d010`, `41c10ac` and the commit that carries this file. Pushing is the
  cheapest verification that this program has available. The second director
  did not push, because the product manager did not authorize it.

## 6. How to run the organization

Managers dispatch workers and review their deliverables. A reviewer is never
the author. Six failures have repeated across the program, and each one is now
a standing rule.

1. **A build command that skips test targets proves almost nothing.** Two
   workers reported a green tree from `cargo build --workspace` and from
   `cargo test -p pirate --lib`. Neither compiles the integration tests. The
   verification command is `cargo clippy --all-targets -- -D warnings`, then
   `cargo test`, then the three commands in `web/`.
2. **A worker cannot reach its manager by agent type.** Two reports were lost
   that way. A worker returns its result as final text.
3. **A manager that stops to wait for a child stops the whole program.**
4. **A manager that exhausts its context starts to trust its own summaries.**
   Each manager keeps a short state file and stops cleanly when it runs low.
   That rule paid for itself in the last wave. A manager died in the middle of
   its second phase, and its state file was the only record of what its auditor
   had found.
5. **Check the base of an isolated worktree before the work starts.** A
   worktree was once cut from the wrong commit, and a manager worked for some
   time against a workspace that was missing a crate.
6. **An audit finding is a claim and not a fact.** Two of seven findings in the
   last wave were already corrected in the tree. Check each one before you
   spend a worker on it.

A seventh rule belongs to the director. Verify a report against the tree. Every
result in section 4 was re-run by the director. The attribution in section 5.3
came from `git log` on each file, and not from the report that named the
finding.
