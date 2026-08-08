/**
 * Keyboard input: the control characters, the focus, and the key repeat.
 *
 * `PirateTerminal` of `src/terminal.ts` attaches one keydown listener to
 * `#terminal` and encodes each key with the KeyEncoder of libghostty, through
 * `vt.encodeKey` (`src/terminal.ts:323` and `src/terminal.ts:527`).
 * `src/main.ts` sends every `onData` string as one `0x00` frame, so this
 * module adds no second path to the socket. It corrects a small set of chords
 * through `term.attachCustomKeyEventHandler`, the one hook that the facade
 * calls before it encodes a key itself (`src/terminal.ts:522`).
 *
 * A truthy return from that handler makes the facade call `preventDefault`
 * and encode nothing (`src/terminal.ts:522` to `src/terminal.ts:525`). A
 * false return lets the facade encode the key. This module never does both
 * for the same key. Each corrected chord returns true and sends its own
 * bytes. Every other chord returns false.
 *
 * The copy chord and the paste chord return true and send no key byte. The
 * paste chord sends the clipboard text on the same `term.input` path, in a
 * later task, because the read of the clipboard is asynchronous.
 */

import { addMenuRow, TERMINAL_GROUP } from "./menu";
import { setPrefs } from "./prefs";
import type { Runtime } from "./runtime";
import type { Selection } from "./select";

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

// ── A. the chords that the fallback encoder encodes wrongly ────────────────
//
// The correction runs inside `term.attachCustomKeyEventHandler`. Each branch
// below matches one measured defect, sends the correct bytes, and returns
// true. Every other key returns false, and the facade encodes it with the
// fallback encoder.
//
// The fallback encoder is the KeyEncoder of libghostty, inside
// ghostty-vt.wasm. `PirateTerminal.onKeyDown` calls it through
// `this.vt.encodeKey` (`src/terminal.ts:527`). The client binds one option of
// that encoder, `OPT_CURSOR_KEY_APPLICATION` (`src/vt/exports.ts:104`), and
// `src/vt/terminal.ts:541` sets that one option before each call. Every other
// option keeps its default.
//
// Each branch below states the bytes that the fallback encoder gave for its
// chord. The measurement: `buildKeyCorrection` was made to return false for
// every event, the client was built again, and each chord was pressed in the
// browser harness of `web/tests`. The stated bytes are the payload of the
// `0x00` frame that the stub server received. Four of the Ctrl chords gave a
// Kitty CSI-u sequence from the encoder defaults. The client negotiates no
// Kitty keyboard protocol. `grep -ri kitty web/src` finds no flag and no
// query. Outside the comments of this file, the one hit is
// `src/vt/exports.ts:120`, a note on a buffer size.
//
// `term.input(data, true)` sends `data` as the answer to the key. The second
// argument is `wasUserInput`. When it is true, the facade fires the `onData`
// callback and writes nothing to the screen (`src/terminal.ts:387` to
// `src/terminal.ts:396`). A local echo of a control character would be a
// fault, and this path has none. `src/main.ts` already turns every `onData`
// string into one `0x00` frame, so this module opens no second path to the
// socket.

// The clipboard chords are part of this same set. The fallback encoder gives
// wrong bytes for all four of them, and each one also performs a clipboard
// action. Measured fallback, with the correction branch disabled, in the
// Chromium of `web/tests`:
//
//   Ctrl+Shift+C   1b 5b 39 39 3b 35 75   the Kitty sequence `CSI 99;5u`
//   Ctrl+Shift+V   1b 5b 31 31 38 3b 35 75  the Kitty sequence `CSI 118;5u`
//   Cmd+C          63                     the bare letter `c`
//   Cmd+V          76                     the bare letter `v`
//
// A copy chord must send no byte, and a paste chord must send the clipboard
// text alone. The four branches below therefore return true, and the facade
// then calls `preventDefault` and encodes nothing.
//
// The client accepts both pairs on every platform. Cmd+C and Cmd+V are the
// chords of macOS. Ctrl+Shift+C and Ctrl+Shift+V are the chords of Linux and
// of Windows, because Ctrl+C and Ctrl+V already carry SIGINT and SYN to the
// shell. No module of `web/src` detects the platform, and none is needed
// here: a chord of one platform is unreachable on the other, because that
// keyboard holds no such modifier.
//
// Ctrl+V alone keeps SYN (0x16). That branch is below, and it matches
// `ctrlKey` alone, so it never matches Ctrl+Shift+V.

