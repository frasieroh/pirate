/**
 * The handles that a feature module needs from `src/main.ts`.
 *
 * `main.ts` stays wiring. Each feature lives in its own module and gets this
 * record from one `install` call. A feature module therefore never edits
 * `main.ts`, and two features never collide in one file.
 */

import type { Mode, ThemeRecord } from "./prefs";
import type { PirateTerminal } from "./terminal";

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
   * The terminal facade of `src/terminal.ts`.
   *
   * This member is a getter in `main.ts`. `rebuild` replaces the facade, so a
   * module that captured the object once would hold a stopped facade after a
   * theme change. Read `runtime.term` at each use.
   */
  readonly term: PirateTerminal;
  /** The element that holds the canvas. The facade listens on it. */
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
   * Build the terminal facade again, with `theme`, and refill it from the
   * server.
   *
   * The renderer takes a theme at any time, so the colors need no new facade.
   * The new facade is the signal that the client rebuilt: `tests/theme.spec.ts`
   * reads the identity of `__pirate.term` to measure a theme change.
   *
   * The VT terminal and the renderer live through this call. `main.ts` states
   * the reason: the client never frees a `VtTerminal`.
   *
   * The argument is a `ThemeRecord` of `src/prefs.ts`, so this file needs no
   * import of `src/theme.ts`.
   */
  rebuild: (theme: ThemeRecord) => void;
}
