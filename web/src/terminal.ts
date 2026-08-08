/**
 * The terminal facade of pirate.
 *
 * This module joins the two layers that do the work. `src/vt/` holds the VT100
 * state machine, and `src/render/` draws its viewport with WebGL2. The facade
 * adds the parts that belong to neither layer: the keyboard, the focus, the
 * animation frame loop, and the font size and theme controls.
 *
 * The module imports nothing from the JavaScript layer of `ghostty-web`.
 *
 * This is the product surface. It holds no xterm.js buffer API and no addon
 * API. `src/main.ts` builds a separate adapter of that shape for the test
 * harness, and that adapter is not part of this file.
 *
 * The facade owns no VT terminal. `src/main.ts` creates one `VtTerminal` and
 * one `GridRenderer` at load time and gives both to every facade that it
 * builds. `dispose` therefore frees neither of them. `src/vt/terminal.ts`
 * states the reason: `ghostty_terminal_free` of ghostty-vt.wasm 0.4.0 corrupts
 * the heap of the module.
 */

import { GridRenderer, type FitResult } from "./render";
import type { Theme } from "./theme";
import { VtKey, VtKeyAction, VtMods, type VtTerminal } from "./vt";

/** The values that a caller can change after the terminal is built. */
export interface TerminalOptions {
  /** The font size in CSS pixels. A write rasterizes the atlas again. */
  fontSize: number;
  /** The colors of the grid. A write repaints every cell on the next frame. */
  theme: Theme;
}

/** The handler that runs before the terminal encodes a key. */
export type KeyEventHandler = (event: KeyboardEvent) => boolean;

/**
 * The `keyCode` of a keydown that an input method editor owns.
 *
 * A browser reports 229 while a composition runs. The terminal encodes nothing
 * for such an event, because the composition, not the key, produces the text.
 */
const IME_KEY_CODE = 229;

/**
 * The `VtKey` of one `KeyboardEvent.code`.
 *
 * `code` names the physical key. It does not change with the modifiers or with
 * the keyboard layout, so one table serves every layout. A code that is not in
 * this table gives `VtKey.UNIDENTIFIED`, and the encoder then produces bytes
 * from the text of the key alone.
 */
