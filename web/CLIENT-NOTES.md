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

After the theme rebuild: 66 pass, 0 fail, 11 files, 77.83 s.

After the repair of the rebuild, which added the open-socket rule, the removal
of the leaked listener, and three tests: 69 pass, 0 fail, 11 files, 77.68 s.

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
that value in `BACKGROUND`, and the paint measurement compares against it by
default. A test that changed the theme passes the background of the new theme
to `paintedPixels`. A count against the wrong background counts the whole row,
because one background differs from the other on every pixel.

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

## The theme repaint: the limit of ghostty-web, and the correction

Decided. Do not reopen the measurements.

ghostty-web 0.4.0 cannot recolor a canvas that already holds text. An in-place
theme repaint is not possible with this build, and the client does not try.

The client corrects the result with a rebuild. A theme change builds a NEW
`Terminal` with the new theme, opens it on the same container, and asks the
server for a full-state dump with one `0x02` frame. The socket stays open, so
the shell survives and the operator loses no session. The terminal, the menu,
the login view, and the page all hold the new theme, and no part of the client
waits for a page reload.

Several workers each claimed a targeted in-place fix. Every claim failed under
measurement. The measurements stay in this file, because they are the evidence
for why a rebuild is the only remedy. The client engineering manager measured
these five facts against the real client and the stub server:

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
5. A theme that goes to the `Terminal` constructor works correctly. Point 5 is
   the whole basis of the rebuild: the constructor is the one path that colors
   the screen.

`src/theme.ts` calls `renderer.setTheme` no more. The call painted nothing, and
the terminal that carries the theme now comes from the constructor.

### How the rebuild works

`src/main.ts` owns it. `rebuild(theme)` of the `Runtime` record does this:

1. It tests the socket. A rebuild runs only with an open socket. The next
   section holds the rule.
2. It disposes the old terminal. `dispose` removes the canvas and the hidden
   textarea from `#terminal`. It leaves one document listener, and `rebuild`
   removes that one itself. The section after the next holds the fault.
3. It builds a new `Terminal` with the new theme and the current font size,
   loads a new `FitAddon`, opens it on the same container, registers
   `term.onData`, and attaches the key correction of `src/input.ts` again. A
   new terminal carries no custom key handler.
4. It fits the new terminal to the container.
5. It sends one `0x02` frame. The server answers with the `0x01` full-state
   dump, the same dump that it sends when a socket opens, and the dump refills
   the screen.

`runtime.term` and `globalThis.__pirate.term` are getters, never values that a
module captured once. A rebuild replaces the object behind both.

### The rule: a rebuild needs an open socket

The dump is the ONLY thing that refills the new terminal. Nothing in the client
holds a copy of the screen. A rebuild with a closed socket therefore disposes
the screen and gets nothing back, because `send` of `src/main.ts` drops a frame
on a closed socket, in silence.

The worst case is a shell that exited. `onclose` never reconnects after a
server `0x02` frame, so the old terminal holds the last output of that shell.
A rebuild there would end with a blank screen and no way back to that output.

`rebuild` therefore tests `socket !== undefined && socket.readyState ===
WebSocket.OPEN` first. With a closed socket it disposes NOTHING:

- The old terminal stays, with its text.
- The theme goes to `pendingTheme`.
- The menu gets one muted line: `The terminal takes the new colors with the
  next shell.` The line is true for a dead shell and for a reconnect that runs,
  and it names no page reload, because a reload is never the remedy here.

`ws.onopen` takes `pendingTheme`. It sets `sentCols` and `sentRows`, sends the
first resize frame, then rebuilds with the pending theme, clears `pendingTheme`,
and clears the muted line. The socket is open on that path, so the dump request
goes out.

The page, the menu, and the login view take the new colors at once in every
case. `paint` of `src/theme.ts` runs before `rebuild`, and it never depends on
the socket. A caller of `rebuild` needs no knowledge of the socket: the whole
rule lives in `src/main.ts`.

### The listener that ghostty-web 0.4.0 leaks

`Terminal.open()` registers `document.addEventListener("mouseup",
this.handleMouseUp)`. `dispose()` sets `this.isOpen = false` BEFORE it calls
`cleanupComponents()`, and `cleanupComponents` removes that listener only under
a guard that reads `this.isOpen`. The guard is false by then, so the listener
stays. Read `dispose`, `cleanupComponents`, and `handleMouseUp` in
`node_modules/ghostty-web/dist/ghostty-web.js`.

