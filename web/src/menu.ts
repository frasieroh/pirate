/**
 * The menu, in the top right corner of the viewport.
 *
 * The menu is out of the layout flow. `src/style.css` holds the reason: a
 * panel inside the flex flow of `body` changes the height of `#terminal`, the
 * fit runs again, and the client sends a second resize frame for one window
 * size. This module changes no box of `#terminal`.
 *
 * The header holds the session status and the collapse control. The body holds
 * the rows. `addMenuRow` is the seam for the other modules: a module that owns
 * a control adds its row and never touches the layout of this file.
 */

import { cancelCapture, captureChord, chordLabel, chords } from "./keys";
import {
  BINDING_IDS,
  type BindingId,
  type MenuState,
  onPrefsFault,
  prefs,
  prefsFault,
  setPrefs,
} from "./prefs";

/** The state of the session line. */
export type StatusState = "ok" | "warn" | "error";

/**
 * The tone of one line of the menu.
 *
 * `warn` is for a fault, in `#menu-note`. `muted` is for a normal result, in
 * `#menu-hint`.
 */
export type NoteTone = "warn" | "muted";

/** One row of the menu body. */
export interface MenuRow {
  /**
   * The heading of the group.
   *
   * Rows with one heading sit together, in the order of the calls.
   *
   * This field is required, and that is the fix for a real defect. The field
   * was optional before, and a row without a group went straight into
   * `#menu-body`, above the keys group. The heading of the group before it
   * then governed that row on the screen: `font size` and `key repeat rate`
   * both sat under the `theme` heading. A required field ends the class of
   * fault. A row cannot reach the screen without the heading that governs it.
   */
  group: string;
  /** The text on the left of the row. */
  label: string;
  /** The controls on the right of the row, in order. */
  controls: HTMLElement[];
}

/** The label of each chord button. */
const KEY_LABELS: Record<BindingId, string> = {
  toggleMenu: "show or hide the menu",
  fontIncrease: "increase the font size",
  fontDecrease: "decrease the font size",
};

/** The text of the collapse control while the menu is open. */
const MINUS = "−";
/** The text of the collapse control while the menu is collapsed. */
const PLUS = "+";
/** The text of a chord button that waits for a chord. */
const PRESS_A_CHORD = "press a chord";

const panel = document.getElementById("menu")!;
const statusLine = document.getElementById("menu-status")!;
const control = document.getElementById("menu-toggle")!;
const body = document.getElementById("menu-body")!;

/** The state that `toggleMenu` comes back to. */
let lastVisible: MenuState = "open";

/** The groups that `addMenuRow` built, by heading. */
const groups = new Map<string, HTMLElement>();

/** The chord button of each binding. */
const chordButtons = new Map<BindingId, HTMLButtonElement>();

/* ── SEAM(font) ──────────────────────────────────────────────────────────────
   `src/main.ts` owns the fit and its debounce. It calls `setFitHandler` one
   time, with the debounced fit. A module that changes the size of a cell, such
   as the font size, calls `requestFit` after the change. The fit then runs on
   the same debounce as a window drag, and the client sends one resize frame
   for one change. */

/** The debounced fit of `src/main.ts`. */
let fitHandler: () => void = (): void => {};

/** Give the menu the debounced fit. `src/main.ts` calls this one time. */
export function setFitHandler(fit: () => void): void {
  fitHandler = fit;
}

/** Ask for a fit, after a change of the size of a cell. */
export function requestFit(): void {
  fitHandler();
}

/* ── end SEAM(font) ──────────────────────────────────────────────────────── */

/** Build one row. The label is on the left and the controls are on the right. */
function buildRow(label: string, controls: HTMLElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "menu-row";
  const text = document.createElement("span");
  text.className = "menu-label";
  text.textContent = label;
  const box = document.createElement("span");
  box.className = "menu-controls";
  box.append(...controls);
  row.append(text, box);
  return row;
}

/** Build one group, with its heading. */
function buildGroup(heading: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "menu-group";
  const title = document.createElement("h2");
  title.className = "menu-heading";
  title.textContent = heading;
  group.append(title);
  return group;
}

/* The three headings of the menu body, in the order that they show.
   `src/theme.ts`, `src/font.ts`, and `src/input.ts` import the first two, so
   one name reaches the screen for one group. The order comes from the order
   of the calls in `src/main.ts`: theme, font, input. The keys group is last,
   because a chord list is reference material and not a daily control. */

/** The heading of the colors of the terminal. */
export const THEME_GROUP = "theme";
/** The heading of the settings of the terminal itself. */
export const TERMINAL_GROUP = "terminal";
/** The heading of the chord list. */
export const KEYS_GROUP = "keys";

/** The keys group. It stays at the end of the body. */
const keysGroup = buildGroup(KEYS_GROUP);
keysGroup.id = "menu-keys";
// The keys group goes in the map too. A module that adds a row under this
// heading then joins this group, and the menu keeps one `keys` heading.
groups.set(KEYS_GROUP, keysGroup);

