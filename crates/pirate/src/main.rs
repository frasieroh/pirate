//! The pirate binary.
//!
//! This file holds the command line and the listener. Every other part is in
//! the library, so the integration tests can start the same server.

use clap::Parser;
use pirate::tls::TlsSource;
use pirate::{router, AppState};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

/// The pinned inputs of this build. `build.rs` collects every value.
///
/// The first question about a terminal fault is always which parser is in the
/// binary. These six lines answer it without a lookup in the repository.
const BUILD_INFO: [(&str, &str); 5] = [
    ("git commit", env!("PIRATE_GIT_SHA")),
    ("ghostty", env!("PIRATE_GHOSTTY_COMMIT")),
    ("zig", env!("PIRATE_ZIG_VERSION")),
    ("ghostty-web", env!("PIRATE_GHOSTTY_WEB_VERSION")),
    ("wasm sha256", env!("PIRATE_WASM_SHA256")),
];

/// The port of a run with no `--port` and no `PIRATE_PORT`, on TLS.
const TLS_PORT: u16 = 10433;

/// The port of a run with no `--port` and no `PIRATE_PORT`, on `--plaintext`.
const PLAINTEXT_PORT: u16 = 8080;

#[derive(Parser, Debug)]
// clap cannot express `--version --long` with its own version flag, because
// that flag stops the parse. Therefore pirate declares both flags itself.
#[command(name = "pirate", version, about, long_about = None, disable_version_flag = true)]
// One transport per run. The group makes clap reject these two flags together,
// so main.rs reads them in a fixed order and never has to rank them.
#[command(group = clap::ArgGroup::new("tls")
    .multiple(false)
    .args(["cert", "plaintext"]))]
struct Args {
    /// Show the version and exit. Add --long for every pinned input.
    #[arg(long, short = 'V')]
    version: bool,

    /// With --version, show every pinned input of this build.
    #[arg(long, requires = "version")]
    long: bool,

    /// Address to bind. The default keeps pirate on this machine.
    #[arg(long, env = "PIRATE_BIND", default_value = "127.0.0.1")]
    bind: IpAddr,

    /// Port to listen on. The default is 10433 on TLS, and 8080 on --plaintext.
    #[arg(long, env = "PIRATE_PORT")]
    port: Option<u16>,

    /// Serve the web assets from this directory instead of from the binary.
    /// Point it at the Vite output to get hot reload with no Rust rebuild.
    #[arg(long, env = "PIRATE_ASSETS_DIR")]
    assets_dir: Option<PathBuf>,

    /// The program that each connection starts. The default is $SHELL, and
    /// /bin/bash when $SHELL is empty.
    #[arg(long)]
    shell: Option<PathBuf>,

    /// Serve TLS with this certificate chain, in PEM. Give --key with it. With
    /// no --cert, pirate serves a self-signed certificate that it generates at
    /// startup.
    #[arg(long, short = 'c', requires = "key")]
    cert: Option<PathBuf>,