/** The `code` of the copy key. */
const COPY_CODE = "KeyC";
/** The `code` of the paste key. */
const PASTE_CODE = "KeyV";

/**
 * True for Cmd plus `code`, or for Ctrl+Shift plus `code`.
 *
 * Alt is never part of a clipboard chord. Alt plus a letter is the
 * Meta-sends-Escape chord of readline, and its branch is below.
 */
function isClipboardChord(event: KeyboardEvent, code: string): boolean {
  if (event.altKey || event.code !== code) {
    return false;
  }
  if (event.metaKey) {
    return !event.ctrlKey && !event.shiftKey;
  }
  return event.ctrlKey && event.shiftKey;
}

/**
 * Put the text of the selection on the system clipboard.
 *
 * An empty selection writes nothing. A write of the empty string would drop
 * the text that the operator copied before.
 *
 * `navigator.clipboard.writeText` needs a transient user activation, and a
 * keydown gives one. Measured in the Chromium of `web/tests`: the call is
 * rejected with `Write permission denied` until the test grants
 * `clipboard-write`, and it resolves after that grant.
 *
 * `navigator.clipboard` is undefined outside a secure context. A page that is
 * served over plain HTTP from a name other than `localhost` is such a
 * context. The chord then copies nothing, and it still sends no byte.
 */
function copySelection(selection: Selection): void {
  const text = selection.text();
  if (text.length === 0 || navigator.clipboard === undefined) {
    return;
  }
  void navigator.clipboard.writeText(text).catch(() => {
    // The browser refused the write. The operator keeps the old clipboard.
  });
}

/**
 * Send `text` to the shell as a paste.
 *
 * Each line break becomes one carriage return (0x0d), the byte that the
 * Enter key sends. A shell reads a line feed as the end of a line only after
 * the terminal converts it.
 *
 * With bracketed paste on, the terminal wraps the text in `ESC [200~` and
 * `ESC [201~`. The shell then holds the text as one block and runs no line of
 * it. The end marker is removed from the body first: a clipboard that carries
 * `ESC [201~` would otherwise close the block early, and the rest of that
 * clipboard would reach the shell as typed input.
 *
 * An empty clipboard sends nothing, brackets included.
 */
function pasteToShell(runtime: Runtime, text: string): void {
  if (text.length === 0) {
    return;
  }
  const body = text.replace(/\r\n|\n|\r/g, "\r");
  if (!runtime.term.vt.hasBracketedPaste()) {
    runtime.term.input(body, true);
    return;
  }
  runtime.term.input(`\x1b[200~${body.split("\x1b[201~").join("")}\x1b[201~`, true);
}

/**
 * Read the system clipboard and send it to the shell.
 *
 * The client reads the clipboard through `navigator.clipboard.readText`, and
 * not through the `paste` event of the browser. The measurements behind that
 * choice, in the Chromium of `web/tests` on macOS:
 *
 * - A `paste` event fires for Cmd+V and for Shift+Insert alone. Those two are
 *   the paste accelerators of the browser on this platform. Ctrl+Shift+V
 *   fires none, so a client that waits for a `paste` event pastes nothing for
 *   the chord of Linux. The accelerator set differs with the platform, and
 *   `bun run test` runs on `ubuntu-24.04` in CI and on macOS on a
 *   workstation. `readText` behaves the same on both.
 * - `readText` is rejected with `Read permission denied` until the page holds
 *   the `clipboard-read` permission. It resolves under a keydown after that
 *   grant. A browser asks the operator for that permission once per origin.
 *   `tests/input.spec.ts` grants it with `context.grantPermissions`, and it
 *   asserts the grant before it presses a chord.
 *
 * The read is asynchronous, so the bytes reach the socket after the keydown.
 * The chord sends no other byte, so the shell receives the paste alone.
 */
function pasteFromClipboard(runtime: Runtime): void {
  if (navigator.clipboard === undefined) {
    return;
  }
  void navigator.clipboard.readText().then(
    (text: string) => {
      pasteToShell(runtime, text);
    },
    () => {
      // The browser refused the read. The shell receives nothing.
    },
  );
}

