/**
 * The font size control.
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
