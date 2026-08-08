# pirate

pirate is a terminal emulator proxy, like gotty or ttyd. The wasm VT engine comes from ghostty-web. The terminal emulator and web server are wrapped in one (optionally static) binary.

## Features

- A full xterm256-color terminal
- Authentication, see `$HOME/.pirate/auth_token`
- TLS by default, with a self-signed certificate that pirate generates at startup
- iTerm2-compatible theming

## Quickstart

pirate builds from source. Install [mise](https://mise.jdx.dev) first, then build pirate:

```
mise trust
mise install
cargo xtask build
```

By default, pirate serves TLS on every bind address, the loopback address included. The default port is 10433. With the `--plaintext` flag, pirate serves plain HTTP on port 8080 instead.

Run the server:

```
./target/debug/pirate
```

This yields:

```
pirate: serving <N> embedded assets
pirate: token file <PATH>
pirate: shell <SHELL>
pirate: this certificate covers <NAMES>
pirate: nothing signed this certificate, so the browser will show a warning.
pirate: compare this fingerprint with the one in that warning:
pirate: <FINGERPRINT>
pirate: listening on https://127.0.0.1:10433
```

Open that URL in a browser. Enter the token from the file as the password. On the first visit, the browser shows a certificate warning. Compare the fingerprint in the terminal output with the one in the warning.

## License

MIT
