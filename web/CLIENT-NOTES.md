# Client notes

The current state of the browser client. The client engineering manager owns
this file. It holds what is decided, what is verified, and what is open.

## Verification command

```
cd /Users/oscarfrasier/pirate/web && bun run typecheck && bun run test
```

Baseline before this wave: 20 pass, 0 fail, 6 files, 47.53 s.

After the theme repaint decision and the menu grouping fix: 63 pass, 0 fail, 11
files, 75.64 s.

## Decided interfaces

These four decisions are the contract between the modules. Do not change them
in a worker.

### 1. The preference store — `src/prefs.ts`

```ts
type Mode = "dark" | "light";
type MenuState = "open" | "collapsed" | "hidden";
type BindingId = "toggleMenu" | "fontIncrease" | "fontDecrease";

interface Prefs {
  mode: Mode;
  dark: Theme;            // the theme of the dark slot
  light: Theme;           // the theme of the light slot
  fontSize: number;       // 8 to 32
  repeatRate: number;     // keys per second, 2 to 30
  keys: Record<BindingId, string>;  // normalized chords
  menu: MenuState;
}
```

One cookie holds the whole record:

- name `pirate.prefs`
- value `encodeURIComponent(JSON.stringify(prefs))`
- attributes `path=/; max-age=31536000; samesite=lax`, and `secure` when the
  page is on https

The store never writes a second cookie. The auth token is never stored. A
value that does not parse gives the defaults, and the store writes the
defaults over it.

A cookie holds 4096 bytes. Two full themes plus the other fields stay near
1.4 kB. If the serialized record is more than 3800 bytes, the store keeps the
value in memory and reports the fault in the menu.

### 2. The CSS custom properties

`src/theme.ts` computes every property from the colors of the active theme and
sets them on `document.documentElement`. Nothing else sets them.

| Property | Source |
|---|---|
| `--pirate-bg` | `theme.background` |
| `--pirate-fg` | `theme.foreground` |
| `--pirate-surface` | `background` mixed 6% toward `foreground` |
| `--pirate-border` | `background` mixed 22% toward `foreground` |
| `--pirate-error` | `theme.red` |
| `--pirate-muted` | `background` mixed 55% toward `foreground` |
| `--pirate-ok` | `theme.green` |
| `--pirate-warn` | `theme.yellow` |

The first five are the handoff contract with the security manager.
`src/login.css` reads them. Do not rename them. `src/login.css` and
`src/login.ts` are read-only in this wave.

`theme.ts` also sets `color-scheme` on the root, from the luminance of the
background. The scrollbars and the form controls of the browser then match the
theme.

The mix runs in TypeScript, not in CSS. A test can then read one number and
compare it. Every property is a `#rrggbb` string.

### 3. The theme model — `src/theme.ts`

```ts
interface Theme {
  name: string;
  background: string; foreground: string;
  cursor: string; cursorAccent: string;
  selectionBackground: string; selectionForeground: string;
  black: string;  red: string;  green: string;  yellow: string;
  blue: string;   magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string;
  brightYellow: string; brightBlue: string; brightMagenta: string;
  brightCyan: string;  brightWhite: string;
}
```

Every value is `#rrggbb`. The set is the set of `ITheme` of ghostty-web, so
the theme goes to `term.options.theme` without a conversion.

Two slots hold two themes: dark and light. `prefs.mode` selects the slot.

An import goes to the slot that matches the luminance of its own background,
and the mode changes to that slot. One rule: a light scheme becomes the light
theme, a dark scheme becomes the dark theme.

The dark default keeps `#16161e` as the background. `tests/harness.ts` holds
that value in `BACKGROUND`, and the paint measurement compares against it.

The light default must be legible. Each of the eight normal colors and the
foreground must reach a contrast ratio of 4.5:1 against the background. Each
of the eight bright colors must reach 3:1. A test measures this.

### 4. The keybinding registry — `src/keys.ts`

A chord is built from `KeyboardEvent.code`, never from `KeyboardEvent.key`.
On macOS, Option and H give the key `˙`, and Option and `=` give `≠`. The
code stays `KeyH` and `Equal` on every platform and every layout.

- normalized form: `alt+keyh`, `alt+minus`, `alt+equal`
- shown to the operator as: `alt+h`, `alt+-`, `alt+=`
- defaults: `toggleMenu` `alt+keyh`, `fontIncrease` `alt+equal`,
  `fontDecrease` `alt+minus`

The registry attaches ONE keydown listener on `window`, in the capture phase.
The capture phase runs before the listener of ghostty-web on the container.

- A chord that matches a binding gets `preventDefault` and
  `stopImmediatePropagation`. ghostty-web never sees it, so the client sends
  no bytes for it. This is the only defense against a double-sent keystroke:
  the client never adds a second path to `onData`.
- Every other key passes through untouched.

A new chord must hold at least one of Alt, Control, or Meta. A chord without a
modifier would take a plain key away from the shell.

## Layout rule, which is not open

`web/src/style.css` carries two comments about a second resize frame for one
window size. The menu MUST NOT sit in the layout flow. It is
`position: fixed`, and it never changes the box of `#terminal`. A reviewer
that finds the menu inside the flex flow of `body` rejects the deliverable.

## The theme repaint, and why the client does not attempt one

Decided. Do not reopen this.

