# pirate

pirate is a terminal emulator proxy. The server runs a PTY on the host machine, and the
browser renders it.

The browser loads the web client of pirate. That client starts `ghostty-web`, which is
libghostty-vt as WebAssembly. The client draws the screen on a canvas and encodes each
keystroke.

pirate serves the web client and one WebSocket at `/ws`. That socket carries the bytes of the
PTY in both directions. The server holds one PTY for each socket. A closed socket ends that
shell, and a new socket starts a new shell.

The binary holds the web assets, so one file is the whole server.

## Build

Read [docs/building.md](docs/building.md). That file holds the whole procedure, the pinned
tool versions, and the cross-compilation targets.

CAUTION: On macOS, run `cargo xtask build` before a plain `cargo build`, `cargo clippy`, or
`cargo test`. Only `cargo xtask` puts the macOS SDK shim on the path. Without the shim, a
plain cargo command that compiles libghostty-vt-sys again stops with `undefined symbol`
errors.

A binary that holds no web assets stops at startup with this error:

```
no embedded assets. Rebuild with `cargo xtask build`, or pass --assets-dir.
```

## Run pirate the first time

1. Run the pirate binary with no flag.
2. Read the path of the token file from the line `pirate: token file <PATH>`.
3. Read the token from `$HOME/.pirate/auth_token`.
4. Open `http://127.0.0.1:8080` in a browser.
5. Type the token in the password field of the login form.
6. Press `enter`.

Note: pirate binds `127.0.0.1` on port 8080 by default. A loopback address needs no transport
flag.

Note: The first start writes a new token. Every later start reads that same token.

The startup lines go to stderr:

```
pirate: serving <COUNT> embedded assets
pirate: token file <PATH>
pirate: shell <PATH>
pirate: listening on http://127.0.0.1:8080
```

With `--assets-dir`, the line `pirate: serving assets from <DIR>` takes the place of the first
line. Ctrl-C prints `pirate: shutting down`.

The login form is a real HTML form with a username field and a password field, so a password
manager can save the token. The client stores no raw token. The one stored credential is the
`HttpOnly` session cookie of the server, which no script can read.

## The transport

One run takes at most one of these three flags. Two of them together is an error.

| Flag | Short | Result |
|---|---|---|
| `--cert <FILE>` with `--key <FILE>` | `-c`, `-k` | TLS from a certificate chain and a private key, both in PEM. |
| `--selfsigned` | `-s` | pirate generates a certificate at startup, then serves TLS. |
| `--plaintext` | none | Plain HTTP. |

With no transport flag, a loopback bind address gives plain HTTP. A browser treats
`http://localhost` as a trustworthy origin, and the bytes reach no network card.

With no transport flag, a bind address that is not loopback stops the server:

```
the bind address 0.0.0.0 is not loopback, so pirate needs a transport. Use --cert with --key, or --selfsigned, or --plaintext.
```

`--selfsigned` builds a certificate for the names `localhost`, `127.0.0.1`, and `::1`. It
covers no other name and no other address. The private key stays in memory, so a restart gives
a new certificate. Nothing signed the certificate, so the browser shows a warning. pirate
prints the SHA-256 fingerprint of the certificate:

```
pirate: nothing signed this certificate, so the browser will show a warning.
pirate: compare this fingerprint with the one in that warning:
pirate: <FINGERPRINT>
```

Make sure that this fingerprint agrees with the fingerprint in the warning of the browser.

CAUTION: Do not use `--plaintext` on a network that you do not trust. The token, every
keystroke, and every byte of the screen cross the network in the clear.

pirate prints this line for every `--plaintext` run:

```
pirate: CAUTION: Use --selfsigned or --cert to encrypt the transport. --plaintext sends every keystroke and every byte of the screen in the clear.
```

On a bind address that is not loopback, with no TLS and with no `--no-password`, pirate prints
this line too:

```
pirate: CAUTION: Use --selfsigned or --cert on this bind address. Plain HTTP puts the token on the network in the clear.
```

## The token file

pirate keeps one secret: the token in `$HOME/.pirate/auth_token`. The client posts that token
to `/auth`. The server answers with an opaque session identifier in a cookie, and that cookie
opens `/ws`.

