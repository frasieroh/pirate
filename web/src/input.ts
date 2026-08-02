/**
 * Keyboard input: the control characters, the focus, and the key repeat.
 *
 * ghostty-web attaches its own listener to `#terminal` and encodes each key
 * with the KeyEncoder of libghostty. `src/main.ts` sends every `onData`
 * string as one `0x00` frame, so this module adds no second path to the
 * socket. It corrects a small set of chords through
 * `term.attachCustomKeyEventHandler`, the one hook that ghostty-web calls
 * before it encodes a key itself.
 *
 * A truthy return from that handler makes ghostty-web call `preventDefault`
 * and stop. A false return lets ghostty-web encode the key as it does today.
 * This module never does both for the same key. Each corrected chord returns
 * true and sends its own bytes. Every other chord returns false.
 */

import { addMenuRow, TERMINAL_GROUP } from "./menu";
import { setPrefs } from "./prefs";
import type { Runtime } from "./runtime";

/** The smallest key repeat rate, in keys per second. */
const RATE_MIN = 2;
/** The largest key repeat rate, in keys per second. */
const RATE_MAX = 30;
/** The change of one press of a repeat rate button, in keys per second. */
const RATE_STEP = 1;

/** The text of the decrease button. It matches `#font-decrease`. */
const MINUS = "−";
/** The text of the increase button. */
const PLUS = "+";

/** The code of a modifier key alone. A modifier alone holds no character. */
const MODIFIER_CODE = /^(?:shift|control|alt|meta)(?:left|right)$/i;

/** The code of a letter key, `KeyA` through `KeyZ`. */
const LETTER_CODE = /^Key([A-Z])$/;
/** The code of a digit key, `Digit0` through `Digit9`. */
const DIGIT_CODE = /^Digit([0-9])$/;

/**
 * The lowercase letter of `code`, or null when `code` is not a letter key.
 *
 * `code` names the physical key, not the character it gives. `KeyH` stays
 * `KeyH` on every layout and with every modifier, so this reading of it does
 * not change with Option on macOS, unlike `event.key`.
 */
function letterFromCode(code: string): string | null {
  const match = LETTER_CODE.exec(code);
  return match === null ? null : match[1].toLowerCase();
}

/** The digit of `code`, or null when `code` is not a digit key. */
function digitFromCode(code: string): string | null {
  const match = DIGIT_CODE.exec(code);
  return match === null ? null : match[1];
}

/** `value`, clamped to the repeat rate range. */
function clampRate(value: number): number {
  return Math.min(RATE_MAX, Math.max(RATE_MIN, value));
}

// ── A. the chords that ghostty-web encodes wrongly ─────────────────────────
//
// The correction runs inside `term.attachCustomKeyEventHandler`. Each branch
// below matches one measured defect, sends the correct bytes, and returns
// true. Every other key returns false, and ghostty-web encodes it as before.
//
// `term.input(data, true)` sends `data` as the answer to the key. The second
// argument is `wasUserInput`. When it is true, ghostty-web fires `onData`
// with the string and does not write the string to the screen. A read of
// `input` in `node_modules/ghostty-web/dist/ghostty-web.js` confirms this:
// `input(A, B = false) { ...; B ? this.dataEmitter.fire(A) : this.write(A); }`.
// A local echo of a control character would be a fault, and this path has
// none. `src/main.ts` already turns every `onData` string into one `0x00`
// frame, so this module opens no second path to the socket.

