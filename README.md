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

`--selfsigned` builds a certificate for `127.0.0.1`, the address that pirate binds,
`localhost`, the name of this machine, and the wildcard of that name. An unspecified bind
address such as `0.0.0.0` adds no IP name, because it names no one machine. The private key
stays in memory, so a restart gives a new certificate. Nothing signed the certificate, so the
browser shows a warning. pirate prints the names of the certificate and its SHA-256
fingerprint:

```
pirate: this certificate covers localhost, 127.0.0.1, ::1, oscars-macbook-pro.local, oscars-macbook-pro, *.oscars-macbook-pro.local
pirate: nothing signed this certificate, so the browser will show a warning.
pirate: compare this fingerprint with the one in that warning:
pirate: <FINGERPRINT>
```

Make sure that this fingerprint agrees with the fingerprint in the warning of the browser.

Note: A machine name that a certificate name cannot carry is dropped. The certificate then
covers the three loopback names only, and the server still starts. pirate prints this line:

```
pirate: CAUTION: A certificate name cannot carry the name of this machine, <NAME>. This certificate covers the loopback names only.
```

With `--cert` and `--key`, pirate prints the same line. pirate reads those names back from the
certificate that it serves, so the line states the true names of the certificate:

```
pirate: this certificate covers pirate.example, *.wild.example, 127.0.0.1, ::1
```

A leaf certificate that pirate cannot read stops the server:

```
pirate cannot read the names of the certificate: <REASON>. pirate reports the names of every certificate that it serves, so it must read them
```

A supplied certificate that carries no subject alternative name still gets served. A browser
refuses a certificate with no name for the URL, so pirate warns and falls back to the
self-signed certificate for every name:

```
pirate: CAUTION: The supplied certificate carries no subject alternative name. Browsers refuse this certificate for every name. pirate serves the self-signed certificate for any name that does not match this certificate.
```

CAUTION: Do not use `--plaintext` on a network that you do not trust. The token, every
keystroke, and every byte of the screen cross the network in the clear.

pirate prints this line for every `--plaintext` run:

```
pirate: CAUTION: Use --selfsigned or --cert to encrypt the transport. --plaintext sends every keystroke and every byte of the screen in the clear.
```

On a bind address that is not loopback, with no TLS, pirate prints this line too:

```
pirate: CAUTION: Use --selfsigned or --cert on this bind address. Plain HTTP puts the token on the network in the clear.
```

The same condition prints a second line. pirate never compares `Host` against any name, in any
mode. A DNS name that an attacker owns, and that resolves to this address, reaches pirate just
the same:

```
pirate: CAUTION: Use --selfsigned or --cert on this bind address. Plain HTTP names no server, so pirate answers to every name in the Host header. A DNS name that an attacker owns then reaches this port.
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
server ends every session.

## The limits of the server

| Limit | Value | What happens at the limit |
|---|---|---|
| Live sessions | 64 | The session that ends first is dropped. |
| Terminal size | 2000 columns by 2000 rows | A larger request is clamped. The terminal still works. |
| The TLS handshake | 10 seconds | pirate drops the connection. |

Under TLS, pirate offers `http/1.1` and no other protocol. A client that offers `h2` alone
gets `no_application_protocol` and no connection.

## `--no-password`

`--no-password`, or `-n`, removes the token gate. pirate then reads no token file and writes
none. Every request that passes the `Origin` check reaches the shell.

CAUTION: Do not use `--no-password` on a bind address that is not loopback. Every host that
can reach the port then gets a shell.

CAUTION: Do not use `--no-password` together with `--plaintext`. An attacker who can reach the
port then gets a shell with no token.

An attacker can own a DNS name that resolves to the address of pirate. Under plain HTTP that
name passes the `Origin` check, because the browser writes the same name into `Origin` and
`Host`. The browser of the operator then opens a shell for the page of the attacker.

## The certificate and the browser

pirate never compares the `Host` header against the names in a certificate. TLS serves a
certificate and completes the handshake. The browser then compares the certificate names with
the URL, and it shows a warning when they do not agree. pirate makes no claim of its own about
which name a request must carry.

`--selfsigned` builds a certificate for `127.0.0.1`, the address that pirate binds,
`localhost`, the name of this machine, and the wildcard of that name. An unspecified bind
address such as `0.0.0.0` adds no IP name.

With `--cert`, pirate serves the certificate that the operator supplied. When the SNI of a
connection does not match that certificate, pirate serves the self-signed certificate instead.
The handshake always completes. A name that neither certificate covers gets a browser warning,
and not a closed connection.

DNS rebinding stays a live risk. An attacker can own a DNS name that resolves to the address of
pirate. The browser writes that name into both `Origin` and `Host`, so the two headers agree.
The check that compares `Origin` with `Host` still rejects a cross-origin request, on
`POST /auth` and on the WebSocket upgrade. It proves nothing about which name reached the
certificate. Under TLS, a matching certificate name is the defense against this. Serve `--cert`
with a certificate that covers only the names that pirate must answer to.

pirate refuses a request that carries more than one `Host` header, and a request that carries
more than one `Origin` header. The `Origin` must also agree with the `Host`.

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