The first start creates the directory at mode 0700 or less, and the file at mode 0600. The
token is 64 hexadecimal characters, from 32 random bytes. Every later start reads that file.
pirate prints the path of the file and never prints the token.

| Condition | Result |
|---|---|
| The file is absent | pirate writes a new token file at mode 0600. |
| The file is present | pirate reads the token from it. |
| `HOME` is empty or is not set | pirate stops. |
| The directory or the file gives access to the group or to other users | pirate stops and names the `chmod` command. |
| Another user owns the directory or the file | pirate stops. |
| The path is not a regular file | pirate stops. |
| The file holds more than 4096 bytes | pirate stops. |
| The token is shorter than 32 bytes, or the file is empty | pirate stops. |

A wrong mode gives one of these two errors:

```
the directory /home/you/.pirate is mode 0755. The required mode is 0700. Run `chmod 700 /home/you/.pirate`
the token file /home/you/.pirate/auth_token is mode 0644. The required mode is 0600. Run `chmod 600 /home/you/.pirate/auth_token`
```

pirate reads the group bits and the other bits of the mode. A mode that gives no access to the
group and to other users passes. The owner of the path must be the user that runs pirate. A
path of another user can hold a token that this user did not write.

A session lasts 12 hours. The server holds 64 live sessions at most, and a restart of the
server ends every session. A wrong token spends one attempt of a bucket of 20 attempts, and
the bucket refills at 5 attempts each second. A correct token spends no attempt, so a flood of
guesses never locks the operator out.

## `--no-password`

`--no-password`, or `-n`, removes the token gate. pirate then reads no token file and writes
none. Every request that passes the `Origin` test and the `Host` test reaches the shell.

CAUTION: Do not use `--no-password` on a bind address that is not loopback. Every host that
can reach the port then gets a shell.

pirate prints this line for that case:

```
pirate: CAUTION: Drop --no-password, or bind to loopback. The bind address 0.0.0.0 gives a shell to every host that can reach this port.
```

## `--hostname`

A comparison of `Origin` with `Host` alone proves nothing about the server. An attacker can
own a DNS name that resolves to the address of pirate. The browser then writes that name into
both headers, the two headers agree, and a same-origin test passes. This is DNS rebinding.

`--hostname` names the hosts that this server answers to, and that list is what makes the two
headers disagree. A request with any other name in `Host` gets 403, on `POST /auth` and on the
WebSocket upgrade.

If you reach pirate by a name, run pirate with `--hostname <NAME>`. Repeat the flag for each
further name. `PIRATE_HOSTNAME` sets one name too.

An IP address and `localhost` always work and need no entry. A page that carries an IP address
as its origin already reached pirate at that address, so that name cannot move. The comparison
ignores case, a trailing dot, and the brackets of an IPv6 address.

On a bind address that is not loopback, with an empty list, pirate prints this line:

```
pirate: CAUTION: Add --hostname <NAME> for the name that you type in the browser. Without it pirate answers to an IP address only, and a request that carries any other name is refused.
```

A `Host` header that pirate does not answer to gives this line, one time for the life of the
process:

```
pirate: a request carried a Host header that pirate does not answer to. If you reach pirate by a name, add --hostname <NAME>.
```

## Every flag

| Flag | Short | Default | Result |
|---|---|---|---|
| `--bind <IP>` | none | `127.0.0.1` | The address to bind. `PIRATE_BIND` sets it too. |
| `--port <PORT>` | none | `8080` | The port to listen on. `PIRATE_PORT` sets it too. |
| `--assets-dir <DIR>` | none | the assets in the binary | Serves the web assets from this directory. `PIRATE_ASSETS_DIR` sets it too. |
| `--shell <PATH>` | none | `$SHELL`, or `/bin/bash` when `$SHELL` is empty or is not set | The program that each connection starts. |
| `--cert <FILE>` | `-c` | none | The certificate chain, in PEM. It needs `--key`. |
| `--key <FILE>` | `-k` | none | The private key of `--cert`, in PEM. It needs `--cert`. |
| `--selfsigned` | `-s` | none | Generates a certificate at startup. |
| `--plaintext` | none | none | Serves plain HTTP. |
| `--no-password` | `-n` | none | Serves with no authentication. |
| `--hostname <NAME>` | none | empty | A name that the browser uses to reach pirate. Repeat the flag for more names. `PIRATE_HOSTNAME` sets it too. |
| `--version` | `-V` | none | Shows the version, then exits. |
| `--long` | none | none | With `--version`, shows every pinned input of the build. |
| `--help` | `-h` | none | Shows the help, then exits. |

