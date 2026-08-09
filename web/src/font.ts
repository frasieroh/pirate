/**
 * The font size control and the line height control.
 *
 * Both controls change the size of a cell, so both live in this module and
 * both end with the same debounced fit.
 *
 * The operator changes the size from two buttons in the menu and from two
 * hotkeys: `fontIncrease` and `fontDecrease` of `src/keys.ts`. A change of the
 * size changes the size of a cell, so the terminal must refit. `requestFit` of
 * `src/menu.ts` asks for that fit on the debounce that `src/main.ts` owns.
 * One change then gives one resize frame, on the same debounce as a window
 * drag.
 *
 * Startup: does a second write to `term.options.fontSize` run at startup?
 * No. `src/main.ts` builds the terminal with `fontSize: stored.fontSize`, so
 * the terminal already holds the stored size when `installFont` runs. It also
 * sets `state.fontSize` to `stored.fontSize` before it calls `installFont`. A
 * second write here would set `term.options.fontSize` to the value it
 * already holds. The setter of `ghostty-web` runs its font path only when the
 * new value differs from the old value, so a second write here would do
 * nothing and would add a line with no effect.
 *
 * Measurement: does a change of `term.options.fontSize` also fire the
 * `ResizeObserver` on `#terminal`? No. `#terminal` sits in a flex column with
 * `overflow: hidden`, and its box comes from the flex layout of `body`, not
 * from the size of its canvas child. A change of the font size changes the
 * pixel size of the canvas, inside `#terminal`, and that canvas grows or
 * shrinks inside the fixed box of its parent. It does not change the box of
 * `#terminal`. `tests/font.spec.ts` measures the frame count directly: one
 * change of the size gives one `0x01` frame, and three rapid changes give one
 * frame, the same count that a window drag gives. Because the fit runs on
 * one debounced path (`requestFit`), the result would hold even if the
 * observer did fire: a second call to the same debounced path inside the
 * debounce window coalesces into the one call that runs after it.
 */

import { setAction } from "./keys";
import { addMenuRow, requestFit, TERMINAL_GROUP } from "./menu";
import { setPrefs } from "./prefs";
import type { Runtime } from "./runtime";

/** The smallest line height, as a multiplier. */
const LINE_MIN = 1.0;
/** The largest line height, as a multiplier. */
const LINE_MAX = 2.0;
/** The change of one press, as a multiplier. */
const LINE_STEP = 0.1;
/** The count of decimals of a line height on the screen and in the store. */
const LINE_DECIMALS = 1;

/** The smallest font size, in pixels. */
const FONT_MIN = 8;
/** The largest font size, in pixels. */
const FONT_MAX = 32;
/** The change of one press, in pixels. */
const FONT_STEP = 1;

/** The text of the decrease button. It matches `#menu-toggle`. */
const MINUS = "−";
/** The text of the increase button. */
const PLUS = "+";

/**
 * Install the font size control.
 *
 * The function adds the font row to the menu, gives the two font bindings
 * their action, and applies the size of the preference store.
 */
export function installFont(runtime: Runtime): void {
  const decreaseButton = document.createElement("button");
  decreaseButton.id = "font-decrease";
  decreaseButton.type = "button";
  decreaseButton.textContent = MINUS;
  decreaseButton.setAttribute("aria-label", "decrease the font size");

  const valueLabel = document.createElement("span");
  valueLabel.id = "font-value";

  const increaseButton = document.createElement("button");
  increaseButton.id = "font-increase";
  increaseButton.type = "button";
  increaseButton.textContent = PLUS;
  increaseButton.setAttribute("aria-label", "increase the font size");

  /** Show the current size, and disable a button at its limit. */
  function render(): void {
    valueLabel.textContent = `${runtime.state.fontSize}`;
    decreaseButton.disabled = runtime.state.fontSize <= FONT_MIN;
    increaseButton.disabled = runtime.state.fontSize >= FONT_MAX;
  }

  /**
   * Put the terminal at size `next`, clamped to the range.
   *
   * A size equal to the current size does nothing: no write to the store,
   * and no request for a fit. Two presses at a limit must give one frame at
   * most, not a wasted one.
   */
  function setSize(next: number): void {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
    if (clamped === runtime.state.fontSize) {
      return;
    }
    runtime.state.fontSize = clamped;
    runtime.term.options.fontSize = clamped;
    render();
    setPrefs({ fontSize: clamped });
    requestFit();
  }

  decreaseButton.addEventListener("click", () => {
    setSize(runtime.state.fontSize - FONT_STEP);
    // A menu button that keeps the focus swallows the next keystroke of the
    // operator. Give the focus back to the terminal.
    runtime.term.focus();
  });
  increaseButton.addEventListener("click", () => {
    setSize(runtime.state.fontSize + FONT_STEP);
    runtime.term.focus();
  });

  setAction("fontDecrease", () => {
    setSize(runtime.state.fontSize - FONT_STEP);
  });
  setAction("fontIncrease", () => {
    setSize(runtime.state.fontSize + FONT_STEP);
  });

  render();
  // The group is `terminal`, not `theme`. The font size is a property of the
  // terminal, and an import of a color scheme never changes it.
  addMenuRow({
    group: TERMINAL_GROUP,
    label: "font size",
    controls: [decreaseButton, valueLabel, increaseButton],
  });
}

