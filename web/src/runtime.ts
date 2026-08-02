/**
 * The handles that a feature module needs from `src/main.ts`.
 *
 * `main.ts` stays wiring. Each feature lives in its own module and gets this
 * record from one `install` call. A feature module therefore never edits
 * `main.ts`, and two features never collide in one file.
 */

import type { Terminal } from "ghostty-web";
import type { Mode } from "./prefs";

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
  /** The terminal of ghostty-web. */
  term: Terminal;
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
}
