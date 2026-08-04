/**
 * One real pirate process for one end-to-end test.
 *
 * The unit suite in `web/tests` drives a stub server that runs inside the test
 * process. This module starts the compiled binary instead, over TLS, with its
 * own `HOME`. Every layer that the operator meets is therefore the real one:
 * the certificate, the token file, the session cookie, the WebSocket, and the
 * PTY.
 *
 * Each test starts its own process and stops it in a `finally`. No state
 * crosses a test boundary, so one failure cannot change the next result.
 *
 * This module never sleeps for a fixed time. It waits for the line that the
 * server prints when the listener is up, with a deadline.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";

/** The compiled binary. `cargo xtask build` writes it. */
const BINARY = path.resolve(import.meta.dir, "../../target/debug/pirate");

/** The client that `vite build` writes. `--assets-dir` points at it. */
const ASSETS = path.resolve(import.meta.dir, "../dist");

/** The wait for the listening line of the server, in milliseconds. */
const START_TIMEOUT_MS = 20_000;

/** The wait for the process to end after `stop` sends the signal. */
const STOP_TIMEOUT_MS = 5000;

/** The poll interval of every wait in this file, in milliseconds. */
const POLL_MS = 25;

/**
 * The line that the recorder shell prints when it is ready for input.
 *
 * A test waits for this line before it presses a key. The reason is in
 * `RECORDER_SHELL`.
 */
export const RECORDER_READY = "recorder ready";

/**
 * The shell that records every byte that the client sends.
 *
 * The input tests assert on the screen, so every byte that the browser sends
 * must reach the screen. `stty` turns off the echo and the line discipline, so
 * `cat` gets each byte as it arrives. `cat -vt` then paints every control byte
 * as a caret escape, and a tab as `^I`.
 *
 * `stty` leaves the output flags alone, so the terminal still turns the line
 * feed of `cat` into a carriage return and a line feed. Each chord therefore
 * lands on a line of its own.
 *
 * Two lines of this script differ from the first draft, and a measurement gave
 * the reason for each one. Both measurements are in `web/e2e/pirate.e2e.ts`,
 * under the input test.
 */
const RECORDER_SHELL = `#!/bin/sh
# The e2e input tests need every byte that the client sends to appear on the
# screen. \`stty\` turns off the echo and the line discipline, so \`cat\` gets each
# byte as it arrives, and \`cat -vt\` paints every control byte as a caret escape.
#
# \`-icrnl\` is here because the line discipline turns an input carriage return
# into a line feed by default. With that conversion, Ctrl+M and Ctrl+J reach
# \`cat\` as the same byte, and the screen cannot tell the two chords apart.
stty -echo -icanon -icrnl -iexten -isig -ixon min 1 time 0
# The command above needs a few milliseconds. Until it returns, the terminal
# still echoes and still buffers a line, so a byte that arrives in that window
# reaches the screen twice: once from the echo, and once from \`cat\`. This
# marker tells the test that the shell takes input now.
printf '${RECORDER_READY}\\n'
exec cat -vt
`;

/** One running pirate process, as a test drives it. */
export interface Pirate {
  /** The origin of the server, for `page.goto`. */
  readonly url: string;
  /** The port that the kernel gave to `--port 0`. */
  readonly port: number;
  /** The temporary directory that the process got as `HOME`. */
  readonly home: string;
  /** The token of the token file, without the trailing newline. */
  readonly token: string;
  /** The path of the token file, under `home`. */
  readonly tokenPath: string;
  /** The SHA-256 fingerprint of the self-signed certificate. */
  readonly fingerprint: string;
  /** Everything that the process wrote to stderr so far. */
  stderr(): string;
  /** Everything that the process wrote to stdout so far. */
  stdout(): string;
  /** True after the process ended. */
  readonly exited: boolean;
  /** Kill the process and remove the temporary directory. */
  stop(): Promise<void>;
}

/** The options of `startPirate`. */
export interface PirateOptions {
  /**
   * Write the recorder shell into `HOME` and start it for each connection.
   *
   * A test that asserts on the bytes of a keystroke needs this shell.
   */
  recorder?: boolean;
  /** The program of `--shell`. It wins over `recorder`. */
  shell?: string;
}

/** The internal record of one live process. The cleanup hooks read it. */
interface Live {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  home: string;
}

/**
 * Every process that this module started and did not stop.
 *
 * A failed test, an exception in a helper, or a Ctrl+C at the terminal all
 * leave the process and the temporary directory behind. The hooks below remove
 * both, so no test run leaks a shell or a directory.
 */
const live = new Set<Live>();
let hooksInstalled = false;