/** Build the corrected key handler for `runtime.term`. */
function buildKeyCorrection(
  runtime: Runtime,
  selection: Selection,
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent): boolean => {
    const { ctrlKey, altKey, shiftKey, metaKey, code } = event;

    // Cmd+C and Ctrl+Shift+C. The chord copies the selection and sends no
    // byte.
    if (isClipboardChord(event, COPY_CODE)) {
      copySelection(selection);
      return true;
    }

    // Cmd+V and Ctrl+Shift+V. The chord pastes the clipboard and sends no
    // byte of its own.
    if (isClipboardChord(event, PASTE_CODE)) {
      pasteFromClipboard(runtime);
      return true;
    }

    // Ctrl+V. A real terminal sends SYN (0x16) to the shell for this chord.
    // Ctrl+Shift+V and Cmd+V are the paste chords, and the two branches above
    // hold them. This branch needs `ctrlKey` alone, so it matches neither one,
    // and Ctrl+V pastes nothing.
    //
    // Measured fallback: `16`. The branch below gives the same byte, so it
    // changes no byte today. `tests/input.spec.ts` holds the assertion.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyV") {
      runtime.term.input("\x16", true);
      return true;
    }

    // Ctrl+I. Measured fallback: `1b 5b 31 30 35 3b 35 75`, the Kitty
    // sequence `CSI 105;5u`. tmux and vim read Tab (0x09) for this chord,
    // because the client negotiates no Kitty keyboard protocol.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyI") {
      runtime.term.input("\x09", true);
      return true;
    }

    // Ctrl+M. Measured fallback: `1b 5b 31 30 39 3b 35 75`, the Kitty
    // sequence `CSI 109;5u`. A shell reads carriage return (0x0d) for this
    // chord.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "KeyM") {
      runtime.term.input("\x0d", true);
      return true;
    }

    // Ctrl+[. This chord is the escape key of vim. Measured fallback:
    // `1b 5b 39 31 3b 35 75`, the Kitty sequence `CSI 91;5u`. A shell reads
    // ESC (0x1b) for this chord.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "BracketLeft") {
      runtime.term.input("\x1b", true);
      return true;
    }

    // Ctrl+-. Measured fallback: `1b 5b 34 35 3b 35 75`, the Kitty sequence
    // `CSI 45;5u`. A shell reads unit separator (0x1f) for this chord.
    if (ctrlKey && !altKey && !shiftKey && !metaKey && code === "Minus") {
      runtime.term.input("\x1f", true);
      return true;
    }

    // Shift+Tab. A shell reads the CSI Z sequence for this chord, which
    // requests the previous completion or the previous field of a form.
    // Measured fallback: `1b 5b 5a`, the same three bytes. The branch below
    // changes no byte today. `tests/input.spec.ts` holds the assertion for
    // those bytes.
    if (shiftKey && !ctrlKey && !altKey && !metaKey && code === "Tab") {
      runtime.term.input("\x1b[Z", true);
      return true;
    }

    // Alt plus one character. A real terminal sends ESC, then the character.
    // This is the Meta-sends-Escape behavior that readline and tmux expect
    // for word motion and for Meta bindings. Measured fallback: `62` for
    // Alt+B, `66` for Alt+F, `33` for Alt+3. The fallback encoder sends the
    // bare character, with no ESC in front of it.
    //
    // Measured fallback for Alt+Shift+B: `62`, the lowercase letter. The
    // branch below gives `1b 42`, because it reads `shiftKey` itself.
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
    // depends on the keyboard layout, and `code` alone cannot give it. The
    // facade then encodes the key from `event.key`, composed or not:
    // `textOf` at `src/terminal.ts:213` reads `event.key`, and
    // `src/terminal.ts:527` gives that text to the encoder.
    //
    // The three menu bindings, `alt+h`, `alt+-`, and `alt+=`, never reach
    // this handler. `src/keys.ts:279` attaches one keydown listener on
    // `window`, in the capture phase. `window` is an ancestor of `#terminal`,
    // so that listener runs before the bubble-phase listener of the facade on
    // `#terminal` (`src/terminal.ts:323`). A chord that matches a binding
    // gets `preventDefault` and `stopImmediatePropagation` there, so the
    // event never reaches `#terminal`, and this handler never sees it. A read
    // of `src/keys.ts` confirms this: the registry stops a matched chord
    // before the check for the key repeat.
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

