import "./style.css";
import { installFont, installLineHeight } from "./font";
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
import { GridRenderer } from "./render";
import type { Runtime } from "./runtime";
import { installSelection, selectionInstalls } from "./select";
import { PirateTerminal } from "./terminal";
import { installTheme } from "./theme";
import { loadVt, type VtCell, type VtTerminal } from "./vt";
import {
  decodeExitStatus,
  encodeDumpRequest,
  encodeInput,
  encodeResize,
  SERVER_DUMP,
  SERVER_EXIT,
  SERVER_OUTPUT,
} from "./protocol";

/**
 * The wait after the last resize event, before pirate sends a resize frame.
 *
 * Measurement, `web/bench/resize-storm.spec.ts`, fast drag: 100 ms gave a
 * settle of 111 ms median and 175 ms p95, and 50 ms gave 59 ms and 59 ms.
 *
 * The fast drag of that bench steps every 40 ms, the shortest step that
 * `setViewportSize` holds. A debounce under that step stops the coalesce of
 * the bench, so `resize-storm.spec.ts` cannot measure this value. A drag of
 * the window frame steps every 16 ms at 60 Hz, which stays under 20 ms, so a
 * real drag still coalesces. Read `web/bench/whole-path.e2e.ts` for the
 * settle of this value.
 */
