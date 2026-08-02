/**
 * The handles that a feature module needs from `src/main.ts`.
 *
 * `main.ts` stays wiring. Each feature lives in its own module and gets this
 * record from one `install` call. A feature module therefore never edits
 * `main.ts`, and two features never collide in one file.
 */

import type { Terminal } from "ghostty-web";
import type { Mode, ThemeRecord } from "./prefs";

/** The mutable values that the browser tests read on `__pirate.state`. */
export interface RuntimeState {
  fontSize: number;
  repeatRate: number;
  repeatDelayMs: number;
  mode: Mode;
  themeName: string;
}

/** The record that `main.ts` gives to each feature module. */
export interface Runtime {
  /**
   * The terminal of ghostty-web.
   *
   * This member is a getter in `main.ts`. `rebuild` replaces the terminal, so
   * a module that captured the object once would hold a dead terminal after a
   * theme change. Read `runtime.term` at each use.
   */
  readonly term: Terminal;
  /** The element that holds the canvas. ghostty-web listens on it. */
  container: HTMLElement;
  /** The state record of `main.ts`. A feature writes its own fields. */
  state: RuntimeState;
  /**
   * Fit the terminal to the container, on the resize debounce.
   *
   * A change of the cell size needs a new fit. This function is the same
   * debounced path that a window drag uses, so one change gives one resize
   * frame.
   */
  refit: () => void;
  /**
   * Build the terminal again, with `theme`, and refill it from the server.
   *
   * ghostty-web 0.4.0 bakes the cell colors into the wasm terminal at `open()`
   * time, so only the constructor honors a theme. A new terminal is therefore
   * the one way to change the colors of the screen. The socket stays open and
   * the shell keeps running: `main.ts` asks the server for a full-state dump
   * with a `0x02` frame, and the dump refills the new terminal.
   *
   * The argument is a `ThemeRecord` of `src/prefs.ts`, so this file needs no
   * import of `src/theme.ts`.
   */
  rebuild: (theme: ThemeRecord) => void;
}
