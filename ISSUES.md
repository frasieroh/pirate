# Known defects and limits

This file records the defects and the limits that the port to `@beamterm/renderer`
found and did not correct. It is a record. It is not a plan.

Each entry gives four things: what an operator sees, the evidence, the cause when
it is known, and what a fix needs. Each entry also names one class.

| Class | Meaning |
|---|---|
| project | A defect of pirate. It is ours to correct. |
| ghostty-vt | A limit of `ghostty-vt.wasm` 0.4.0, from the npm package `ghostty-web`. |
| beamterm | A limit of `@beamterm/renderer` 1.0.0. |
| decision | A decision of the product manager. No correction is wanted. |

The product manager ranked entry 1 first. This file gives no rank to the other
entries.

An entry with no measurement of its own says "reported and not measured".

Every measurement below ran on macOS 15, arm64, with bun 1.3.14. A measurement
that names the wasm module used the raw exports of
`web/node_modules/ghostty-web/ghostty-vt.wasm`, with no code of the client.

`README.md` holds the features and the quickstart. `docs/building.md` holds the
toolchain and the build targets. This file repeats neither.

---

## 1. The palette index does not cross the wasm boundary

**Class:** ghostty-vt.

**The operator sees:** text that `ESC [ 38;5;16 m` colors takes the background
color of the theme. On the light theme that text is invisible. Eighteen more
color values take a theme color that the program did not ask for.

**Evidence:** measured. A write of `ESC [ 38;5;16 m` gives the cell foreground
0,0,0. A cell that no SGR touched gives the background 0,0,0. The two values are
equal, and `web/src/render/palette.ts` maps that value to the theme background.
Black is correct: `ESC [ 38;5;0 m` and `ESC [ 30 m` both give 29,31,33, which is
palette entry 0. A truecolor collision is real too. `ESC [ 38;2;204;102;102 m`
gives 204,102,102, and `ESC [ 31 m` gives the same three bytes. The map in
`web/src/render/palette.ts` holds 18 keys, so 18 values collide.

**Cause:** the 16-byte cell record carries three foreground bytes and three
background bytes. It carries no index. libghostty resolves the index inside the
module, before this client sees the cell. The reverse map in
`web/src/render/palette.ts` is a workaround. It cannot recover an index that the
module already destroyed.

**A fix needs:** a new export that gives the index, and a field for that index in
the cell record. Byte 15 of the record is padding today. `ghostty-vt.wasm` ships
prebuilt inside an npm package, so the change needs an upstream release or a wasm
build in this repository.

## 2. `ghostty_terminal_free` corrupts the heap of the module

**Class:** ghostty-vt.

**The operator sees:** nothing today. The client never frees a VT terminal, so
this defect cannot reach an operator now. It blocks every design that frees one.

**Evidence:** measured. A grid of 20 columns takes the two codepoints of `é`.
`ghostty_terminal_free` frees that grid. A second grid of 20 columns then reports
the codepoint 101 in cell 0, on a grid that holds nothing. The next
`ghostty_terminal_write` stops with "Out of bounds memory access". A grid of 80
columns gives the same two results. The column count is what matters. A second
grid of 31 columns, after a freed grid of 30 columns, stays clean. A
`ghostty_terminal_resize` on the second grid leaves cell 0 at the codepoint 233,
which is the `é` of the freed grid.

**Cause:** unknown. The fault is inside the module.

**A fix needs:** a corrected `ghostty-vt.wasm`, and an upstream issue for it. One
wasm module for each terminal is the other option, at the cost of one module
instance per terminal.

## 3. Blinking text renders steady

**Class:** decision, on a limit of `@beamterm/renderer` 1.0.0. Nothing here is
ours to correct.

**The operator sees:** a program that asks for blink gets steady text.

**Evidence:** measured by reading. The VT layer carries the flag:
`web/src/vt/types.ts` holds `BLINK = 64`, and `web/src/render/index.ts` masks it
out. The renderer offers no blink. Its type declaration,
`web/node_modules/@beamterm/renderer/dist/web/beamterm_renderer.d.ts`, gives
`bold`, `italic`, `underline`, and `strikethrough` on `CellStyle`, and nothing
else of this kind.

**Cause:** the renderer has no blink attribute.

**A fix needs:** a blink attribute in the renderer, or a shim in the client that
repaints on a timer. The product manager did not want a shim.

## 4. The per-cell hyperlink URI is partial

**Class:** ghostty-vt.

**The operator sees:** a stream with one OSC 8 URI gives that URI. A stream with
more than one URI gives null for every cell.

**Evidence:** measured. `ghostty-vt.wasm` 0.4.0 exports 77 symbols. Seventy-six
of them are functions, and no name matches uri, url, link, or hyper. The
ghostty-web layer returns a constant: `getHyperlinkUri` of
`web/node_modules/ghostty-web/dist/ghostty-web.js` gives `null` on every call.

