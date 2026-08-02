import { FitAddon, init, Terminal } from "ghostty-web";
import "./style.css";
import { installFont } from "./font";
import { attachKeyCorrection, installInput } from "./input";
import { chords, setAction, startKeys } from "./keys";
import { requireSession, sessionLost } from "./login";
import {
  initMenu,
  menuState,
  setFitHandler,
  setMenuNote,
  setMenuStatus,
  type StatusState,
  toggleMenu,
} from "./menu";
import { prefs, setPrefs, type ThemeRecord } from "./prefs";
import type { Runtime } from "./runtime";
import { installTheme } from "./theme";
import {
  decodeExitStatus,
  encodeDumpRequest,
  encodeInput,
  encodeResize,
  SERVER_DUMP,
  SERVER_EXIT,
  SERVER_OUTPUT,
} from "./protocol";

/** The wait after the last resize event, before pirate sends a resize frame. */
const RESIZE_DEBOUNCE_MS = 100;
/** The first reconnect wait. Each further attempt doubles it. */
const RECONNECT_MIN_MS = 250;
/** The largest reconnect wait. */
const RECONNECT_MAX_MS = 5000;
/**
 * The wait before the first repeat of a held key, in milliseconds.
 *
 * The client generates its own key repeat, so this delay is a fixed contract
 * and not a setting of the operating system. `src/input.ts` reads it from
 * `state.repeatDelayMs`. The operator cannot change it.
 */
const REPEAT_DELAY_MS = 600;
/**
 * The muted line for a theme change that found no open socket.
 *
 * The line is true for both cases that reach it: a shell that exited, and a
 * reconnect that runs. In both cases the colors of the terminal arrive with
 * the next shell. The line names no page reload, because a reload is never the
 * remedy here.
 */
const PENDING_THEME_LINE = "The terminal takes the new colors with the next shell.";

/** The session status. It goes to the header of the menu. */
function report(text: string, state: StatusState = "ok"): void {
  setMenuStatus(text, state);
}

/**
 * The address of the WebSocket, on the origin of the page.
 *
 * The host and the port are configurable, so both come from `location`. The
 * scheme comes from the scheme of the page, because a page on https cannot
 * open a plain ws socket.
 */
function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

/** The values that the browser tests read. */
interface ClientState {
  /** The count of sockets that reached the open state. */
  connections: number;
  /** True while a socket is open. */
  connected: boolean;
  /** The status of a `0x02` frame, or null when no process has exited. */
  exitStatus: number | null;
  /** The debounce of the resize observer, in milliseconds. */
  resizeDebounceMs: number;
  /** The font size of the terminal, in pixels. */
  fontSize: number;
  /** The key repeat rate, in keys per second. */
  repeatRate: number;
  /** The wait before the first repeat, in milliseconds. */
  repeatDelayMs: number;
  /** The theme slot that is active. */
  mode: "dark" | "light";
  /** The name of the theme of the active slot. */
  themeName: string;
  /** The state of the menu. */
  menu: "open" | "collapsed" | "hidden";
  /** The chord of each binding. */
  keys: Record<string, string>;
}