ghostty-web 0.4.0 cannot recolor a canvas that already holds text. An in-place
theme repaint is not possible with this build. The client does not try. After a
theme change the terminal keeps its text, in the old colors. A page reload is
the remedy.

Several workers each claimed a targeted fix for this. Every claim failed under
measurement. The client engineering manager measured these five facts against
the real client and the stub server:

1. `term.renderer.setTheme(theme)` paints nothing. It assigns a color record
   only.
2. `renderer.resize(term.cols, term.rows)` clears the canvas to the new
   background, and every glyph on the screen goes blank. The buffer keeps the
   text, and the canvas shows nothing. This call is destructive.
   `src/theme.ts` calls it no more. A blank screen looks like a lost session,
   and that is worse than old colors.
3. A forced `renderer.render(term.wasmTerm, true, term.viewportY)` repaints the
   rows in the old baked colors.
4. Even new output that arrives after a theme change still paints in the old
   colors. A fresh clear-and-reprint from the stub, after a switch to light,
   gave the pixel counts `[["22,22,30",11120],["169,177,214",274]]`. That is
   the dark theme.
5. A theme that goes to the `Terminal` constructor works correctly. The stored
   theme is therefore right after a page reload.

The `--pirate-*` custom properties and `term.options.theme` still change at
once. The menu, the login view, and the page background follow the new theme
with no reload. Only the canvas waits.

`src/theme.ts` keeps one call, `renderer.setTheme(theme)`. It is harmless, and
it holds the palette of the renderer correct for the next canvas rebuild.

### The line in the menu

The menu shows this line after a mode switch and after an import:

> The terminal keeps the old colors until a page reload. A reload stops the
> shell and starts a new shell.

The second sentence is not optional. `src/main.ts` documents that each client
owns one PTY, and that the server sends SIGHUP when the socket closes. A reload
therefore ends the running shell. The operator must read that cost before the
reload, not after it.

The menu has no reload button. One click that ends the shell of the operator is
a trap. A line of text is the correct control here.

The line shows on the change path only. `activate` of `src/theme.ts` shows it,
and the load path calls `paint` alone. A stored theme is already correct after a
reload, so a note on that path would name a reload for nothing.

### The two lines of the menu

`setMenuNote(text, tone)` writes one of two lines. The tone selects the line.

| Tone | Element | Color | For |
|---|---|---|---|
| `warn` (the default) | `#menu-note` | `--pirate-warn` | a fault |
| `muted` | `#menu-hint` | `--pirate-muted` | a normal result |

The theme line takes the muted tone. A theme change is a normal action with an
expected result, so the line reports a fact and not a fault. The warn color
stays for a refused chord, a fault of the store, and a file that does not parse.

The two elements are a contract, not a preference. `tests/prefs.spec.ts` and
`tests/menu.spec.ts` read an empty `#menu-note` as "the menu shows no fault". A
normal line in that element would report a fault that did not happen.

`tests/theme.spec.ts` measures all of this: the text stays on the screen, the
canvas keeps its ink, the empty rows keep the old background, the menu changes
at once, a theme change sends zero `0x01` frames, and the line shows on the
change path only.

## The DOM contract for the tests

| Selector | Meaning |
|---|---|
| `#menu` | the panel. `data-state` is `open`, `collapsed`, or `hidden` |
| `#menu-status` | the session status text. `data-state` is `ok`, `warn`, or `error` |
| `#menu-toggle` | the minus and plus control |
| `#menu-body` | the controls. Absent from the screen when collapsed |
| `#menu-note` | the fault line. Empty means "no fault" |
| `#menu-hint` | the line for a normal result, such as the theme line |
| `#theme-dark`, `#theme-light` | the mode buttons |
| `#theme-import` | the file input for a `.itermcolors` file |
| `#font-decrease`, `#font-value`, `#font-increase` | the font size row |
| `#repeat-decrease`, `#repeat-value`, `#repeat-increase` | the repeat rate row |
| `#key-toggleMenu`, `#key-fontIncrease`, `#key-fontDecrease` | the chord buttons |

`globalThis.__pirate` keeps the shape `{ term, state }`. `state` keeps its
four fields and gains these:

```ts
fontSize: number;
repeatRate: number;
repeatDelayMs: number;
mode: "dark" | "light";
themeName: string;
menu: "open" | "collapsed" | "hidden";
keys: Record<BindingId, string>;
```

Every assertion reads terminal state or `state`, never a glyph.

## Key repeat, and why the native repeat is suppressed

The operating system repeats a held key, and the browser sets
`KeyboardEvent.repeat` on those events. The rate and the first delay come from
the settings of the operating system, and they differ on every machine.

The requirement is a fixed contract: a delay of 0.6 s, then the configured
rate. A throttle on the native repeat cannot raise the rate above the rate of
the operating system, and it cannot hold the delay to 0.6 s.

Therefore the client suppresses the native repeat and generates its own. The
capture listener stops every event that carries `repeat === true`. A timer
then dispatches a synthetic `keydown` on the terminal container. ghostty-web
encodes that event with its own `KeyEncoder`, so the repeat uses the same
encoder as the first press, and the client keeps no key table.

## Restraint

No drop shadow. No glow. No gradient. No transition, and no animation. No
icon where a word is clearer. Every control earns its place.

## State

- Decided: this file.
- Verified: the baseline above.
- Open: everything in the waves below.