    /// The private key for --cert, in PEM. Give --cert with it.
    ///
    // `key` is not a member of the `tls` group, so `conflicts_with_all` is what
    // rejects `--key FILE --plaintext`. The test
    // `a_supplied_key_and_plaintext_cannot_run_together` holds that behavior.
    #[arg(
        long,
        short = 'k',
        requires = "cert",
        conflicts_with_all = ["plaintext"]
    )]
    key: Option<PathBuf>,

    /// Serve plain HTTP instead of TLS. Every keystroke then crosses the
    /// network in the clear.
    #[arg(long)]
    plaintext: bool,

    /// Serve with no authentication. Every host that can reach the port then
    /// gets a shell.
    #[arg(long, short = 'n')]
    no_password: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    if args.version {
        print_version(args.long);
        return Ok(());
    }

    if let Some(dir) = &args.assets_dir {
        if !dir.is_dir() {
            return Err(format!("--assets-dir {} is not a directory", dir.display()).into());
        }
        eprintln!("pirate: serving assets from {}", dir.display());
    } else {
        let count = pirate::assets::embedded_count();
        if count == 0 {
            return Err(
                "no embedded assets. Rebuild with `cargo xtask build`, or pass --assets-dir."
                    .into(),
            );
        }
        eprintln!("pirate: serving {count} embedded assets");
    }

    let source = transport(&args);

    // The default port follows the transport, so it resolves after it. `--port`
    // and `PIRATE_PORT` both fill `args.port`, and clap ranks those two.
    let port = args.port.unwrap_or(if source.is_some() {
        TLS_PORT
    } else {
        PLAINTEXT_PORT
    });

    // Bind BEFORE the build of the TLS configuration. `tls::build` puts the
    // real bound address into the generated certificate, and with `--port 0`
    // that address does not exist until the bind above resolves the port.
    let addr = SocketAddr::new(args.bind, port);
    // The error of `bind` names no address, and the port can come from a
    // default. This message states the address that the bind refused.
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("the bind to {addr} failed: {e}"))?;
    let addr = listener.local_addr()?;

    let tls = match &source {
        Some(source) => Some(pirate::tls::build(source, addr)?),
        None => None,
    };

    // The token never reaches stdout or stderr. Only the browser sees it, and
    // the operator reads it from the token file.
    let auth = if args.no_password {
        pirate::auth::Auth::disabled()
    } else {
        let path = pirate::auth::default_token_path()?;
        let token = pirate::auth::load_or_create(&path)?;
        eprintln!("pirate: token file {}", path.display());
        pirate::auth::Auth::enabled(token, tls.is_some())
    };

    let shell = args.shell.unwrap_or_else(pirate::session::default_shell);
    eprintln!("pirate: shell {}", shell.display());

    let state = Arc::new(AppState {
        assets_dir: args.assets_dir,
        shell,
        auth,
        tls: tls.is_some(),
    });

    // These are the names of the certificates. The browser matches the name
    // that the operator typed against this list, and pirate compares no name
    // itself; the browser alone judges the match.
    //
    // CAUTION: Every name here comes from `tls::certificate_names`, which
    // pirate READ BACK from the certificate that it serves. An earlier line
    // called the generator a second time and printed what the generator was
    // asked for, so a name that the certificate dropped still reached the
    // operator.
    //
    // With `--cert`, pirate can serve two certificates, so this block reports
    // both: the supplied certificate first, and the generated fallback that
    // pirate serves for a name the supplied certificate does not cover. With
    // no supplied certificate, pirate reports the generated certificate alone,
    // in the same words as before this fallback existed.
    if let Some(tls) = &tls {
        match &tls.supplied {
            None => {
                eprintln!(
                    "pirate: this certificate covers {}",
                    tls.selfsigned.names.join(", ")
                );
                eprintln!(
                    "pirate: nothing signed this certificate, so the browser will show a warning."
                );
                eprintln!("pirate: compare this fingerprint with the one in that warning:");
                eprintln!("pirate: {}", tls.selfsigned.fingerprint);
            }
            Some(supplied) => {
                eprintln!(
                    "pirate: the supplied certificate covers {}",
                    supplied.names.join(", ")
                );
                eprintln!(
                    "pirate: supplied certificate fingerprint: {}",
                    supplied.fingerprint
                );
                eprintln!(
                    "pirate: for every other name, pirate falls back to a self-signed \
                     certificate covering {}",
                    tls.selfsigned.names.join(", ")
                );
                eprintln!(
                    "pirate: nothing signed that certificate, so the browser will show a \
                     warning for it."
                );
                eprintln!("pirate: compare this fingerprint with the one in that warning:");
                eprintln!("pirate: {}", tls.selfsigned.fingerprint);
            }
        }
    }

    let scheme = if tls.is_some() { "https" } else { "http" };
    eprintln!("pirate: listening on {scheme}://{addr}");

    // These two lines report a choice that other hosts can reach. One line
    // reports the transport, and one line reports the authentication. A
    // loopback bind reaches no other host, so the gate keeps both lines off it.
    if !loopback(args.bind) {
        if tls.is_none() {
            eprintln!(
                "pirate: --plaintext on {} sends the token, every keystroke, and every byte \
                 of the screen in the clear.",
                args.bind
            );
        }
        if args.no_password {
            eprintln!(
                "pirate: --no-password on {} gives a shell to every host that can reach \
                 this port.",
                args.bind
            );
        }
    }

    // The two branches give `axum::serve` two listener types, and therefore two
    // types of server. A trait object cannot hold them, because the trait has
    // an associated type for the connection.
    match tls {
        Some(tls) => {
            axum::serve(
                pirate::tls::TlsListener::new(pirate::NoDelay(listener), tls.config),
                router(state),
            )
            .with_graceful_shutdown(shutdown())
            .await?;
        }
        None => {
            axum::serve(pirate::NoDelay(listener), router(state))
                .with_graceful_shutdown(shutdown())
                .await?;
        }
    }
    Ok(())
}

/// Pick the transport. `None` is plain HTTP.
///
/// clap already rejects the two flags together, so the order of the tests here
/// changes no result.
fn transport(args: &Args) -> Option<TlsSource> {
    if let (Some(cert), Some(key)) = (&args.cert, &args.key) {
        return Some(TlsSource::Files {
            cert: cert.clone(),
            key: key.clone(),
        });
    }
    if args.plaintext {
        return None;
    }
    // TLS is the default on every bind address, loopback included. The
    // generated certificate needs no file and no flag, so a run with no flag
    // never puts a keystroke on the network in the clear.
    Some(TlsSource::SelfSigned)
}

/// True when `address` reaches this machine only.
///
/// `Ipv6Addr::is_loopback` is true for `::1` and for nothing else, so the
/// IPv4-mapped form `::ffff:127.0.0.1` fails that test although the socket it
/// gives accepts from 127.0.0.1 only. This function unmaps first, so the two
/// spellings of one address get one answer.
fn loopback(address: IpAddr) -> bool {
    let address = match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
        v4 => v4,
    };
    address.is_loopback()
}

/// Print the version. The long form adds the five other pinned inputs.
fn print_version(long: bool) {
    println!("pirate {}", env!("CARGO_PKG_VERSION"));
    if !long {
        return;
    }
    for (name, value) in BUILD_INFO {
        println!("{name:<12} {value}");
    }
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    eprintln!("\npirate: shutting down");
}
