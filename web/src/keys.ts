/**
 * The keybinding registry.
 *
 * A chord is built from `KeyboardEvent.code`, never from `KeyboardEvent.key`.
 * On macOS, Option and H give the key `˙`, and Option and `=` give `≠`. The
 * code stays `KeyH` and `Equal` on every platform and every keyboard layout.
 *
 * The registry attaches ONE keydown listener on `window`, in the capture
 * phase. The capture phase runs before the listener of ghostty-web on the
 * container. A chord that matches a binding gets `preventDefault` and
 * `stopImmediatePropagation`, so ghostty-web never sees the event and the
 * client sends no bytes for it. This is the only defense against a
 * double-sent keystroke: the client never adds a second path to `onData`.
 *
 * This module holds no key repeat. The repeat layer goes into the same
 * listener, at the seam that `onKeyDown` marks. A second listener would give
 * a second path for one key press, which is the fault above.
 */

import type { BindingId } from "./prefs";

/** The action of a binding. A binding with no action does nothing. */
type Action = () => void;

/** The answer of the registry to a rebind or to a captured chord. */
export type CaptureResult =
  | { status: "set"; chord: string }
  | { status: "refused"; reason: string }
  | { status: "cancelled" };

/** The answer of `setChord`. */
export interface SetResult {
  ok: boolean;
  /** One short line for the menu. It is empty when `ok` is true. */
  reason: string;
}

/** The line for a chord that holds no Alt, no Control, and no Meta. */
const NEED_MODIFIER = "Hold Alt, Control, or Meta with the key.";
/** The line for a chord that another binding holds. */
const IN_USE = "Another binding holds that chord.";

/**
 * A normalized chord.
 *
 * The modifiers come in one order: ctrl, alt, shift, meta. Then comes the
 * lowercase code. A chord from a keyboard event and a chord from the cookie
 * are therefore one string.
 */
const CHORD = /^(?:ctrl\+)?(?:alt\+)?(?:shift\+)?(?:meta\+)?[a-z0-9]+$/;

/** The codes of the modifier keys. A modifier alone is not a chord. */
const MODIFIER_CODE = /^(?:shift|control|alt|meta)(?:left|right)$/;

/** The label of a code that is not a letter and not a digit. */
const KEY_LABELS: Record<string, string> = {
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  comma: ",",
  period: ".",
  slash: "/",
  space: "space",
  escape: "esc",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

/** The chord of each binding. `startKeys` fills this record. */
let chordOf: Record<BindingId, string> = {
  toggleMenu: "alt+keyh",
  fontIncrease: "alt+equal",
  fontDecrease: "alt+minus",
};

/** The action of each binding. The font worker replaces two of these. */
const actionOf = new Map<BindingId, Action>();

/** The binding that waits for a chord, and the caller that gets the answer. */
let capturing: { id: BindingId; done: (result: CaptureResult) => void } | null = null;

/** True after the listener is on `window`. */
let started = false;

/** The caller that writes a change to the preference store. */
let onChange: (chords: Record<BindingId, string>) => void = (): void => {};

/** True when `chord` has the normalized form. */
export function isChord(chord: string): boolean {
  return CHORD.test(chord);
}

/**
 * True when `chord` holds Alt, Control, or Meta.
 *
 * A chord without one of these modifiers takes a plain key away from the
 * shell. Shift alone is not enough, because Shift and a letter give a capital
 * letter.
 */
export function hasCommandModifier(chord: string): boolean {
  const parts = chord.split("+");
  parts.pop();
  return parts.includes("alt") || parts.includes("ctrl") || parts.includes("meta");
}

/** The normalized chord of a keyboard event. */
export function chordOfEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("ctrl");
  }
  if (event.altKey) {
    parts.push("alt");
  }
  if (event.shiftKey) {
    parts.push("shift");
  }
  if (event.metaKey) {
    parts.push("meta");
  }
  parts.push(event.code.toLowerCase());
  return parts.join("+");
}

/** The chord as the operator reads it: `alt+keyh` gives `alt+h`. */
export function chordLabel(chord: string): string {
  const parts = chord.split("+");
  const code = parts.pop() ?? "";
  let label = KEY_LABELS[code];
  if (label === undefined && code.startsWith("key") && code.length === 4) {
    label = code.slice(3);
  }
  if (label === undefined && code.startsWith("digit")) {
    label = code.slice(5);
  }
  parts.push(label ?? code);
  return parts.join("+");
}

