# pirate

pirate is a terminal emulator proxy, like gotty or ttyd. It's based on ghostty-web. The terminal emulator and web server are wrapped in one (optionally static) binary.

## Features

- A full xterm256-color terminal
- Authentication, see `$HOME/.pirate/auth_token`
- HTTPS/TLS support
- iTerm2-compatible theming

## Quickstart

pirate builds from source. Install [mise](https://mise.jdx.dev) first, then build pirate:

```
mise trust
mise install
cargo xtask build
```

Run the server:

```
./target/debug/pirate
```

This yields:

```
pirate: serving <N> embedded assets
pirate: token file <PATH>
pirate: shell <SHELL>
pirate: listening on http://127.0.0.1:8080
```

Open that URL in a browser. Enter the token from the file as the password.

## License

MIT