/**
 * Put the key correction on the terminal of `runtime`.
 *
 * `installInput` calls this at install time. `src/main.ts` calls it again for
 * each terminal that `rebuild` builds. A new terminal starts with no handler
 * (`src/terminal.ts:276`), and the corrected chords would then go to the
 * fallback encoder again.
 *
 * `selection` is the one selection of the page. `src/main.ts` builds it once,
 * before the first facade, and it survives every rebuild. The copy chord
 * reads it. `Runtime` carries no selection, so the caller gives it here.
 */
export function attachKeyCorrection(runtime: Runtime, selection: Selection): void {
  runtime.term.attachCustomKeyEventHandler(buildKeyCorrection(runtime, selection));
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
// `term.focus()` gives the focus to a hidden `<textarea>` inside `#terminal`
// (`src/terminal.ts:398` to `src/terminal.ts:401`). The constructor of the
// facade takes the focus once, unconditionally (`src/terminal.ts:354`), so
// the operator can type after a load with no click.
//
// A read of `src/terminal.ts` shows one `addEventListener` call, for
// `keydown` on the container (`src/terminal.ts:323`). The facade registers no
// `focus` listener and no `blur` listener, and it changes no cursor style on
// either event. The client therefore gives the operator no visible sign of a
// lost focus. This module adds none either. The mousedown handler below
// returns the focus before the next keystroke, so the operator has no window
// in which the focus is away and a sign of it would matter. An indicator for
// a state that the fix already closes is unnecessary.
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
// then does the bubble sweep run back up. The facade attaches its own keydown
// listener to `#terminal` in the bubble phase, in its constructor
// (`src/terminal.ts:323`, no capture argument). That constructor runs before
// this module attaches its listener. Registration order does not change the
// outcome here, because the phases run in a fixed order: capture, then
// target, then bubble. A capture-phase listener on `#terminal` therefore
// always runs before the bubble-phase listener of the facade, for the real
// keydown that the operating system sends to the focused element inside
// `#terminal`.
//
// The listener below calls `stopImmediatePropagation` on an event that
// carries `repeat === true`. That call stops every listener that would run
// after it, on every node, including the bubble-phase listener of the facade
// on `#terminal`. The facade then never encodes the event, and the native
// repeat sends no byte. This is a gate, not a second path: the listener never
// itself calls `term.input` or writes to the socket for a real key press. The
// one path to a byte for a real press stays inside the facade, through the
// fallback encoder or through the correction of part A.
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
// A timer in this module dispatches a synthetic keydown on `#terminal` after
// the first press, and again on the configured rate. The facade encodes that
// event on the same path as the first press, so this module keeps no key
// table of its own. The key table of the client is `KEY_OF_CODE`, at
// `src/terminal.ts:53`. A `WeakSet` marks each synthetic event, so the
// listener below knows its own dispatch, lets it continue unstopped to the
// facade, and starts no second repeat from it.

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
        // This is a tick that this module dispatched. Let it continue to the
        // facade unstopped, and take no action, so that one tick does not
        // reset the timer of the next tick.
        return;
      }
      if (event.isComposing || event.keyCode === 229) {
        // A keydown of an IME composition. `PirateTerminal.onKeyDown` tests
        // exactly these two conditions first, and it encodes nothing for
        // either one (`src/terminal.ts:517` to `src/terminal.ts:521`). This
        // listener runs before that test, in the capture phase, so it must
        // bail the same way. Without this test, this module would arm a
        // repeat for a keydown that the facade itself ignores, and the timer
        // would later dispatch synthetic keydowns that send bytes the
        // operator never typed.
        return;
      }
      if (event.repeat) {
        // The native repeat. Stop it here, in the capture phase, before the
        // bubble-phase listener of the facade on this same element can encode
        // it. This is the one place that a native repeat can still reach a
        // byte, and this call closes it.
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
 * The function corrects the chords that the fallback encoder encodes wrongly,
 * holds the focus on the terminal, and generates the key repeat.
 */
export function installInput(runtime: Runtime, selection: Selection): void {
  attachKeyCorrection(runtime, selection);
  installFocusGuard(runtime);
  installKeyRepeat(runtime);
  installRepeatRateRow(runtime);
}