/** Build the corrected key handler for `runtime.term`. */
function buildKeyCorrection(runtime: Runtime): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent): boolean => {
    const { ctrlKey, altKey, shiftKey, metaKey, code } = event;

    // Ctrl+V. A real terminal sends SYN (0x16) to the shell for this chord.
    // Ctrl+Shift+V and Cmd+V are paste chords of the browser, not of the
    // shell. This handler leaves them alone, so the native `paste` event of
    // the browser still reaches the `paste` listener of ghostty-web.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyV") {
      runtime.term.input("\x16", true);
      return true;
    }

    // Ctrl+I. The dictionary of ghostty-web sends a Kitty CSI-u sequence for
    // this chord today. tmux and vim read Tab (0x09) for it, because pirate
    // never negotiated the Kitty keyboard protocol with the server.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyI") {
      runtime.term.input("\x09", true);
      return true;
    }

    // Ctrl+M. The same Kitty defect. A shell reads carriage return (0x0d)
    // for this chord.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyM") {
      runtime.term.input("\x0d", true);
      return true;
    }

    // Ctrl+[. This chord is the escape key of vim. A shell reads ESC (0x1b)
    // for it, not the Kitty sequence that ghostty-web sends today.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "BracketLeft") {
      runtime.term.input("\x1b", true);
      return true;
    }

    // Ctrl+-. A shell reads unit separator (0x1f) for this chord.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "Minus") {
      runtime.term.input("\x1f", true);
      return true;
    }

    // Shift+Tab. A shell reads the CSI Z sequence for this chord, which
    // requests the previous completion or the previous field of a form.
    // ghostty-web sends plain Tab (0x09) for it today, so the shell cannot
    // tell Shift+Tab from Tab.
    if (shiftKey && !ctrlKey && !altKey && !metaKey && code === "Tab") {
      runtime.term.input("\x1b[Z", true);
      return true;
    }

    // Alt plus one character. A real terminal sends ESC, then the character.
    // This is the Meta-sends-Escape behavior that readline and tmux expect
    // for word motion and for Meta bindings. ghostty-web sends the bare
    // character today, with no ESC in front of it.
    //
    // The character comes from `event.code`, never from `event.key`.
    // `src/keys.ts` states the reason: on macOS, Option plus a letter gives
    // a composed character in `key` (`∫` for Option+B, not `b`), so `key`
    // gives the wrong byte for readline's word-motion chords. `code` names
    // the physical key on every platform and every layout, so `KeyB` always
    // gives `b`. Shift still applies, from `shiftKey`, so Alt+Shift+B gives
    // `B`.
    //
    // This branch covers the letters and the digits, the codes that a
    // real terminal binding needs most: readline's word motion is
    // Alt-plus-letter. A digit or a punctuation code held with Shift falls
    // through to `false`, because the character that Shift gives for it
    // depends on the keyboard layout, and `code` alone cannot give it.
    // ghostty-web then encodes the key with its own `key`, composed or not.
    //
    // The three menu bindings, `alt+h`, `alt+-`, and `alt+=`, never reach
    // this handler. `src/keys.ts` attaches one keydown listener on `window`,
    // in the capture phase, and it runs before the listener of ghostty-web
    // on `#terminal`. A chord that matches a binding gets `preventDefault`
    // and `stopImmediatePropagation` there, so the event never reaches
    // `#terminal`, and this handler never sees it. A read of `src/keys.ts`
    // confirms this: the registry stops a matched chord before the check for
    // the key repeat, and well before ghostty-web attaches its own listener.
    if (altKey && !ctrlKey && !metaKey) {
      const letter = letterFromCode(code);
      if (letter !== null) {
        runtime.term.input(`\x1b${shiftKey ? letter.toUpperCase() : letter}`, true);
        return true;
      }
      const digit = digitFromCode(code);
      if (digit !== null && !shiftKey) {
        runtime.term.input(`\x1b${digit}`, true);
        return true;
      }
    }

    return false;
  };
}

// ── B. the focus ────────────────────────────────────────────────────────
//
// A click outside `#menu` must give the focus back to `#terminal`. The
// deleted `#status` strip was a dead click zone that took the focus away
// with no visual sign. This closes the class of fault, not just the one
// strip: a click on empty space anywhere on the page now returns the focus.
//
// `preventDefault` is not called here. A call to it on `mousedown` would
// stop the browser from starting a text selection inside the terminal.
//
// A read of `node_modules/ghostty-web/dist/ghostty-web.js` shows no listener
// for `focus` or `blur` on the terminal element, and no change to the
// cursor style on either event. ghostty-web gives the operator no visible
// sign of a lost focus today. This module adds none either. The mousedown
// handler below returns the focus before the next keystroke, so the operator
// has no window in which the focus is away and a sign of it would matter. An
// indicator for a state that the fix already closes is noise, and the
// product manager forbids noise.
function installFocusGuard(runtime: Runtime): void {
  const menu = document.getElementById("menu");
  window.addEventListener("mousedown", (event: MouseEvent) => {
    if (menu !== null && event.target instanceof Node && menu.contains(event.target)) {
      return;
    }
    runtime.term.focus();
  });
}