/**
 * `value` at one decimal.
 *
 * The step is 0.1, and a sum of two binary floats gives 1.1000000000000001.
 * A round on the scaled value gives the one-decimal value that the label
 * shows and the store holds.
 */
function oneDecimal(value: number): number {
  const scale = 10 ** LINE_DECIMALS;
  return Math.round(value * scale) / scale;
}

/**
 * Install the line height control.
 *
 * The line height is a multiplier of the cell height of the font metric. 1.0
 * gives the cell height of the metric, and 2.0 gives twice that height.
 *
 * This function writes no renderer option and calls no renderer method. It
 * writes `state.lineHeight`, it writes the store, and it asks for one fit on
 * the debounced path of `requestFit`. One change then gives one resize
 * frame, the same count that a font size change gives. The renderer reads
 * the value in a later change.
 *
 * The control has no hotkey. The font size holds the two hotkeys of
 * `src/keys.ts`, and a new binding needs a new `BindingId` in
 * `src/prefs.ts` and a new label in `src/menu.ts`.
 */
export function installLineHeight(runtime: Runtime): void {
  const decreaseButton = document.createElement("button");
  decreaseButton.id = "line-height-decrease";
  decreaseButton.type = "button";
  decreaseButton.textContent = MINUS;
  decreaseButton.setAttribute("aria-label", "decrease the line height");

  const valueLabel = document.createElement("span");
  valueLabel.id = "line-height-value";

  const increaseButton = document.createElement("button");
  increaseButton.id = "line-height-increase";
  increaseButton.type = "button";
  increaseButton.textContent = PLUS;
  increaseButton.setAttribute("aria-label", "increase the line height");

  /** Show the current height at one decimal, and disable a button at its limit. */
  function render(): void {
    valueLabel.textContent = runtime.state.lineHeight.toFixed(LINE_DECIMALS);
    decreaseButton.disabled = runtime.state.lineHeight <= LINE_MIN;
    increaseButton.disabled = runtime.state.lineHeight >= LINE_MAX;
  }

  /**
   * Put the terminal at line height `next`, clamped to the range.
   *
   * A height equal to the current height does nothing: no write to the
   * store, and no request for a fit.
   */
  function setLineHeight(next: number): void {
    const clamped = oneDecimal(Math.min(LINE_MAX, Math.max(LINE_MIN, next)));
    if (clamped === runtime.state.lineHeight) {
      return;
    }
    runtime.state.lineHeight = clamped;
    render();
    setPrefs({ lineHeight: clamped });
    requestFit();
  }

  decreaseButton.addEventListener("click", () => {
    setLineHeight(runtime.state.lineHeight - LINE_STEP);
    // A menu button that keeps the focus swallows the next keystroke of the
    // operator. Give the focus back to the terminal.
    runtime.term.focus();
  });
  increaseButton.addEventListener("click", () => {
    setLineHeight(runtime.state.lineHeight + LINE_STEP);
    runtime.term.focus();
  });

  render();
  addMenuRow({
    group: TERMINAL_GROUP,
    label: "line height",
    controls: [decreaseButton, valueLabel, increaseButton],
  });
}