const KEY_OF_CODE: Readonly<Record<string, VtKey>> = {
  Backquote: VtKey.GRAVE,
  Backslash: VtKey.BACKSLASH,
  BracketLeft: VtKey.BRACKET_LEFT,
  BracketRight: VtKey.BRACKET_RIGHT,
  Comma: VtKey.COMMA,
  Digit0: VtKey.ZERO,
  Digit1: VtKey.ONE,
  Digit2: VtKey.TWO,
  Digit3: VtKey.THREE,
  Digit4: VtKey.FOUR,
  Digit5: VtKey.FIVE,
  Digit6: VtKey.SIX,
  Digit7: VtKey.SEVEN,
  Digit8: VtKey.EIGHT,
  Digit9: VtKey.NINE,
  Equal: VtKey.EQUAL,
  IntlBackslash: VtKey.INTL_BACKSLASH,
  IntlRo: VtKey.INTL_RO,
  IntlYen: VtKey.INTL_YEN,
  KeyA: VtKey.A,
  KeyB: VtKey.B,
  KeyC: VtKey.C,
  KeyD: VtKey.D,
  KeyE: VtKey.E,
  KeyF: VtKey.F,
  KeyG: VtKey.G,
  KeyH: VtKey.H,
  KeyI: VtKey.I,
  KeyJ: VtKey.J,
  KeyK: VtKey.K,
  KeyL: VtKey.L,
  KeyM: VtKey.M,
  KeyN: VtKey.N,
  KeyO: VtKey.O,
  KeyP: VtKey.P,
  KeyQ: VtKey.Q,
  KeyR: VtKey.R,
  KeyS: VtKey.S,
  KeyT: VtKey.T,
  KeyU: VtKey.U,
  KeyV: VtKey.V,
  KeyW: VtKey.W,
  KeyX: VtKey.X,
  KeyY: VtKey.Y,
  KeyZ: VtKey.Z,
  Minus: VtKey.MINUS,
  Period: VtKey.PERIOD,
  Quote: VtKey.QUOTE,
  Semicolon: VtKey.SEMICOLON,
  Slash: VtKey.SLASH,

  AltLeft: VtKey.ALT_LEFT,
  AltRight: VtKey.ALT_RIGHT,
  Backspace: VtKey.BACKSPACE,
  CapsLock: VtKey.CAPS_LOCK,
  ContextMenu: VtKey.CONTEXT_MENU,
  ControlLeft: VtKey.CONTROL_LEFT,
  ControlRight: VtKey.CONTROL_RIGHT,
  Enter: VtKey.ENTER,
  MetaLeft: VtKey.META_LEFT,
  MetaRight: VtKey.META_RIGHT,
  ShiftLeft: VtKey.SHIFT_LEFT,
  ShiftRight: VtKey.SHIFT_RIGHT,
  Space: VtKey.SPACE,
  Tab: VtKey.TAB,
  Convert: VtKey.CONVERT,
  KanaMode: VtKey.KANA_MODE,
  NonConvert: VtKey.NON_CONVERT,

  Delete: VtKey.DELETE,
  End: VtKey.END,
  Help: VtKey.HELP,
  Home: VtKey.HOME,
  Insert: VtKey.INSERT,
  PageDown: VtKey.PAGE_DOWN,
  PageUp: VtKey.PAGE_UP,

  ArrowDown: VtKey.DOWN,
  ArrowLeft: VtKey.LEFT,
  ArrowRight: VtKey.RIGHT,
  ArrowUp: VtKey.UP,

  NumLock: VtKey.NUM_LOCK,
  Numpad0: VtKey.KP_0,
  Numpad1: VtKey.KP_1,
  Numpad2: VtKey.KP_2,
  Numpad3: VtKey.KP_3,
  Numpad4: VtKey.KP_4,
  Numpad5: VtKey.KP_5,
  Numpad6: VtKey.KP_6,
  Numpad7: VtKey.KP_7,
  Numpad8: VtKey.KP_8,
  Numpad9: VtKey.KP_9,
  NumpadAdd: VtKey.KP_PLUS,
  NumpadBackspace: VtKey.KP_BACKSPACE,
  NumpadClear: VtKey.KP_CLEAR,
  NumpadClearEntry: VtKey.KP_CLEAR_ENTRY,
  NumpadComma: VtKey.KP_COMMA,
  NumpadDecimal: VtKey.KP_PERIOD,
  NumpadDivide: VtKey.KP_DIVIDE,
  NumpadEnter: VtKey.KP_ENTER,
  NumpadEqual: VtKey.KP_EQUAL,
  NumpadMultiply: VtKey.KP_MULTIPLY,
  NumpadParenLeft: VtKey.KP_PAREN_LEFT,
  NumpadParenRight: VtKey.KP_PAREN_RIGHT,
  NumpadSubtract: VtKey.KP_MINUS,

  Escape: VtKey.ESCAPE,
  F1: VtKey.F1,
  F2: VtKey.F2,
  F3: VtKey.F3,
  F4: VtKey.F4,
  F5: VtKey.F5,
  F6: VtKey.F6,
  F7: VtKey.F7,
  F8: VtKey.F8,
  F9: VtKey.F9,
  F10: VtKey.F10,
  F11: VtKey.F11,
  F12: VtKey.F12,
  F13: VtKey.F13,
  F14: VtKey.F14,
  F15: VtKey.F15,
  F16: VtKey.F16,
  F17: VtKey.F17,
  F18: VtKey.F18,
  F19: VtKey.F19,
  F20: VtKey.F20,

  PrintScreen: VtKey.PRINT_SCREEN,
  ScrollLock: VtKey.SCROLL_LOCK,
  Pause: VtKey.PAUSE,
};

/** The `VtMods` bitset of one keyboard event. */
function modsOf(event: KeyboardEvent): number {
  let mods = VtMods.NONE;
  if (event.shiftKey) {
    mods |= VtMods.SHIFT;
  }
  if (event.ctrlKey) {
    mods |= VtMods.CTRL;
  }
  if (event.altKey) {
    mods |= VtMods.ALT;
  }
  if (event.metaKey) {
    mods |= VtMods.SUPER;
  }
  return mods;
}

/**
 * The text that a key produces, or undefined when it produces none.
 *
 * A printable key gives one character in `key`. A named key such as `Enter`
 * gives a name of more than one character, and the encoder builds the bytes of
 * that key from its `VtKey` alone.
 */
function textOf(event: KeyboardEvent): string | undefined {
  return event.key.length === 1 ? event.key : undefined;
}

/**
 * Build the hidden text field of the terminal.
 *
 * The field carries the focus and the composition events of an input method
 * editor. It is off the screen and it stays in the tab order.
 */