// ── C. the key repeat ───────────────────────────────────────────────────
//
// The client suppresses the native key repeat and generates its own. The
// rate and the first delay of the native repeat come from the operating
// system, and they differ on every machine. The requirement is a fixed
// contract: a delay of `state.repeatDelayMs`, then the configured rate. A
// throttle on the native repeat cannot raise its rate above the rate of the
// machine, and it cannot hold its delay to the contract, so the client must
// own the timer.
//
// This module needs no change to `src/keys.ts`. It stops the native repeat
// with one listener of its own, on `#terminal`, in the capture phase. A
// listener in the capture phase, on an ancestor of the real target of a key
// press, always runs before a listener in the bubble phase on the same
// element: the capture sweep runs down from `window` to the target, and only
// then does the bubble sweep run back up. ghostty-web attaches its own
// keydown listener to `#terminal` in the bubble phase, when `term.open`
// runs, and it runs before this module attaches its listener. Registration
// order does not change the outcome here, because the phases run in a fixed
// order: capture, then target, then bubble. A capture-phase listener on
// `#terminal` therefore always runs before the bubble-phase listener of
// ghostty-web, for the real keydown that the operating system sends to the
// focused element inside `#terminal`.
//
// The listener below calls `stopImmediatePropagation` on an event that
// carries `repeat === true`. That call stops every listener that would run
// after it, on every node, including the bubble-phase listener of
// ghostty-web on `#terminal`. ghostty-web then never encodes the event, and
// the native repeat sends no byte. This is a gate, not a second path: the
// listener never itself calls `term.input` or writes to the socket for a
// real key press. The one path to a byte for a real press stays inside
// ghostty-web, through its own encoder or through the correction of part A.
//
// A window-capture listener in `src/keys.ts` already stops a matched hotkey
// chord before it reaches `#terminal`, for its first press and for every
// repeat of it: `event.preventDefault` and `event.stopImmediatePropagation`
// run for both cases. That is a separate check from the one that guards the
// chord's action, which runs once, on the first press only, and never again
// on a repeat. `window` is an ancestor of `#terminal`, so the stop above
// runs before the listener of this module even sees the event. The three
// menu bindings therefore never reach this module, and this module needs no
// check of its own for them.
//
// A timer in this module dispatches a synthetic keydown on `#terminal`
// after the first press, and again on the configured rate. ghostty-web
// encodes that event with its own KeyEncoder, the same encoder as the first
// press, so this module keeps no key table. A `WeakSet` marks each synthetic
// event, so the listener below knows its own dispatch, lets it continue
// unstopped to ghostty-web, and starts no second repeat from it.

/** The fields of a keydown event that a synthetic repeat event must carry. */
interface HeldKey {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function installKeyRepeat(runtime: Runtime): void {
  /** The keydown events that this module dispatched. Never a real key press. */
  const synthetic = new WeakSet<Event>();
  /** The key that repeats now, or null when no key repeats. */
  let held: HeldKey | null = null;
  /** The one pending timer of the repeat, or undefined when none is pending. */
  let timer: number | undefined;

  function stopRepeat(): void {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    held = null;
  }

  function dispatchTick(): void {
    if (held === null) {
      return;
    }
    const event = new KeyboardEvent("keydown", {
      code: held.code,
      key: held.key,
      ctrlKey: held.ctrlKey,
      altKey: held.altKey,
      shiftKey: held.shiftKey,
      metaKey: held.metaKey,
      bubbles: true,
    });
    synthetic.add(event);
    runtime.container.dispatchEvent(event);
  }

  /** Schedule the next tick, on the rate of the moment. */
  function scheduleTick(delayMs: number): void {
    timer = window.setTimeout(() => {
      dispatchTick();
      if (held !== null) {
        scheduleTick(1000 / clampRate(runtime.state.repeatRate));
      }
    }, delayMs);
  }

  function startRepeat(event: KeyboardEvent): void {
    stopRepeat();
    held = {
      code: event.code,
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    };
    scheduleTick(runtime.state.repeatDelayMs);
  }

