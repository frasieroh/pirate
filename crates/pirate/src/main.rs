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

#[derive(Parser, Debug)]
// clap cannot express `--version --long` with its own version flag, because
// that flag stops the parse. Therefore pirate declares both flags itself.
#[command(name = "pirate", version, about, long_about = None, disable_version_flag = true)]
// One transport per run. The group makes clap reject two of these three flags
// together, so main.rs reads them in a fixed order and never has to rank them.
#[command(group = clap::ArgGroup::new("tls")
    .multiple(false)
    .args(["cert", "selfsigned", "plaintext"]))]
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

    /// Port to listen on.
    #[arg(long, env = "PIRATE_PORT", default_value_t = 8080)]
    port: u16,

    /// Serve the web assets from this directory instead of from the binary.
    /// Point it at the Vite output to get hot reload with no Rust rebuild.
    #[arg(long, env = "PIRATE_ASSETS_DIR")]
    assets_dir: Option<PathBuf>,

    /// The program that each connection starts. The default is $SHELL, and
    /// /bin/bash when $SHELL is empty.
    #[arg(long)]
    shell: Option<PathBuf>,

    /// Serve TLS with this certificate chain, in PEM. Give --key with it.
    #[arg(long, short = 'c', requires = "key")]
    cert: Option<PathBuf>,

    /// The private key for --cert, in PEM. Give --cert with it.
    ///
    // CAUTION: Keep `conflicts_with_all` on this argument. `key` is not a
    // member of the `tls` group, and clap treats a `requires` target as
    // satisfied when that target conflicts with an argument that is present.
    // Without this list, `--key FILE --plaintext` started the server on plain
    // HTTP and dropped the key of the operator without a word.
    #[arg(
        long,
        short = 'k',
        requires = "cert",
        conflicts_with_all = ["selfsigned", "plaintext"]
    )]
    key: Option<PathBuf>,

    /// Generate a self-signed certificate at startup. The browser then shows a
    /// warning, and pirate prints the fingerprint to compare.
    #[arg(long, short = 's')]
    selfsigned: bool,

    /// Serve plain HTTP. CAUTION: every keystroke crosses the network in the
    /// clear.
    #[arg(long)]
    plaintext: bool,

    /// Serve with no authentication. CAUTION: every host that can reach the
    /// port then gets a shell.
    #[arg(long, short = 'n')]
    no_password: bool,

    /// A name that you type in the browser to reach pirate. Repeat the flag
    /// for more than one name. An IP address and `localhost` always work.
    // No short flag. `-h` is the help flag of clap, and every other letter of
    // this word is already taken.
    #[arg(long, env = "PIRATE_HOSTNAME")]
    hostname: Vec<String>,
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

    let source = transport(&args)?;
    if args.plaintext {
        eprintln!(
            "pirate: CAUTION: Use --selfsigned or --cert to encrypt the transport. \
             --plaintext sends every keystroke and every byte of the screen in the clear."
        );
    }

    let tls = match &source {
        Some(source) => Some(pirate::tls::build(source)?),
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

    let hosts = pirate::auth::HostAllow::new(args.hostname.clone());

    let state = Arc::new(AppState {
        assets_dir: args.assets_dir,
        shell,
        auth,
        tls: tls.is_some(),
        hosts,
    });

    let addr = SocketAddr::new(args.bind, args.port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let addr = listener.local_addr()?;

    if let (Some(TlsSource::SelfSigned), Some(tls)) = (&source, &tls) {
        eprintln!("pirate: nothing signed this certificate, so the browser will show a warning.");
        eprintln!("pirate: compare this fingerprint with the one in that warning:");
        eprintln!("pirate: {}", tls.fingerprint);
    }

    let scheme = if tls.is_some() { "https" } else { "http" };
    eprintln!("pirate: listening on {scheme}://{addr}");

    if !args.bind.is_loopback() {
        if args.no_password {
            eprintln!(
                "pirate: CAUTION: Drop --no-password, or bind to loopback. The bind address {} \
                 gives a shell to every host that can reach this port.",
                args.bind
            );
        } else if tls.is_none() {
            eprintln!(
                "pirate: CAUTION: Use --selfsigned or --cert on this bind address. \
                 Plain HTTP puts the token on the network in the clear."
            );
        }
        // The diagnosis line for a 403 that the operator cannot explain. The
        // browser sends the typed name in `Host`, and pirate refuses a name
        // that it does not answer to.
        if args.hostname.is_empty() {
            eprintln!(
                "pirate: CAUTION: Add --hostname <NAME> for the name that you type in the \
                 browser. Without it pirate answers to an IP address only, and a request that \
                 carries any other name is refused."
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
/// clap already rejects two of the three flags together, so the order of the
/// tests here changes no result.
fn transport(args: &Args) -> Result<Option<TlsSource>, Box<dyn std::error::Error>> {
    if let (Some(cert), Some(key)) = (&args.cert, &args.key) {
        return Ok(Some(TlsSource::Files {
            cert: cert.clone(),
            key: key.clone(),
        }));
    }
    if args.selfsigned {
        return Ok(Some(TlsSource::SelfSigned));
    }
    if args.plaintext {
        return Ok(None);
    }
    // A browser treats `http://localhost` as a trustworthy origin, and the
    // bytes reach no network card. Loopback therefore needs no certificate and
    // no flag. Every other address crosses a network, so the operator must name
    // the transport and cannot get plain HTTP by accident.
    if loopback(args.bind) {
        return Ok(None);
    }
    Err(format!(
        "the bind address {} is not loopback, so pirate needs a transport. \
         Use --cert with --key, or --selfsigned, or --plaintext.",
        args.bind
    )
    .into())
}

/// True when `address` reaches this machine only.
///
/// `Ipv6Addr::is_loopback` is true for `::1` and for nothing else, so the
/// IPv4-mapped form `::ffff:127.0.0.1` fails that test although the socket it
/// gives accepts from 127.0.0.1 only. This function unmaps first, so the two
/// spellings of one address get one answer.
///
/// Only [`transport`] uses this. The CAUTION lines keep the plain test, because
/// that test errs toward printing a warning on a mapped address, and more
/// warnings is the safe direction.
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