**Reported and not measured:** that the module gives the id 1 to every cell with
a hyperlink. `web/src/vt/terminal.ts` holds that measurement from the run.

**Cause:** one id for every hyperlink. An id that cannot separate two URIs cannot
select one of them. `web/src/vt/osc8.ts` reads the URIs out of the byte stream
instead, and it answers null for an ambiguous stream. A wrong URI would send the
operator to the wrong page.

**A fix needs:** an export that gives the URI of a cell, or an id that differs
for each URI.

## 5. The byte order of `getColors` is unproven

**Class:** project. This is a gap in the evidence, not a known wrong result.

**The operator sees:** nothing. No wrong result is known.

**Evidence:** measured. The two default values are 0xcccccc for the foreground
and 0x000000 for the background. Each value reads the same in both byte orders,
so neither can prove the order. A third value is out of reach. A write of
`ESC ] 10 ; #ff0000 BEL` and of `ESC ] 11 ; #00ff00 BEL` leaves both values
unchanged, and the module logs
`warning(osc): OSC 10 requires an allocator, but none was provided`. The decode
in `web/src/vt/terminal.ts` matches the ghostty-web decode byte for byte.

**Note:** `web/tests/render.spec.ts` proves the byte order of the cell record.
That proof does not reach these two accessors.

**A fix needs:** a module build with an allocator for OSC 10, or another path
that sets a color which is not the same in both byte orders.

## 6. The renderer wasm file name carries no content hash

**Class:** project.

**The operator sees:** reported and not measured. After a version bump a browser
can hold the module of the old version.

**Evidence:** measured for the file name, and not measured for the browser.
`web/vite.config.ts` sets `assetFileNames` to `assets/[name].[ext]`. The build
writes `dist/assets/beamterm_renderer_bg.wasm`, 1385.79 kB. That name holds no
hash, so the next version reuses it. `crates/pirate/src/assets.rs` sends no
`Cache-Control` header and no `ETag`.

**Cause:** one `assetFileNames` pattern serves every asset of the build.

**A fix needs:** a content hash in the name of this one asset, or a validator
header from the server.

## 7. The license notice does not ship inside the binary

**Class:** project.

**The operator sees:** a user who gets the bare binary gets no third-party
notice. A user who unpacks the release tarball gets the notice beside the binary.

**Evidence:** measured by reading. `EXTRA_FILES` of `crates/xtask/src/dist.rs`
copies `LICENSE`, `README.md`, and `THIRD-PARTY-LICENSES.md` into the stage
folder of each tarball. `crates/pirate/src/assets.rs` embeds `web/dist` alone.
The third-party code is inside the binary. The notice of that code is not.

**Cause:** the notice is a release artifact and not a build input.

**Note:** this predates the port. It holds for `ghostty-web` and for
`@beamterm/renderer`.

**A fix needs:** the notice embedded in the binary, and a command that prints it.

## 8. A large column count changes nothing, in silence

**Class:** ghostty-vt.

**The operator sees:** nothing. No browser window reaches this width.

**Evidence:** measured, and the reported bound is corrected. The largest column
count that `ghostty_terminal_new` accepts is 47738. The count is the same at 1
row and at 24 rows. Above it the function gives the handle 0, which
`web/src/vt/terminal.ts` turns into an error. `ghostty_terminal_resize` is the
silent call. A grid of 80 columns, resized to 48128, to 48129, or to 60000, still
reports 80 columns of cells, and the module logs nothing. The run reported the
bound 48128. The measurement gives 47738, and it applies to
`ghostty_terminal_resize` alone.

**Cause:** unknown.

**A fix needs:** an error return from `ghostty_terminal_resize`, or a bound in
`web/src/vt/terminal.ts` below the measured limit.

## 9. The reconnect clause of the focus behavior has no end-to-end test

**Class:** project.

**The operator sees:** nothing. The claim under test is that a reconnect moves no
focus.

**Evidence:** measured by reading. `stop()` of `web/e2e/server.ts` sends SIGTERM
and then SIGKILL to the whole process, so it takes the server down with the
socket. `globalThis.__pirate` holds `term` and `state`, and neither one exposes
the socket. No test can therefore drop one socket and keep the server running.

**Cause:** the test surface has no way to reach one socket.

**A fix needs:** a hook on `__pirate` that closes the socket, or a server-side
command that closes one socket.

## 10. Two builds in one worktree collide on the Zig cache

**Class:** project. This is an environment collision and not a defect of the
product code.

**The operator sees:** an engineer sees
`failed to run custom build command for libghostty-vt-sys`.