`pirate --version --long` prints the version, the git commit, the Ghostty commit, the Zig
version, the ghostty-web version, and the SHA-256 of the wasm module.

`--assets-dir` points at the output of Vite. The web client then reloads with no Rust rebuild.
A path that is not a directory stops the server with `--assets-dir <DIR> is not a directory`.

## The menu

The menu sits in the top right corner of the page. It holds the session status and the
controls. The `−` and `+` control collapses and expands it. The menu has three states: open,
collapsed, and hidden. The body of the menu holds three groups: `theme`, `terminal`, and
`keys`.

## The keybindings

| Action | Default chord | Shown as |
|---|---|---|
| show or hide the menu | `alt+keyh` | `alt+h` |
| increase the font size | `alt+equal` | `alt+=` |
| decrease the font size | `alt+minus` | `alt+-` |

A chord comes from `KeyboardEvent.code` and never from `KeyboardEvent.key`. On macOS, Option
and H give the character `˙`, and Option and `=` give `≠`. The code stays `KeyH` and `Equal` on
every platform and every keyboard layout.

The bindings use Alt and not Cmd. On macOS, Cmd+H is Hide Application, and that keystroke never
reaches the page. In every browser, Cmd or Ctrl with minus or equals is page zoom, and a page
cannot cancel it. Neither the operating system nor the browser reserves Alt.

To rebind a chord, do these three steps:

1. Open the menu.
2. Click the button of the binding, in the `keys` group.
3. Press the new chord.

Note: The new chord must hold Alt, Control, or Meta. A chord without one of these modifiers
takes a plain key away from the shell. The menu refuses that chord with the line `Hold Alt,
Control, or Meta with the key.`

Note: The Escape key cancels the capture. The menu refuses a chord that another binding holds,
with the line `Another binding holds that chord.`

A matched chord never reaches the shell. The client sends no bytes for it.

## The theme

Two slots hold two themes, dark and light. The `mode` row of the `theme` group selects the
slot. pirate reads a theme from an `.itermcolors` file, which is the theme format of iTerm2.

To import a theme, do these three steps:

1. Open the menu.
2. Click `choose file`, in the `theme` group.
3. Choose an `.itermcolors` file.

Note: The theme goes to the slot that matches the luminance of its own background. A light
scheme becomes the light theme, and a dark scheme becomes the dark theme.

Note: The menu, the login form, the page background, and the terminal take the new colors at
once. The client needs no page reload, and the shell keeps running.

A theme change builds the terminal again, and the server sends the screen back. The scrollback
of the old terminal is gone after a theme change.

Note: The terminal needs the connection for this step. If the connection is down, the menu
shows the line `The terminal takes the new colors with the next shell.`

A file that is not a valid `.itermcolors` file gives the line `The file is not a valid
.itermcolors file. Choose another file.` A file that has no color for a required key gives a
line that names that key.

## The preferences

One cookie, `pirate.prefs`, holds every preference: the theme of each slot, the active slot,
the font size, the key repeat rate, the chords, and the state of the menu. The cookie carries
`path=/`, `max-age=31536000`, and `samesite=lax`. A page on https adds `secure`.

The cookie never holds the token, in any form.

| Preference | Range | Default |
|---|---|---|
| font size | 8 to 32 pixels | 14 |
| key repeat rate | 2 to 30 keys per second | 10 |

The client suppresses the key repeat of the operating system and generates its own. The rate
and the first delay of the operating system differ on every machine, and the client needs a
fixed contract. The first repeat comes 600 ms after the press. The operator changes the rate in
the menu and cannot change that delay.

A record that does not fit in the cookie stays in memory for the session, and the menu reports
the fault. A value that fails a test takes its default, and the store writes the corrected
record back.

## License

pirate is under the MIT License. [LICENSE](LICENSE) holds the text, and the copyright line
reads `Copyright (c) 2026 Oscar Frasier`.

[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) holds the licenses of the dependencies.
