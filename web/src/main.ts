import { FitAddon, init, Terminal } from "ghostty-web";
import "./style.css";
import { installFont } from "./font";
import { installInput } from "./input";
import { chords, setAction, startKeys } from "./keys";
import { requireSession, sessionLost } from "./login";
import {
  initMenu,
  menuState,
  setFitHandler,
  setMenuStatus,
  type StatusState,
  toggleMenu,
} from "./menu";
import { prefs, setPrefs } from "./prefs";
import type { Runtime } from "./runtime";
import { installTheme } from "./theme";
import {
  decodeExitStatus,
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
  const term = new Terminal({
    fontSize: stored.fontSize,
    // The theme of the active slot. `installTheme` sets it again on every
    // later change, and it also sets the `--pirate-*` custom properties.
    theme: stored[stored.mode],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

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

  // ── input ───────────────────────────────────────────────────────────────
  // ghostty-web attaches its own InputHandler to the container and encodes
  // each key with the KeyEncoder of libghostty. onData gives the encoded
  // bytes, so pirate needs no key table of its own. The same event carries
  // the answer to a device status report, which the PTY also expects.
  const encoder = new TextEncoder();
  term.onData((data: string) => {
    send(encodeInput(encoder.encode(data)));
  });

  // ── resize ──────────────────────────────────────────────────────────────
  let resizeTimer: number | undefined;

  function applyFit(): void {
    const dims = fit.proposeDimensions();
    if (dims === undefined) {
      return;
    }
    if (dims.cols === term.cols && dims.rows === term.rows) {
      return;
    }
    term.resize(dims.cols, dims.rows);
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

  const observer = new ResizeObserver(scheduleFit);
  observer.observe(container);
  applyFit();

  // A change of the cell size needs a new fit. `setFitHandler` gives the menu
  // this debounced fit, and `requestFit` of `src/menu.ts` calls it. One change
  // then gives one resize frame, on the same debounce as a window drag.
  setFitHandler(scheduleFit);

  // ── the feature modules ─────────────────────────────────────────────────
  // Each feature owns one module and gets its handles here. `main.ts` stays
  // wiring, and two features never collide in one file.
  const runtime: Runtime = { term, container, state, refit: scheduleFit };
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
      // The server sizes the PTY from this frame, so send it before input.
      send(encodeResize(term.cols, term.rows));
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
  (globalThis as Record<string, unknown>).__pirate = { term, state };

  connect();
}

main().catch((e: unknown) => {
  report(`failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
  throw e;
});
