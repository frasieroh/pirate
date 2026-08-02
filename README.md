# pirate

pirate is a terminal emulator proxy. The server runs a shell in a PTY on the host machine, and a browser renders that shell.

The browser loads the web client of pirate. That client runs `ghostty-web`, a WebAssembly build of the Ghostty VT parser, and it draws the terminal on a canvas. The client sends every keystroke to the server over a WebSocket, and the server writes it into the PTY.

A release binary holds the web client, so one file is the whole server.

## Features

- A full terminal in the browser. No client software to install.
- One release binary. It holds the server and the web client.
- Login with a token from a file, not a password that you choose.
- TLS with a self-signed certificate, or with a certificate and key that you supply.
- An in-browser menu for the theme, the keybindings, and other terminal preferences.

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

pirate prints what it is doing, then the URL:

```
pirate: serving <N> embedded assets
pirate: token file <PATH>
pirate: shell <SHELL>
pirate: listening on http://127.0.0.1:8080
```

Open that URL in a browser. Enter the token from the file as the password. Press enter.

For every flag, run `pirate --help`.

## License

pirate is under the MIT License. See [LICENSE](LICENSE) for the text.