/** The one line for a refused chord and for a fault of the store. */
const note = document.createElement("p");
note.id = "menu-note";

/**
 * The one line for a normal result.
 *
 * This line is separate from `#menu-note`, and the reason is a contract, not
 * a preference. `#menu-note` is the fault channel: `tests/prefs.spec.ts` and
 * `tests/menu.spec.ts` read it, and both read an empty `#menu-note` as "the
 * menu shows no fault". A normal line in that element would report a fault
 * that did not happen. Both files are read-only in this wave.
 */
const hint = document.createElement("p");
hint.id = "menu-hint";

body.append(keysGroup, note, hint);

// The stored state goes on the panel at module load. The operator then never
// sees the menu in one state and a moment later in another.
applyState(prefs().menu);

/**
 * Add a row to the menu.
 *
 * This is the seam for the theme worker and for the font worker. Each row
 * declares the heading that governs it. A new group goes above the keys
 * group, in the order of the calls, so no worker changes the layout of this
 * file. A second row with the same heading joins the group of the first one.
 * The caller owns its controls and their events.
 *
 * Returns the row element.
 */
export function addMenuRow(row: MenuRow): HTMLElement {
  const element = buildRow(row.label, row.controls);
  let group = groups.get(row.group);
  if (group === undefined) {
    group = buildGroup(row.group);
    groups.set(row.group, group);
    body.insertBefore(group, keysGroup);
  }
  group.append(element);
  return element;
}

/**
 * Show one short line under the rows. An empty line leaves the screen.
 *
 * The tone selects the line and the color. `warn` is the default, and it
 * writes `#menu-note`, the fault channel: a refused chord, a failed write of
 * the store, a file that does not parse. `muted` writes `#menu-hint`, for a
 * normal result. A fault and a normal result then never overwrite each
 * other, and each one leaves the screen on its own empty string.
 */
export function setMenuNote(text: string, tone: NoteTone = "warn"): void {
  const line = tone === "warn" ? note : hint;
  line.textContent = text;
}

/** The state of the menu. */
export function menuState(): MenuState {
  return (panel.dataset.state as MenuState | undefined) ?? "open";
}

/** Put the menu in `next`. This writes nothing to the store. */
function applyState(next: MenuState): void {
  panel.dataset.state = next;
  control.textContent = next === "collapsed" ? PLUS : MINUS;
  control.setAttribute("aria-label", next === "collapsed" ? "open the menu" : "collapse the menu");
  if (next !== "hidden") {
    lastVisible = next;
  }
}

/** Put the menu in `next` and store the new state. */
export function setMenuState(next: MenuState): void {
  applyState(next);
  setPrefs({ menu: next });
}

/**
 * Take the menu off the screen, or bring it back.
 *
 * This is the action of the `toggleMenu` binding. The menu comes back to the
 * state that it held before, open or collapsed.
 */
export function toggleMenu(): void {
  setMenuState(menuState() === "hidden" ? lastVisible : "hidden");
}

/** The session status, in the header of the menu. */
export function setMenuStatus(text: string, state: StatusState = "ok"): void {
  statusLine.textContent = text;
  statusLine.dataset.state = state;
}

/** Write the current chord on each chord button. */
function showChords(): void {
  const current = chords();
  for (const [id, button] of chordButtons) {
    button.textContent = chordLabel(current[id]);
  }
}

/** Take the next chord for the binding `id`. */
function startCapture(id: BindingId): void {
  // End the capture that runs. Its callback puts its own button back, and the
  // note of the last refusal then goes away with the line below.
  cancelCapture();
  setMenuNote("");
  const button = chordButtons.get(id)!;
  button.dataset.capture = "on";
  button.textContent = PRESS_A_CHORD;
  captureChord(id, (result) => {
    delete button.dataset.capture;
    showChords();
    if (result.status === "refused") {
      setMenuNote(result.reason);
    }
  });
}

/** Build the three chord buttons, in the order of the bindings. */
for (const id of BINDING_IDS) {
  const button = document.createElement("button");
  button.id = `key-${id}`;
  button.type = "button";
  button.addEventListener("click", () => {
    startCapture(id);
  });
  chordButtons.set(id, button);
  keysGroup.append(buildRow(KEY_LABELS[id], [button]));
}

/**
 * Wire the menu and put it in the stored state.
 *
 * `src/main.ts` calls this one time, after the operator holds a session.
 */
export function initMenu(): void {
  control.addEventListener("click", () => {
    setMenuState(menuState() === "collapsed" ? "open" : "collapsed");
  });
  showChords();
  const fault = prefsFault();
  if (fault !== null) {
    setMenuNote(fault);
  }
  // The check above sees only a fault that happened before this call, at
  // page load. A write can also fail later, from any later change. This
  // callback shows that later fault too, the moment it happens.
  onPrefsFault((line) => {
    if (line !== null) {
      setMenuNote(line);
    }
  });
}