async function main(): Promise<void> {
  // The wasm load and the terminal must not run while the operator is at the
  // login box.
  await requireSession();

  const stored = prefs();

  // The registry attaches before ghostty-web attaches its own handler, so the
  // capture listener of the registry runs first. A matched chord then never
  // reaches the terminal.
  startKeys(stored.keys, (next) => {
    setPrefs({ keys: next });
  });
  setAction("toggleMenu", toggleMenu);
  // `installFont` gives `fontIncrease` and `fontDecrease` their action.
  initMenu();

  // init() loads the wasm module. ghostty-web 0.4.0 inlines it as a data URI
  // inside its ESM file, so this needs no separate asset request.
  await init();

  const container = document.getElementById("terminal")!;

  const state: ClientState = {
    connections: 0,
    connected: false,
    exitStatus: null,
    resizeDebounceMs: RESIZE_DEBOUNCE_MS,
    fontSize: stored.fontSize,
    repeatRate: stored.repeatRate,
    repeatDelayMs: REPEAT_DELAY_MS,
    mode: stored.mode,
    themeName: stored[stored.mode].name,
    // The menu and the registry own these two values, so both are getters. A
    // reader of `state` then gets the value of the moment.
    get menu() {
      return menuState();
    },
    get keys() {
      return chords();
    },
  };

  let socket: WebSocket | undefined;
  let attempt = 0;
  // True after a `0x02` frame. Each client owns one PTY, so a reconnect after
  // an exit starts another shell. Stop instead, and let the user decide.
  let finished = false;

  // `Uint8Array<ArrayBuffer>` and not the wider `Uint8Array`, because
  // `WebSocket.send` rejects a view on a SharedArrayBuffer.
  function send(frame: Uint8Array<ArrayBuffer>): void {
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
    }
  }

  // ── the terminal ────────────────────────────────────────────────────────
  // A theme change builds the terminal again, so these two names hold the
  // terminal of the moment. Every reader goes through them and captures
  // neither object.
  let term!: Terminal;
  let fit!: FitAddon;

  // ghostty-web attaches its own InputHandler to the container and encodes
  // each key with the KeyEncoder of libghostty. onData gives the encoded
  // bytes, so pirate needs no key table of its own. The same event carries
  // the answer to a device status report, which the PTY also expects.
  const encoder = new TextEncoder();

  /**
   * Build the terminal with `theme` and open it on the container.
   *
   * ghostty-web 0.4.0 bakes the cell colors into the wasm terminal at `open()`
   * time, so the theme of the constructor is the theme of the screen. This
   * function is therefore the one place that colors the terminal, at the first
   * load and at every later theme change.
   */
  function buildTerminal(theme: ThemeRecord): void {
    term = new Terminal({ fontSize: state.fontSize, theme });
    // The addon holds one terminal, and `term.dispose` disposes it, so each
    // terminal gets its own fit addon.
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    term.onData((data: string) => {
      send(encodeInput(encoder.encode(data)));
    });
    // A new terminal carries no custom key handler, so the seven corrected
    // chords of `src/input.ts` need this call again.
    attachKeyCorrection(runtime);
  }

  // ── resize ──────────────────────────────────────────────────────────────
  let resizeTimer: number | undefined;
  /**
   * The last size that the client SENT, in a `0x01` frame.
   *
   * This is not a guarantee about the server. `applyFit` writes both values
   * before it calls `send`, and `send` drops the frame when no socket is open.
   * A dropped frame therefore leaves these two values ahead of the server.
   * `ws.onopen` rewrites both from the terminal on every open, and it sends
   * that size, so no drift survives a reconnect.
   *
   * The local terminal and the server can also differ, because a new terminal
   * starts at the default size and the server keeps the size of the old one.
   * A frame goes out for a difference against these two values, never against
   * `term.cols` and `term.rows`. A theme change therefore sends no frame.
   * Section 4.1 rule 3 of `docs/program-status.md` holds the requirement.
   */
  let sentCols = 0;
  let sentRows = 0;

  function applyFit(): void {
    const dims = fit.proposeDimensions();
    if (dims === undefined) {
      return;
    }
    if (dims.cols !== term.cols || dims.rows !== term.rows) {
      term.resize(dims.cols, dims.rows);
    }
    if (dims.cols === sentCols && dims.rows === sentRows) {
      return;
    }
    sentCols = dims.cols;
    sentRows = dims.rows;
    send(encodeResize(dims.cols, dims.rows));
  }

  // A window drag emits one resize event for each frame of the drag. The
  // debounce holds the socket quiet until the drag stops.
  function scheduleFit(): void {
    if (resizeTimer !== undefined) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = window.setTimeout(applyFit, RESIZE_DEBOUNCE_MS);
  }

  // ── the rebuild ─────────────────────────────────────────────────────────
  /**
   * The theme that waits for an open socket, or undefined when none waits.
   *
   * A rebuild needs the server, so a theme change with a closed socket keeps
   * the old terminal and parks its theme here. `ws.onopen` takes it.
   */
  let pendingTheme: ThemeRecord | undefined;

  /**
   * Build the terminal again, with `theme`, and refill it from the server.
   *
   * A theme change takes this path. The socket stays open and the shell keeps
   * running, so the operator loses no session. The screen comes back from the
   * server: the client `0x02` frame asks for a full-state dump, and the server
   * answers with the `0x01` frame that it also sends at open time.
   *
   * The dump is the only source for the screen of the new terminal, so this
   * function needs an open socket. With a closed socket it disposes nothing.
   * The caller knows nothing about the socket, and it needs to know nothing:
   * the theme waits here and `ws.onopen` applies it.
   *
   * The scrollback of the old terminal goes with the old terminal. The dump
   * carries the screen alone, so a theme change costs the scrollback.
   */
  function rebuild(theme: ThemeRecord): void {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      // `send` drops a frame on a closed socket, in silence. A rebuild here
      // would dispose the terminal, get no dump, and leave a blank screen with
      // no way back. The worst case is a shell that exited: `onclose` never
      // reconnects after a server `0x02` frame, so that blank screen would take
      // the last output of that shell away for good. Keep the terminal.
      pendingTheme = theme;
      setMenuNote(PENDING_THEME_LINE, "muted");
      return;
    }
    term.dispose();
    // `dispose` calls `cleanupComponents`, which removes the canvas and the
    // hidden textarea from the container: a read of
    // `node_modules/ghostty-web/dist/ghostty-web.js` confirms both removals.
    // The same read shows one fault of ghostty-web 0.4.0: `open()` registers
    // `handleMouseUp` on the document, `dispose` sets `isOpen` to false BEFORE
    // it calls `cleanupComponents`, and `cleanupComponents` removes that
    // listener only while `isOpen` is true. The listener therefore stays, and
    // it holds the dead terminal, its canvas, its renderer, and its wasm
    // handle for the life of the page. One theme change adds one. The call
    // below removes it. The guard keeps a later ghostty-web usable, one that
    // cleans the listener up itself or that renames the property.
    const mouseUp = (term as unknown as { handleMouseUp?: EventListener }).handleMouseUp;
    if (typeof mouseUp === "function") {
      document.removeEventListener("mouseup", mouseUp);
    }
    // The loop below is the guard for a canvas that a failed `open` left
    // behind. A second canvas in `#terminal` would paint over the new one.
    for (const canvas of Array.from(container.querySelectorAll("canvas"))) {
      canvas.remove();
    }
    buildTerminal(theme);
    // A new terminal starts at the default size. `applyFit` gives it the size
    // of the container, and it sends a resize frame only when that size
    // differs from the last size that the client sent.
    applyFit();
    send(encodeDumpRequest());
  }

  // ── the feature modules ─────────────────────────────────────────────────
  // Each feature owns one module and gets its handles here. `main.ts` stays
  // wiring, and two features never collide in one file.
  //
  // `term` is a getter. A rebuild replaces the terminal, and a module that
  // captured the object once would then hold a dead terminal.
  const runtime: Runtime = {
    get term(): Terminal {
      return term;
    },
    container,
    state,
    refit: scheduleFit,
    rebuild,
  };

  // The theme of the active slot. `installTheme` builds the terminal again on
  // every later change, and it also sets the `--pirate-*` custom properties.
  buildTerminal(stored[stored.mode]);

  const observer = new ResizeObserver(scheduleFit);
  observer.observe(container);
  applyFit();

  // A change of the cell size needs a new fit. `setFitHandler` gives the menu
  // this debounced fit, and `requestFit` of `src/menu.ts` calls it. One change
  // then gives one resize frame, on the same debounce as a window drag.
  setFitHandler(scheduleFit);

  installTheme(runtime);
  installFont(runtime);
  installInput(runtime);

  // ── frames ──────────────────────────────────────────────────────────────
  function onFrame(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) {
      return;
    }
    const frame = new Uint8Array(data);
    if (frame.length === 0) {
      return;
    }
    const payload = frame.subarray(1);
    switch (frame[0]) {
      case SERVER_OUTPUT:
      case SERVER_DUMP:
        // A dump is more bytes on the same stream, so it needs no decoder of
        // its own. ghostty-web paints from an unconditional
        // requestAnimationFrame loop, so the quiet that follows a dump still
        // gets a frame. `tests/dump.spec.ts` measures this.
        term.write(payload);
        break;
      case SERVER_EXIT: {
        const code = decodeExitStatus(payload);
        state.exitStatus = code;
        finished = true;
        report(
          `the process exited with status ${code}. Reload the page for a new shell.`,
          code === 0 ? "ok" : "error",
        );
        break;
      }
      default:
        // An unknown tag comes from a newer server. Ignore it and stay usable.
        break;
    }
  }

  // ── connection ──────────────────────────────────────────────────────────
  function connect(): void {
    const ws = new WebSocket(socketUrl());
    ws.binaryType = "arraybuffer";
    socket = ws;
    report("connecting", "warn");

    ws.onopen = (): void => {
      attempt = 0;
      state.connections += 1;
      state.connected = true;
      if (state.connections > 1) {
        // Each client owns one PTY, and the server sends SIGHUP when the
        // socket closes. A new socket is therefore a new shell. Clear the
        // screen, so that no text of the dead shell stays on it.
        term.reset();
        report(`pirate connected to a new shell. Shell ${state.connections - 1} ended.`, "warn");
      } else {
        report("connected");
      }
      // The server sizes the PTY from this frame, so send it before input. A
      // new socket is a new terminal on the server, and that terminal knows no
      // size, so this frame always goes out. It also sets the size that the
      // server knows, which `applyFit` compares against.
      sentCols = term.cols;
      sentRows = term.rows;
      send(encodeResize(term.cols, term.rows));
      // A theme change on a closed socket parked its theme. The socket is open
      // now, so the rebuild gets the dump that refills the new terminal. This
      // runs after the resize frame, so the server sizes the PTY first.
      const waiting = pendingTheme;
      if (waiting !== undefined) {
        rebuild(waiting);
        pendingTheme = undefined;
        setMenuNote("", "muted");
      }
    };

    ws.onmessage = (event: MessageEvent): void => {
      onFrame(event.data);
    };

    ws.onclose = (): void => {
      socket = undefined;
      state.connected = false;
      if (finished) {
        return;
      }
      // A close carries no status to a script, so the cause of the close is
      // unknown here. Ask `/auth`. An expired session then shows the login box
      // instead of an endless reconnect that cannot succeed. This adds one
      // request for each reconnect attempt. The backoff bounds it, and the
      // backoff reaches 5 s, so it is at most one request every 5 s per tab.
      // The answer is never cached, because a cached answer is the failure
      // that this call corrects.
      void sessionLost().then((again: boolean) => {
        if (again) {
          attempt = 0;
          connect();
          return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
        attempt += 1;
        report(
          `disconnected. The shell ended with the connection. ` +
            `pirate starts a new shell in ${(delay / 1000).toFixed(1)} s.`,
          "warn",
        );
        window.setTimeout(connect, delay);
      });
    };

    ws.onerror = (): void => {
      // A failed socket always fires close as well. Reconnect from there.
    };
  }

  // Expose the terminal for the Playwright tests. They assert on terminal
  // state, never on glyph pixels, because font rasterization varies by machine.
  //
  // `term` is a getter here too. A rebuild replaces the terminal, and a value
  // captured once would give every later test a dead terminal.
  (globalThis as Record<string, unknown>).__pirate = {
    get term(): Terminal {
      return term;
    },
    state,
  };

  connect();
}

main().catch((e: unknown) => {
  report(`failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
  throw e;
});