  runtime.container.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (synthetic.has(event)) {
        // This is a tick that this module dispatched. Let it continue to
        // ghostty-web unstopped, and take no action, so that one tick does
        // not reset the timer of the next tick.
        return;
      }
      if (event.isComposing || event.keyCode === 229) {
        // A keydown of an IME composition. ghostty-web's own `handleKeyDown`
        // checks exactly these two conditions first, and it encodes nothing
        // for either one: a read of `node_modules/ghostty-web/dist/ghostty-web.js`,
        // line 850 to 851, confirms this. This listener runs before that
        // check, in the capture phase, so it must bail the same way. Without
        // this check, this module would arm a repeat for a keydown that
        // ghostty-web itself ignores, and the timer would later dispatch
        // synthetic keydowns that send bytes the operator never typed.
        return;
      }
      if (event.repeat) {
        // The native repeat. Stop it here, in the capture phase, before the
        // bubble-phase listener of ghostty-web on this same element can
        // encode it. This is the one place that a native repeat can still
        // reach a byte, and this call closes it.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (MODIFIER_CODE.test(event.code)) {
        // A modifier alone holds no character, so it never repeats.
        return;
      }
      startRepeat(event);
    },
    true,
  );

  window.addEventListener("keyup", (event: KeyboardEvent) => {
    if (held !== null && event.code === held.code) {
      stopRepeat();
    }
  });

  window.addEventListener("blur", stopRepeat);

  // A composition can start while a plain key still repeats, for example
  // when the operator holds a key and then opens an IME candidate window.
  // Stop the repeat at that moment, so no further tick fires while the
  // composition runs.
  runtime.container.addEventListener("compositionstart", stopRepeat);
}

/** Add the key repeat rate row to the menu. */
function installRepeatRateRow(runtime: Runtime): void {
  const decreaseButton = document.createElement("button");
  decreaseButton.id = "repeat-decrease";
  decreaseButton.type = "button";
  decreaseButton.textContent = MINUS;
  decreaseButton.setAttribute("aria-label", "decrease the key repeat rate");

  const valueLabel = document.createElement("span");
  valueLabel.id = "repeat-value";

  const increaseButton = document.createElement("button");
  increaseButton.id = "repeat-increase";
  increaseButton.type = "button";
  increaseButton.textContent = PLUS;
  increaseButton.setAttribute("aria-label", "increase the key repeat rate");

  /** Show the current rate, and disable a button at its limit. */
  function render(): void {
    valueLabel.textContent = `${runtime.state.repeatRate}`;
    decreaseButton.disabled = runtime.state.repeatRate <= RATE_MIN;
    increaseButton.disabled = runtime.state.repeatRate >= RATE_MAX;
  }

  /**
   * Put the repeat rate at `next`, clamped to the range.
   *
   * A rate equal to the current rate does nothing: no write to the store.
   */
  function setRate(next: number): void {
    const clamped = clampRate(next);
    if (clamped === runtime.state.repeatRate) {
      return;
    }
    runtime.state.repeatRate = clamped;
    render();
    setPrefs({ repeatRate: clamped });
  }

  decreaseButton.addEventListener("click", () => {
    setRate(runtime.state.repeatRate - RATE_STEP);
    // A menu button that keeps the focus swallows the next keystroke of the
    // operator. Give the focus back to the terminal.
    runtime.term.focus();
  });
  increaseButton.addEventListener("click", () => {
    setRate(runtime.state.repeatRate + RATE_STEP);
    runtime.term.focus();
  });

  render();
  // The group is `terminal`, not `theme`. The repeat rate is a property of the
  // terminal, and it joins the font size under one heading.
  addMenuRow({
    group: TERMINAL_GROUP,
    label: "key repeat rate",
    controls: [decreaseButton, valueLabel, increaseButton],
  });
}

/**
 * Install the input corrections and the key repeat.
 *
 * The function corrects the chords that ghostty-web encodes wrongly, holds
 * the focus on the terminal, and generates the key repeat.
 */
export function installInput(runtime: Runtime): void {
  runtime.term.attachCustomKeyEventHandler(buildKeyCorrection(runtime));
  installFocusGuard(runtime);
  installKeyRepeat(runtime);
  installRepeatRateRow(runtime);
}