const RESIZE_DEBOUNCE_MS = 20;
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
  /** The line height, as a multiplier of the cell height of the font metric. */
  lineHeight: number;
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

  // The registry attaches before the terminal attaches its own handler, so the
  // capture listener of the registry runs first. A matched chord then never
  // reaches the terminal.
  startKeys(stored.keys, (next) => {
    setPrefs({ keys: next });
  });
  setAction("toggleMenu", toggleMenu);
  // `installFont` gives `fontIncrease` and `fontDecrease` their action.
  initMenu();

  const container = document.getElementById("terminal")!;

  /**
   * The line height of the moment, behind the accessor pair of `state`.
   *
   * `src/font.ts` writes `state.lineHeight` and calls no renderer method, so
   * the setter below carries the value to the renderer. The font size takes
   * another path: it goes through `term.options.fontSize` of
   * `src/terminal.ts`, which the facade owns.
   */
  let lineHeight = stored.lineHeight;

  /**
   * The renderer, from the moment `GridRenderer.create` returns.
   *
   * The setter of `state.lineHeight` runs before that moment if a caller
   * writes in the await window of `create`. A read of the `const grid`
   * binding in that window throws a `ReferenceError`, because the binding is
   * in its temporal dead zone. This name is undefined there instead, so the
   * setter reaches no method in the window. The call site of `create` carries
   * a write of the window to the atlas.
   */
  let renderer: GridRenderer | undefined;

  const state: ClientState = {
    connections: 0,
    connected: false,
    exitStatus: null,
    resizeDebounceMs: RESIZE_DEBOUNCE_MS,
    fontSize: stored.fontSize,
    // A write reaches the renderer at once. The record keeps the value, so a
    // reader gets back what it wrote. A write of the value that the record
    // already holds rasterizes no atlas.
    get lineHeight() {
      return lineHeight;
    },
    set lineHeight(next: number) {
      if (next === lineHeight) {
        return;
      }
      lineHeight = next;
      renderer?.setLineHeight(next);
    },
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
  //
  // Three objects hold the terminal. Two of them live for the whole page, and
  // one of them is rebuilt on every theme change.
  //
  // `vtTerm` is the VT100 state machine. The client creates ONE of these and
  // never frees it. `ghostty_terminal_free` of ghostty-vt.wasm 0.4.0 corrupts
  // the heap of the module: a freed grid that held a grapheme cluster traps the
  // next grid of the same width, and after any free a later `resize` that grows
  // a row out of the scrollback reads stale bytes. Measurement: an 80 by 24
  // terminal driven through 400 resizes after a free gave 720 garbage cells,
  // and the same path with no free stayed clean over 402 resizes.
  //
  // `grid` is the WebGL2 renderer. It takes a theme at any time through
  // `setTheme`, so a theme change needs no new renderer and no new canvas.
  //
  // `term` is the facade of `src/terminal.ts`. A theme change builds a NEW
  // facade around the SAME `vtTerm` and the SAME `grid`. The identity of the
  // facade is what `tests/theme.spec.ts` measures, and the session survives
  // because the state machine below it never moves.
  const vt = await loadVt();
  const startLineHeight = lineHeight;
  const grid = await GridRenderer.create(container, {
    fontSize: stored.fontSize,
    lineHeight: startLineHeight,
    theme: stored[stored.mode],
  });
  renderer = grid;
  // `create` reads its argument at the call, and `renderer` is undefined until
  // the line above. A write to `state.lineHeight` in the await window of
  // `create` therefore reaches neither the argument nor the setter. This
  // compare carries such a write to the atlas, so the state and the pixels
  // agree at the end of the window. No caller writes in the window today: the
  // record that holds the setter reaches `src/font.ts` through `installFont`,
  // which runs later in this function.
  if (lineHeight !== startLineHeight) {
    grid.setLineHeight(lineHeight);
  }
  const firstFit = grid.fit();
  const vtTerm: VtTerminal = vt.createTerminal(firstFit.cols, firstFit.rows);

  // `term` holds the facade of the moment. Every reader goes through this name
  // and captures no object.
  let term!: PirateTerminal;
  /** The test adapter of the facade of the moment. `buildBridge` builds it. */
  let bridge: ReturnType<typeof buildBridge>;

  // The facade encodes each key with the key encoder of libghostty and gives
  // the bytes as text. The same path carries the answer to a device status
  // report, which the PTY also expects.
  const encoder = new TextEncoder();

  /**
   * Build the facade with `theme`, and put the theme on the renderer.
   *
   * The old facade stops first. It cancels its animation frame loop, removes
   * its key listener, and removes its text field. It frees no VT terminal and
   * no renderer.
   */
  function buildTerminal(theme: ThemeRecord): void {
    term?.dispose();
    grid.setTheme(theme);
    term = new PirateTerminal({
      container,
      vt: vtTerm,
      renderer: grid,
      fontSize: state.fontSize,
      theme,
    });
    term.onData((data: string) => {
      send(encodeInput(encoder.encode(data)));
    });
    bridge = buildBridge(term);
    // A new facade carries no custom key handler, so the corrected chords of
    // `src/input.ts` need this call again.
    attachKeyCorrection(runtime, selection);
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
    const dims = grid.fit();
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
   * Build the facade again, with `theme`, and refill the screen from the
   * server.
   *
   * A theme change takes this path. The socket stays open and the shell keeps
   * running, so the operator loses no session. The screen comes back from the
   * server: the client `0x02` frame asks for a full-state dump, and the server
   * answers with the `0x01` frame that it also sends at open time.
   *
   * The VT terminal lives through this call, so the screen would keep every
   * cell that it already holds. The dump is a full-state dump and it carries
   * no clear of its own, so the client clears the screen before it asks for
   * one. Without that clear the dump lands on the old text, and one row of
   * "pirate" reads "piratepirate".
   *
   * The reset costs the scrollback, which is the cost that the old client paid
   * as well. With a closed socket no reset runs and the theme waits here, so
   * the screen of a dead shell stays on the terminal. `ws.onopen` applies the
   * theme that waits.
   */
  function rebuild(theme: ThemeRecord): void {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      // `send` drops a frame on a closed socket, in silence. A reset here would
      // clear the screen and no dump would come back to refill it. The worst
      // case is a shell that exited: `onclose` never reconnects after a server
      // `0x02` frame, so that blank screen would take the last output of that
      // shell away for good. Keep the screen and park the theme.
      pendingTheme = theme;
      setMenuNote(PENDING_THEME_LINE, "muted");
      return;
    }
    buildTerminal(theme);
    // The grid keeps its size through the rebuild, so `applyFit` finds the
    // same size and sends no resize frame. The call stays, because a theme
    // change and a container resize can land in the same frame.
    applyFit();
    // RIS, `ESC c`. The clear must come before the dump request, and these
    // three facts give the reason:
    //
    // 1. The client never frees a `VtTerminal`, so the terminal that held the
    //    old screen is the terminal that takes the dump.
    // 2. It never frees one because `ghostty_terminal_free` of
    //    ghostty-vt.wasm 0.4.0 corrupts the heap of the module. The comment at
    //    the top of this section holds the measurement.
    // 3. A state dump carries no clear of its own. It therefore writes its
    //    text on top of the text that the screen already holds, and one row of
    //    "pirate" then reads "piratepirate".
    //
    // The reset costs the scrollback. This is a known and accepted cost, not
    // an oversight: the old client built a new terminal for a theme change and
    // lost the scrollback the same way, so this restores that behavior and
    // invents none.
    //
    // The order is safe against a race. `term.reset` writes into the local
    // parser at once, and the dump bytes can arrive only in a later task,
    // because they need a round trip to the server. `tests/theme.spec.ts`
    // pins the result.
    term.reset();
    send(encodeDumpRequest());
  }

  // ── the feature modules ─────────────────────────────────────────────────
  // Each feature owns one module and gets its handles here. `main.ts` stays
  // wiring, and two features never collide in one file.
  //
  // `term` is a getter. A rebuild replaces the facade, and a module that
  // captured the object once would then hold a stopped facade.
  const runtime: Runtime = {
    get term(): PirateTerminal {
      return term;
    },
    container,
    state,
    refit: scheduleFit,
    rebuild,
  };

  // Mouse selection belongs to the renderer and to its canvas, and both live
  // for the whole page. `buildTerminal` gives a new facade on every theme
  // change, so an install inside that function would add a second set of
  // listeners on each change. This call runs once.
  //
  // The call comes before `buildTerminal`, because `buildTerminal` gives the
  // selection to `attachKeyCorrection` for the copy chord. The renderer built
  // the canvas above, and `installSelection` needs no facade.
  const selection = installSelection(grid, container);

  // The theme of the active slot. `installTheme` builds the facade again on
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
  installLineHeight(runtime);
  installInput(runtime, selection);

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
        // its own. `src/terminal.ts` paints from an unconditional animation
        // frame loop, so the quiet that follows a dump still gets a frame.
        // `tests/dump.spec.ts` measures this.
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

  // ── the test bridge ─────────────────────────────────────────────────────
  //
  // CAUTION: The adapter below exists for `web/tests/harness.ts` and
  // `web/bench/instrument.ts` alone. It has the shape of the xterm.js buffer
  // API, and no product code reads it. `src/terminal.ts` is the product
  // surface, and it holds no buffer API and no addon API. Do not call this
  // adapter from a feature module.
  //
  // The tests assert on terminal state, never on glyph pixels, because font
  // rasterization varies by machine.

  /** The text of one cell, for `getChars` of the adapter. */
  function charsOf(cell: VtCell, x: number, y: number, viewport: boolean): string {
    if (cell.width === 0) {
      // The second half of a wide character holds no text of its own.
      return "";
    }
    if (viewport && cell.graphemeLength > 0) {
      return vtTerm.getGraphemeString(x, y);
    }
    return cell.codepoint === 0 ? "" : String.fromCodePoint(cell.codepoint);
  }

  /** Wrap one row of cells in the line shape that the harness reads. */
  function lineOf(cells: VtCell[], row: number, viewport: boolean) {
    return {
      translateToString(trim = false): string {
        let text = "";
        for (let x = 0; x < cells.length; x += 1) {
          const chars = charsOf(cells[x], x, row, viewport);
          // An untouched cell reads as a blank inside a line of text.
          text += chars === "" && cells[x].width !== 0 ? " " : chars;
        }
        return trim ? text.replace(/\s+$/, "") : text;
      },
      getCell(x: number) {
        const cell = cells[x];
        return cell === undefined
          ? undefined
          : { getChars: (): string => charsOf(cell, x, row, viewport) };
      },
    };
  }

  /**
   * The buffer adapter.
   *
   * This is a function declaration, not a `const`. `buildTerminal` runs before
   * this point in the file, and it reaches the adapter through `buildBridge`.
   * A `const` would be in its temporal dead zone at that moment.
   */
  function bufferAdapter() {
    return {
      /**
       * The scrollback first, then the viewport.
       *
       * The viewport row `y` is therefore at index `length - rows + y`.
       */
      get active() {
        const scrollback = vtTerm.getScrollbackLength();
        return {
          get cursorX(): number {
            return vtTerm.getCursor().x;
          },
          get cursorY(): number {
            return vtTerm.getCursor().y;
          },
          length: scrollback + vtTerm.rows,
          getLine(index: number) {
            if (index < 0) {
              return undefined;
            }
            if (index < scrollback) {
              const cells = vtTerm.getScrollbackLine(index);
              return cells === null ? undefined : lineOf(cells, index, false);
            }
            const row = index - scrollback;
            const cells = vtTerm.getLine(row);
            return cells === null ? undefined : lineOf(cells, row, true);
          },
        };
      },
    };
  }

  /**
   * Build the adapter of one facade.
   *
   * The object is stable for the life of its facade. `web/bench/instrument.ts`
   * wraps `write` and `renderer.render` by assignment, so both must stay on one
   * object. `tests/theme.spec.ts` reads the identity of this object to measure
   * a theme change, so a rebuild must give a NEW one.
   */
  function buildBridge(facade: PirateTerminal) {
    return {
      get cols(): number {
        return facade.cols;
      },
      get rows(): number {
        return facade.rows;
      },
      get buffer() {
        return bufferAdapter();
      },
      renderer: grid,
      options: facade.options,
      get animationFrameId(): number | undefined {
        return facade.animationFrameId;
      },
      // `write` forwards the assignment to the facade, so a wrapper that a
      // caller puts here also sees the writes that `onFrame` makes.
      // `web/bench/instrument.ts` needs that.
      get write(): (data: Uint8Array | string) => void {
        return facade.write;
      },
      set write(next: (data: Uint8Array | string) => void) {
        facade.write = next;
      },
      reset(): void {
        facade.reset();
      },
      dispose(): void {
        facade.dispose();
      },
    };
  }

  // `term` is a getter here too. A rebuild replaces the facade, and a value
  // captured once would give every later test a stopped facade.
  (globalThis as Record<string, unknown>).__pirate = {
    get term() {
      return bridge;
    },
    state,
    // The selection lives for the whole page, so this is a value and not a
    // getter. `installs` reports how many times `installSelection` ran.
    selection: {
      hasSelection: (): boolean => selection.hasSelection(),
      text: (): string => selection.text(),
      clear: (): void => {
        selection.clear();
      },
      get installs(): number {
        return selectionInstalls();
      },
    },
  };

  connect();
}

main().catch((e: unknown) => {
  report(`failed to start: ${e instanceof Error ? e.message : String(e)}`, "error");
  throw e;
});