function makeTextField(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  field.setAttribute("autocorrect", "off");
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("spellcheck", "false");
  field.setAttribute("tabindex", "0");
  field.setAttribute("aria-label", "Terminal input");
  field.style.position = "absolute";
  field.style.left = "0";
  field.style.top = "0";
  field.style.width = "1px";
  field.style.height = "1px";
  field.style.padding = "0";
  field.style.border = "none";
  field.style.margin = "0";
  field.style.opacity = "0";
  field.style.clipPath = "inset(50%)";
  field.style.overflow = "hidden";
  field.style.whiteSpace = "nowrap";
  field.style.resize = "none";
  return field;
}

export class PirateTerminal {
  /**
   * The VT terminal that this facade reads and writes.
   *
   * The facade never frees it. `src/main.ts` owns it for the life of the page.
   */
  readonly vt: VtTerminal;

  /**
   * The grid renderer that paints the viewport.
   *
   * The facade never frees it. `src/main.ts` owns it, and every facade of one
   * page paints through the same renderer and the same canvas.
   */
  readonly renderer: GridRenderer;

  /** The font size and the theme. A write to either one reaches the renderer. */
  readonly options: TerminalOptions;

  /**
   * The id of the animation frame request that is pending now.
   *
   * The loop asks for the next frame at the start of each callback, so this
   * field always holds the request that a caller can still cancel.
   */
  animationFrameId: number | undefined;

  private readonly container: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly decoder = new TextDecoder();
  private keyHandler: KeyEventHandler | undefined;
  private dataCallback: ((data: string) => void) | undefined;
  private disposed = false;

  constructor(options: {
    container: HTMLElement;
    vt: VtTerminal;
    renderer: GridRenderer;
    fontSize: number;
    theme: Theme;
  }) {
    this.container = options.container;
    this.vt = options.vt;
    this.renderer = options.renderer;

    // A write to either member reaches the renderer at once. The record keeps
    // the value, so a reader gets back what it wrote.
    let fontSize = options.fontSize;
    let theme = options.theme;
    this.options = {
      get fontSize(): number {
        return fontSize;
      },
      set fontSize(px: number) {
        fontSize = px;
        options.renderer.setFontSize(px);
      },
      get theme(): Theme {
        return theme;
      },
      set theme(next: Theme) {
        theme = next;
        options.renderer.setTheme(next);
      },
    };

    this.field = makeTextField();
    this.container.append(this.field);
    // The container carries the focus when no click reached the text field.
    // Without this attribute the container cannot take the focus, and a key
    // press then goes to the body and never reaches the listener below.
    this.container.setAttribute("tabindex", "0");

    // The listener sits on the container, in the bubble phase. `src/input.ts`
    // installs a capture-phase listener on the same element and stops the
    // native key repeat there. A capture-phase listener always runs before a
    // bubble-phase listener on the same element, so that gate holds.
    this.container.addEventListener("keydown", this.onKeyDown);

    // Take the focus, but only when no other element holds it. Without this
    // call the active element after a load is BODY, and every keystroke of the
    // operator goes nowhere until a click lands on the page. `src/input.ts`
    // returns the focus on `mousedown`, so one click hides the fault, and an
    // operator who logs in and types sees nothing at all.
    //
    // This constructor is the `open` of this facade. It appends the text
    // field, it makes the container focusable, and it attaches the key
    // listener. ghostty-web ended its own `open` with a focus call for the
    // same reason, and this facade has no other lifecycle point.
    //
    // The call belongs here and not in `src/main.ts`, because `dispose`
    // removes the text field of the old facade. A theme change builds a new
    // facade, so the focused node leaves the document and the focus falls to
    // BODY. A call in `main.ts` at load time alone would leave that second
    // path broken.
    //
    // The call is unconditional. Measurement of the three paths that must not
    // lose the focus of the operator:
    //
    // - The login form. `requireSession` of `src/login.ts` removes the form
    //   before it resolves, and `src/main.ts` awaits it before it builds
    //   anything. No terminal exists while the form is on the screen.
    // - The menu. A rebuild runs for a theme change alone. `src/theme.ts`
    //   calls `term.focus()` on its own line after every `rebuild`, as
    //   `src/font.ts` and `src/input.ts` do for their own menu rows, so this
    //   call changes no end state there. A menu button that the operator holds
    //   without a theme change keeps the focus, because no rebuild runs.
    // - A reconnect. `ws.onopen` builds no facade, so the focus does not move.
    this.focus();

    this.animationFrameId = requestAnimationFrame(this.loop);
  }