Each leaked closure retains the dead terminal, its canvas, its renderer, and
its wasm handle. The count grows by one for each theme change of a session.

`rebuild` therefore removes the listener itself, after `term.dispose()`, with
the `handleMouseUp` property that the terminal still holds. The call sits under
a guard on the type of that property, so a later ghostty-web that cleans the
listener up itself, or that renames the property, still works.
`tests/theme.spec.ts` counts the document `mouseup` listeners over two theme
changes: the count is 0 with the correction and +2 without it.

The load path rebuilds nothing. `activate` of `src/theme.ts` runs for an
operator change and calls `rebuild`. The load path calls `paint` alone, because
`src/main.ts` already gave the stored theme to the constructor.

### The one cost of the rebuild

The dump carries the screen and not the scrollback. The scrollback of the old
terminal goes with the old terminal, so a theme change loses it. The screen,
the shell, and the socket all survive.

The menu shows no line for a theme change that rebuilds. The old line named a
page reload and the loss of the shell. Both are gone, so the line went with
them. A theme change with a closed socket is the one case that still writes a
line, and that line names the next shell and no reload. The menu still has no
reload button.

### The rule that stays: no spurious resize frame

A new terminal starts at the default size, so a test against `term.cols` would
report a change for every rebuild. `src/main.ts` therefore tracks the last size
that it SENT, in `sentCols` and `sentRows`. These two values are not a
guarantee about the server: `applyFit` writes both before it calls `send`, and
`send` drops the frame on a closed socket. `ws.onopen` rewrites both from the
terminal on every open and sends that size, so no drift survives a reconnect.

`applyFit` resizes the local terminal against `term.cols` and `term.rows`, and
it sends a `0x01` frame only against `sentCols` and `sentRows`.

A theme change that does not change the size sends ZERO resize frames. A
rebuild that changes the size sends exactly one.

### The two lines of the menu

`setMenuNote(text, tone)` writes one of two lines. The tone selects the line.

| Tone | Element | Color | For |
|---|---|---|---|
| `warn` (the default) | `#menu-note` | `--pirate-warn` | a fault |
| `muted` | `#menu-hint` | `--pirate-muted` | a normal result |

The muted line has one writer: `src/main.ts` writes it for a theme change that
found no open socket, and clears it when the rebuild runs on the next open
socket. `src/theme.ts` writes no line at all. The warn line stays for a refused
chord, a fault of the store, and a file that does not parse.

The two elements are a contract, not a preference. `tests/prefs.spec.ts` and
`tests/menu.spec.ts` read an empty `#menu-note` as "the menu shows no fault". A
normal line in that element would report a fault that did not happen.

`tests/theme.spec.ts` measures all of this: a theme change builds a new
terminal, the dump refills the screen of that terminal, the new terminal holds
the new theme and its canvas paints the new background, the menu changes at
once, the stub still counts one connection and a key still arrives as a `0x00`
frame, a theme change sends one `0x02` frame and zero `0x01` frames, a page load
sends no `0x02` frame, and both lines of the menu stay empty.

It measures the closed socket too: a theme change after a server `0x02` exit
frame keeps the SAME terminal object with the text of the dead shell on it and
sends no dump request, a theme change on a closed socket writes the muted line,
and the reconnect that follows gives a new terminal object that carries the new
colors in `term.options.theme`. One more test counts the document `mouseup`
listeners over two rebuilds.

## The DOM contract for the tests

| Selector | Meaning |
|---|---|
| `#menu` | the panel. `data-state` is `open`, `collapsed`, or `hidden` |
| `#menu-status` | the session status text. `data-state` is `ok`, `warn`, or `error` |
| `#menu-toggle` | the minus and plus control |
| `#menu-body` | the controls. Absent from the screen when collapsed |
| `#menu-note` | the fault line. Empty means "no fault" |
| `#menu-hint` | the line for a normal result. Empty means "no result to report" |
| `#theme-dark`, `#theme-light` | the mode buttons |
| `#theme-import` | the file input for a `.itermcolors` file |
| `#font-decrease`, `#font-value`, `#font-increase` | the font size row |
| `#repeat-decrease`, `#repeat-value`, `#repeat-increase` | the repeat rate row |
| `#key-toggleMenu`, `#key-fontIncrease`, `#key-fontDecrease` | the chord buttons |

`globalThis.__pirate` keeps the shape `{ term, state }`. `term` is a GETTER: a
theme change replaces the terminal, and a test that captured the object once
would read a dead terminal after it. `state` keeps its four fields and gains
these:

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