/** Kill every live process and remove every temporary directory, at once. */
function cleanupAll(): void {
  for (const entry of live) {
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      // The process already ended. Nothing to kill.
    }
    try {
      fs.rmSync(entry.home, { recursive: true, force: true });
    } catch {
      // The directory is already gone.
    }
  }
  live.clear();
}

/**
 * Install the cleanup hooks once.
 *
 * `exit` runs synchronously and cannot await, so `cleanupAll` uses `SIGKILL`
 * and the synchronous remove. `SIGINT` needs the same work, and then the
 * default action of the signal.
 */
function installHooks(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  process.on("exit", cleanupAll);
  process.on("SIGINT", () => {
    cleanupAll();
    process.exit(130);
  });
}

/**
 * Write the recorder shell into `home` and return its path.
 *
 * The file needs the execute bit, because pirate runs it as the program of the
 * PTY.
 */
export function writeRecorderShell(home: string): string {
  const file = path.join(home, "recorder.sh");
  fs.writeFileSync(file, RECORDER_SHELL);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Read a stream to its end and give each chunk to `sink`. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  sink: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      sink(decoder.decode(chunk, { stream: true }));
    }
  } catch {
    // The pipe closed with the process. There is nothing more to read.
  }
}

/** Wait `POLL_MS` milliseconds between two reads of the captured output. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

/**
 * Start one pirate process and wait until it listens.
 *
 * The environment holds three variables and nothing else. `HOME` points at a
 * fresh temporary directory, so the token file of the operator stays untouched
 * and each test gets its own token. A clean environment also keeps the run
 * deterministic on a machine that carries `PIRATE_*` variables.
 */
export async function startPirate(options: PirateOptions = {}): Promise<Pirate> {
  installHooks();

  if (!fs.existsSync(BINARY)) {
    throw new Error(`no pirate binary at ${BINARY}. Build it with \`cargo xtask build\`.`);
  }
  if (!fs.existsSync(ASSETS)) {
    throw new Error(`no client at ${ASSETS}. Build it with \`bun run build\` in web.`);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pirate-e2e-"));
  const shell = options.shell ?? (options.recorder === true ? writeRecorderShell(home) : "/bin/sh");

  const proc = Bun.spawn(
    [
      BINARY,
      "--bind",
      "127.0.0.1",
      "--port",
      "0",
      "--assets-dir",
      ASSETS,
      "--shell",
      shell,
    ],
    {
      env: { HOME: home, PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const entry: Live = { proc, home };
  live.add(entry);

  let out = "";
  let err = "";
  // Both pipes drain without a pause. A full pipe blocks the writer, and a
  // blocked pirate never prints the listening line.
  void drain(proc.stdout, (text) => {
    out += text;
  });
  void drain(proc.stderr, (text) => {
    err += text;
  });

  let ended = false;
  void proc.exited.then(() => {
    ended = true;
  });

  // The listening line is the last line of the startup sequence, so the token
  // file and the certificate both exist when it appears.
  const listening = /pirate: listening on (https:\/\/127\.0\.0\.1:(\d+))/;
  const deadline = Date.now() + START_TIMEOUT_MS;
  let match = listening.exec(err);
  while (match === null) {
    if (ended) {
      live.delete(entry);
      fs.rmSync(home, { recursive: true, force: true });
      throw new Error(`pirate exited before it listened.\nstderr:\n${err}\nstdout:\n${out}`);
    }
    if (Date.now() > deadline) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      live.delete(entry);
      fs.rmSync(home, { recursive: true, force: true });
      throw new Error(
        `pirate did not listen within ${START_TIMEOUT_MS} ms.\nstderr:\n${err}\nstdout:\n${out}`,
      );
    }
    await tick();
    match = listening.exec(err);
  }

  const url = match[1];
  const port = Number(match[2]);

  const fingerprintLine = /pirate: compare this fingerprint[^\n]*\npirate: ([0-9A-Fa-f:]+)/.exec(
    err,
  );
  const fingerprint = fingerprintLine === null ? "" : fingerprintLine[1];

  const tokenPath = path.join(home, ".pirate", "auth_token");
  const token = fs.readFileSync(tokenPath, "utf8").trim();

  let stopped = false;

  return {
    url,
    port,
    home,
    token,
    tokenPath,
    fingerprint,
    stderr: () => err,
    stdout: () => out,
    get exited(): boolean {
      return ended;
    },
    async stop(): Promise<void> {
      // A test calls this in a `finally`, and a `finally` runs after a failed
      // assertion. A throw here would hide the real failure, so this function
      // reports nothing and swallows every error.
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // The process already ended.
      }
      const limit = Date.now() + STOP_TIMEOUT_MS;
      while (!ended && Date.now() < limit) {
        await tick();
      }
      if (!ended) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process ended between the check and the signal.
        }
      }
      live.delete(entry);
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // The directory is already gone.
      }
    },
  };
}