  /** The column count of the grid. */
  get cols(): number {
    return this.vt.cols;
  }

  /** The row count of the grid. */
  get rows(): number {
    return this.vt.rows;
  }

  /**
   * Put `handler` in front of the key encoder. One handler runs at a time.
   *
   * A truthy return makes the terminal call `preventDefault` and encode
   * nothing. A false return lets the terminal encode the key.
   */
  attachCustomKeyEventHandler(handler: KeyEventHandler): void {
    this.keyHandler = handler;
  }

  /**
   * Send `data` to the host, or write it to the screen.
   *
   * With `wasUserInput` true, the terminal fires the `onData` callback and
   * writes nothing to the screen. A local echo of a control character would be
   * a fault. With `wasUserInput` false, the terminal writes `data` to the
   * screen and sends nothing.
   */
  input(data: string, wasUserInput = false): void {
    if (this.disposed) {
      return;
    }
    if (wasUserInput) {
      this.dataCallback?.(data);
      return;
    }
    this.vt.write(data);
  }

  /** Give the focus to the hidden text field of the terminal. */
  focus(): void {
    this.field.focus();
  }

  /** Register the callback that takes every byte the operator produces. */
  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  /**
   * Parse `data` and paint it on the next animation frame.
   *
   * This is an own property of the instance, not a method of the prototype, so
   * a caller can replace it and observe every write. `web/bench/instrument.ts`
   * measures the parse time that way.
   */
  write = (data: Uint8Array | string): void => {
    if (this.disposed) {
      return;
    }
    this.vt.write(data);
    this.pumpResponse();
  };

  /**
   * Clear the screen and the scrollback, and put the terminal in its start
   * state.
   *
   * The reset runs as the RIS sequence, `ESC c`. The VT layer holds no reset
   * call of its own, and a new terminal is not an option here: the client
   * never frees a `VtTerminal`.
   */
  reset(): void {
    this.write("\x1bc");
  }

  /** The columns and rows that the container holds at the current font size. */
  fit(): FitResult {
    return this.renderer.fit();
  }

  /** Give the VT terminal and the grid the same new size. */
  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.vt.resize(cols, rows);
    this.renderer.resize(cols, rows);
  }

  /**
   * Stop this facade.
   *
   * The method cancels the frame loop, removes the key listener, and removes
   * the text field. It frees no VT terminal and no renderer, because
   * `src/main.ts` owns both for the life of the page.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    this.container.removeEventListener("keydown", this.onKeyDown);
    this.field.remove();
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * One turn of the frame loop.
   *
   * The loop is unconditional, so a quiet stream still gets frames and a large
   * write that arrives with no other event still reaches the canvas. `draw` is
   * cheap when no row is dirty.
   *
   * The request for the next frame comes first, so `animationFrameId` holds a
   * live request while `draw` runs.
   */
  private readonly loop = (): void => {
    if (this.disposed) {
      return;
    }
    this.animationFrameId = requestAnimationFrame(this.loop);
    this.renderer.draw(this.vt);
  };

  /**
   * Send the answer that the terminal owes the host, if it owes one.
   *
   * A sequence such as DSR, `ESC [ 6 n`, makes the terminal produce an answer.
   * The host expects it on the same path as a key press.
   */
  private pumpResponse(): void {
    while (this.vt.hasResponse()) {
      const answer = this.vt.readResponse();
      if (answer === null || answer.length === 0) {
        return;
      }
      this.dataCallback?.(answer);
    }
  }

  /**
   * Encode one key press and send it to the host.
   *
   * The order matches the order that `src/input.ts` documents: the composition
   * check first, then the custom handler, then the encoder.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed) {
      return;
    }
    if (event.isComposing || event.keyCode === IME_KEY_CODE) {
      // An input method editor owns this key. The composition produces the
      // text, so the terminal encodes nothing.
      return;
    }
    if (this.keyHandler !== undefined && this.keyHandler(event)) {
      event.preventDefault();
      return;
    }

    const bytes = this.vt.encodeKey({
      action: VtKeyAction.PRESS,
      key: KEY_OF_CODE[event.code] ?? VtKey.UNIDENTIFIED,
      mods: modsOf(event),
      utf8: textOf(event),
    });
    if (bytes.length === 0) {
      // A modifier alone produces no bytes. Leave the event to the browser.
      return;
    }
    event.preventDefault();
    this.dataCallback?.(this.decoder.decode(bytes));
  };
}