/** The chord of every binding. */
export function chords(): Record<BindingId, string> {
  return { ...chordOf };
}

/** The chord of one binding. */
export function chordFor(id: BindingId): string {
  return chordOf[id];
}

/** The binding that holds `chord`, or null when no binding holds it. */
function bindingFor(chord: string): BindingId | null {
  for (const [id, value] of Object.entries(chordOf) as Array<[BindingId, string]>) {
    if (value === chord) {
      return id;
    }
  }
  return null;
}

/**
 * Give a binding its action.
 *
 * The font worker calls this for `fontIncrease` and for `fontDecrease`. Until
 * then both bindings match their chord and do nothing.
 */
export function setAction(id: BindingId, run: Action): void {
  actionOf.set(id, run);
}

/**
 * Put `chord` on the binding `id`.
 *
 * The chord must hold Alt, Control, or Meta, and no other binding can hold
 * it. A refused chord leaves the binding unchanged.
 */
export function setChord(id: BindingId, chord: string): SetResult {
  if (!isChord(chord) || !hasCommandModifier(chord)) {
    return { ok: false, reason: NEED_MODIFIER };
  }
  const owner = bindingFor(chord);
  if (owner !== null && owner !== id) {
    return { ok: false, reason: IN_USE };
  }
  chordOf = { ...chordOf, [id]: chord };
  onChange(chords());
  return { ok: true, reason: "" };
}

/**
 * Take the next chord for the binding `id`.
 *
 * The registry swallows every key while it waits. The Escape key cancels. A
 * second call cancels the first one, so one button at a time is in capture
 * mode.
 */
export function captureChord(id: BindingId, done: (result: CaptureResult) => void): void {
  cancelCapture();
  capturing = { id, done };
}

/** Leave capture mode. The caller of `captureChord` gets `cancelled`. */
export function cancelCapture(): void {
  if (capturing === null) {
    return;
  }
  const target = capturing;
  capturing = null;
  target.done({ status: "cancelled" });
}

/** The one listener. It runs on `window`, in the capture phase. */
function onKeyDown(event: KeyboardEvent): void {
  if (capturing !== null) {
    // Capture mode takes every key, so that no chord reaches the shell while
    // the operator sets a binding.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (MODIFIER_CODE.test(event.code.toLowerCase())) {
      // A modifier alone is not a chord. Wait for the key that follows it.
      return;
    }
    const target = capturing;
    capturing = null;
    if (event.code === "Escape") {
      target.done({ status: "cancelled" });
      return;
    }
    const chord = chordOfEvent(event);
    const result = setChord(target.id, chord);
    target.done(
      result.ok ? { status: "set", chord } : { status: "refused", reason: result.reason },
    );
    return;
  }

  /* SEAM(repeat): the key repeat layer goes here, in this same listener.
     It stops every event that carries `repeat === true`, then a timer
     dispatches a synthetic keydown on the terminal container. A second
     listener would give a second path for one key press. Add no listener. */

  const id = bindingFor(chordOfEvent(event));
  if (id === null) {
    // Every other key passes through untouched.
    return;
  }
  // A matched chord never reaches the shell, on its first press and on
  // every repeat of a held key: this call runs for both cases.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.repeat) {
    // The action runs once, on the first press only. Without this check, a
    // held chord would run its action at the repeat rate of the operating
    // system: `alt+h` would flicker the menu, and `alt+=` would run the
    // font size away. Swallowing the byte above already stopped the repeat
    // from reaching the shell; this check stops it from reaching the
    // action too.
    return;
  }
  actionOf.get(id)?.();
}

/**
 * Attach the listener and take the chords of the preference store.
 *
 * `notify` gets the whole chord record after each change. `src/main.ts` writes
 * it to the store. A second call attaches no second listener.
 */
export function startKeys(
  initial: Record<BindingId, string>,
  notify: (chords: Record<BindingId, string>) => void,
): void {
  chordOf = { ...initial };
  onChange = notify;
  if (started) {
    return;
  }
  started = true;
  window.addEventListener("keydown", onKeyDown, true);
}