**Evidence:** reported three times in the run, and not reproduced here. The same
crate gave two other faults in this worktree, and both came from the tool path on
macOS, not from a cache collision. `mise.toml` puts one Zig cache in
`.toolchain/zig-cache` for the whole repository. That cache is the shared
resource.

**The correction.** Run the repository-root command set first. Then run the web
command set. Do not run the two at the same time.

**Note:** `docs/building.md` holds the macOS path rules. This entry adds nothing
to them.

## 11. `web/src/font.ts` names a guard that the port removed

**Class:** project. This is a design question and not stale prose.

**The operator sees:** nothing. No wrong result is known.

**Evidence:** measured by reading. The header of `web/src/font.ts` says that the
setter of ghostty-web runs its font path only for a new value. The `fontSize`
setter of `PirateTerminal`, in `web/src/terminal.ts`, calls
`renderer.setFontSize` on every write. `setSize` of `web/src/font.ts` still
returns early for an equal value, so no path writes the same size twice today.

**Cause:** the port replaced the ghostty-web setter and kept the header.

**A fix needs:** a decision. Either the guard returns to the setter, or the header
loses the claim.

## 12. `web/src/theme.ts` names a cause that no longer holds

**Class:** project. This is a design question and not stale prose.

**The operator sees:** a theme change builds the terminal facade again. Entry 13
holds the cost of that rebuild.

**Evidence:** measured by reading. The comment in `activate` says that ghostty-web
bakes the cell colors at `open()`. `paint` of the same file writes
`runtime.term.options.theme`, and that setter, in `web/src/terminal.ts`, calls
`renderer.setTheme` at once. The rebuild survives because
`web/tests/theme.spec.ts` asserts that the terminal changes identity.

**Cause:** the port made the repaint live and kept the rebuild.

**A fix needs:** a decision on the rebuild. A rebuild that goes away needs that
assertion changed too.

## 13. A theme change costs the scrollback

**Class:** decision.

**The operator sees:** after a theme change the scrollback is empty. The screen,
the shell, and the socket survive.

**Evidence:** measured by reading. `rebuild` of `web/src/main.ts` writes RIS
before it asks the server for the dump, and that dump carries the screen alone.

**Cause:** nothing in the client holds a copy of the scrollback.

**Note:** the client before the port lost the scrollback the same way. This is a
known behavior and not a regression.

**A fix needs:** a copy of the scrollback in the client, or a dump that carries
it.

## 14. Two copies of the browser launch arguments

**Class:** project.

**The operator sees:** nothing. Both copies hold the same one flag.

**Evidence:** measured by reading. `WEBGL_ARGS` of `web/e2e/browser.ts` and
`WEBGL_ARGS` of `web/tests/harness.ts` both hold `--enable-unsafe-swiftshader`.
The comments differ. `web/tests/harness.ts` carries three paragraphs that
`web/e2e/browser.ts` does not. No test in either suite reads the list of the
other, so a difference of value fails no test. Only a rebase surfaced the drift.

**Cause:** the copy is deliberate. `web/tests/harness.ts` starts the stub server
when it is imported, and the e2e suite must start no stub.

**A fix needs:** a third module that holds the list and starts nothing, or a test
that compares the two lists.

## 15. One branch reached main with no adversarial review

**Class:** project.

**The operator sees:** nothing. No defect is known in that code.

**Evidence:** measured by reading the history. The merge `46caf56` carries five
commits: `683ce9e`, `209a2bb`, `c440bbf`, `0e75165`, and `6ea99e8`. None of them
carries a `review:` subject. The three other branches of the renderer track each
carry one: `cbdb212` on the VT resize branch, `8764efa` and `fb9cd82` on the grid
renderer branch, and six commits on `61aced1`. The author of the five commits ran
the full command set and mutated its own guards in both directions.

**Reported and not measured:** that each of those three reviews found a blocker
that the author missed. Only the subject lines were read here, not the reports.

**Cause:** the session ended before the review of that branch ran.

**A fix needs:** a review of those five commits by an engineer that did not write
them.

## 16. The vendored wasm module is larger than the npm module of upstream

**Class:** project.

**The operator sees:** nothing. The binary ships a larger wasm module than the
one that upstream publishes on npm.

**Evidence:** measured by reading `docs/building.md`. The vendored module is
1.58 MB. The npm module of upstream is 1.39 MB. `docs/building.md:84` records
both values.

**Cause:** the build runs no `wasm-opt` pass. The pin of binaryen needs two
exception lists in `cargo xtask verify-pins`. One of the two is necessary
because the aqua package of binaryen publishes no linux-arm64 binary. That
package declares `supported_envs: [darwin, amd64]`, and this repository builds
and pins the linux-arm64 platform.

**A fix needs:** a wasm optimizer that covers all four platforms.
