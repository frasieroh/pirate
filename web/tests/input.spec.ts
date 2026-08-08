/**
 * Input frames: tag `0x00` from the client.
 *
 * `PirateTerminal` of `src/terminal.ts` attaches one keydown listener and
 * encodes each key with the KeyEncoder of libghostty, through `vt.encodeKey`.
 * The one key table of the client is `KEY_OF_CODE`, at `src/terminal.ts:53`.
 * It maps `KeyboardEvent.code` to a `VtKey`, and the wasm encoder makes the
 * bytes. `src/main.ts` sends the bytes of the `onData` event as one `0x00`
 * frame, and it holds no key table and no encoder. These tests assert the
 * exact bytes that the stub server received.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  ESC,
  framesWithTag,
  hex,
  idle,
  paintedPixels,
  server,
  viewportLine,
  waitFor,
  withClient,
} from "./harness";
import type { Stub } from "./stub-server";

beforeEach(() => {
  server().reset();
});

/** Press one key and return the frame that the client sent for it. */
async function press(page: Page, stub: Stub, key: string): Promise<Uint8Array> {
  const first = stub.received.length;
  await page.keyboard.press(key);
  await waitFor(
    async () => stub.received.length,
    (count) => count > first,
    `a frame for ${key}`,
  );
  return stub.received[first];
}

/** The frame for a key, as hexadecimal, with the tag byte shown separately. */
function show(key: string, frame: Uint8Array): string {
  return `  ${key.padEnd(12)} tag ${hex(frame.subarray(0, 1))}  payload ${hex(frame.subarray(1))}`;
}

test("the client takes the keyboard focus at load, with no click", async () => {
  // Every other test in this file calls `page.focus("#terminal")` first. That
  // call is a precondition that no test asserted. It can also hide a fault. A
  // client that takes no focus at load sends nothing for the keystrokes of an
  // operator, until a click lands on the page. Every other test still passes
  // over that fault. This test presses one key with no focus call and no
  // click.
  //
  // The constructor of `PirateTerminal` takes the focus at
  // `src/terminal.ts:354`.
  const stub = server();

  await withClient(async (page) => {
    const first = stub.received.length;
    await page.keyboard.press("x");
    await waitFor(
      async () => stub.received.length,
      (count) => count > first,
      "an input frame with no focus call and no click",
    );
    expect(Array.from(stub.received[first])).toEqual([0x00, 0x78]);
  });
});

test("each key gives one 0x00 frame with the encoded bytes", async () => {
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    const cases: Array<{ key: string; expected: number[]; note: string }> = [
      { key: "a", expected: [0x00, 0x61], note: "a letter" },
      { key: "Z", expected: [0x00, 0x5a], note: "a capital letter" },
      { key: "Enter", expected: [0x00, 0x0d], note: "carriage return" },
      { key: "Backspace", expected: [0x00, 0x7f], note: "delete" },
      { key: "Tab", expected: [0x00, 0x09], note: "tab" },
      { key: "ArrowUp", expected: [0x00, 0x1b, 0x5b, 0x41], note: "cursor up" },
      { key: "ArrowDown", expected: [0x00, 0x1b, 0x5b, 0x42], note: "cursor down" },
      { key: "ArrowRight", expected: [0x00, 0x1b, 0x5b, 0x43], note: "cursor right" },
      { key: "ArrowLeft", expected: [0x00, 0x1b, 0x5b, 0x44], note: "cursor left" },
      { key: "Control+c", expected: [0x00, 0x03], note: "interrupt" },
      { key: "Control+d", expected: [0x00, 0x04], note: "end of transmission" },
    ];

    const lines: string[] = [];
    for (const item of cases) {
      const frame = await press(page, stub, item.key);
      lines.push(`${show(item.key, frame)}  (${item.note})`);
      expect(Array.from(frame)).toEqual(item.expected);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});

/**
 * Press one key and prove that it gives exactly one `0x00` frame.
 *
 * This is the double-send guard for the corrected chords. It waits for the
 * first frame, then it waits again, so that a second frame from a double
 * path has time to arrive. It fails the test when a second frame appears.
 */
async function pressOnce(page: Page, stub: Stub, key: string): Promise<Uint8Array> {
  const before = framesWithTag(stub.received, 0x00).length;
  await page.keyboard.press(key);
  await waitFor(
    async () => framesWithTag(stub.received, 0x00).length,
    (count) => count > before,
    `a frame for ${key}`,
  );
  // A settle wait. A duplicate frame from a double path would arrive inside
  // this window, well before a human could press the next key.
  await idle(150);
  const after = framesWithTag(stub.received, 0x00).length;
  expect(after).toBe(before + 1);
  return framesWithTag(stub.received, 0x00)[after - 1];
}

test("the corrected chords give the right bytes, each in one frame", async () => {
  // These seven chords go through `attachCustomKeyEventHandler` in
  // `src/input.ts`, and each must give exactly one frame, with the bytes of a
  // real terminal. `src/input.ts` states the bytes that the fallback encoder
  // gave for each chord, measured with the correction branch disabled. Five
  // of the seven differ from the bytes below. Ctrl+V and Shift+Tab do not:
  // the fallback gave `16` and `1b 5b 5a` for those two, so the correction
  // changes no byte for them today. These assertions hold the contract for
  // all seven.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    const cases: Array<{ key: string; expected: number[]; note: string }> = [
      { key: "Control+v", expected: [0x00, 0x16], note: "paste to the shell, SYN" },
      { key: "Control+i", expected: [0x00, 0x09], note: "tab, not a Kitty sequence" },
      { key: "Control+m", expected: [0x00, 0x0d], note: "carriage return, not a Kitty sequence" },
      {
        key: "Control+BracketLeft",
        expected: [0x00, 0x1b],
        note: "escape, the vim escape chord",
      },
      { key: "Control+Minus", expected: [0x00, 0x1f], note: "unit separator" },
      { key: "Shift+Tab", expected: [0x00, 0x1b, 0x5b, 0x5a], note: "CSI Z, the backtab" },
      { key: "Alt+b", expected: [0x00, 0x1b, 0x62], note: "ESC then the letter, backward word" },
      { key: "Alt+f", expected: [0x00, 0x1b, 0x66], note: "ESC then the letter, forward word" },
      { key: "Alt+d", expected: [0x00, 0x1b, 0x64], note: "ESC then the letter, delete word" },
    ];

    const lines: string[] = [];
    for (const item of cases) {
      const frame = await pressOnce(page, stub, item.key);
      lines.push(`${show(item.key, frame)}  (${item.note})`);
      expect(Array.from(frame)).toEqual(item.expected);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});

test("Alt plus a letter reads event.code, not the composed macOS character", async () => {
  // On a real macOS keyboard, Option plus a letter gives a composed
  // character in `event.key`, not the plain letter: `∫` for Option+B, `∂`
  // for Option+D, `ƒ` for Option+F. `page.keyboard.press("Alt+b")` cannot
  // show this: Playwright gives the literal `b` as `event.key`, with no
  // composition. This test dispatches the real macOS pairs directly.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    const cases: Array<{
      key: string;
      code: string;
      shiftKey?: boolean;
      expected: number[];
      note: string;
    }> = [
      { key: "∫", code: "KeyB", expected: [0x00, 0x1b, 0x62], note: "Option+B, backward word" },
      { key: "∂", code: "KeyD", expected: [0x00, 0x1b, 0x64], note: "Option+D, delete word" },
      { key: "ƒ", code: "KeyF", expected: [0x00, 0x1b, 0x66], note: "Option+F, forward word" },
      {
        key: "´",
        code: "KeyB",
        shiftKey: true,
        expected: [0x00, 0x1b, 0x42],
        note: "Option+Shift+B, Shift still applies",
      },
    ];

    const lines: string[] = [];
    for (const item of cases) {
      const before = stub.received.length;
      await page.evaluate(
        (args: { key: string; code: string; shiftKey: boolean }) => {
          const field = document.querySelector("#terminal textarea") as HTMLElement;
          field.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: args.key,
              code: args.code,
              altKey: true,
              shiftKey: args.shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        { key: item.key, code: item.code, shiftKey: item.shiftKey ?? false },
      );
      await waitFor(
        async () => stub.received.length,
        (count) => count > before,
        `a frame for ${item.note}`,
      );
      const frame = stub.received[before];
      lines.push(`${show(`${item.code}${item.shiftKey ? "+shift" : ""}`, frame)}  (${item.note})`);
      expect(Array.from(frame)).toEqual(item.expected);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});

test("a broad sweep of chords gives one frame each, with the right bytes", async () => {
  // This sweep covers Control with every letter, the control punctuation
  // chords, the navigation keys, the function keys, and more. Every chord
  // here must give exactly one frame. A double path would show as two.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");

    const cases: Array<{ key: string; expected: number[] }> = [
      // Control plus every letter. The byte is the position of the letter
      // in the alphabet: Control+a gives 0x01, Control+z gives 0x1a.
      ...Array.from({ length: 26 }, (_unused, i) => {
        const letter = String.fromCharCode(0x61 + i);
        return { key: `Control+${letter}`, expected: [0x00, i + 1] };
      }),
      { key: "Control+Space", expected: [0x00, 0x00] },
      { key: "Control+Backslash", expected: [0x00, 0x1c] },
      { key: "Control+BracketLeft", expected: [0x00, 0x1b] },
      { key: "Control+BracketRight", expected: [0x00, 0x1d] },
      { key: "Control+Minus", expected: [0x00, 0x1f] },
      { key: "ArrowUp", expected: [0x00, 0x1b, 0x5b, 0x41] },
      { key: "ArrowDown", expected: [0x00, 0x1b, 0x5b, 0x42] },
      { key: "ArrowLeft", expected: [0x00, 0x1b, 0x5b, 0x44] },
      { key: "ArrowRight", expected: [0x00, 0x1b, 0x5b, 0x43] },
      { key: "Home", expected: [0x00, 0x1b, 0x5b, 0x48] },
      { key: "End", expected: [0x00, 0x1b, 0x5b, 0x46] },
      { key: "PageUp", expected: [0x00, 0x1b, 0x5b, 0x35, 0x7e] },
      { key: "PageDown", expected: [0x00, 0x1b, 0x5b, 0x36, 0x7e] },
      { key: "Insert", expected: [0x00, 0x1b, 0x5b, 0x32, 0x7e] },
      { key: "Delete", expected: [0x00, 0x1b, 0x5b, 0x33, 0x7e] },
      { key: "F1", expected: [0x00, 0x1b, 0x4f, 0x50] },
      { key: "F2", expected: [0x00, 0x1b, 0x4f, 0x51] },
      { key: "F3", expected: [0x00, 0x1b, 0x4f, 0x52] },
      { key: "F4", expected: [0x00, 0x1b, 0x4f, 0x53] },
      { key: "F5", expected: [0x00, 0x1b, 0x5b, 0x31, 0x35, 0x7e] },
      { key: "F6", expected: [0x00, 0x1b, 0x5b, 0x31, 0x37, 0x7e] },
      { key: "F7", expected: [0x00, 0x1b, 0x5b, 0x31, 0x38, 0x7e] },
      { key: "F8", expected: [0x00, 0x1b, 0x5b, 0x31, 0x39, 0x7e] },
      { key: "F9", expected: [0x00, 0x1b, 0x5b, 0x32, 0x30, 0x7e] },
      { key: "F10", expected: [0x00, 0x1b, 0x5b, 0x32, 0x31, 0x7e] },
      { key: "F11", expected: [0x00, 0x1b, 0x5b, 0x32, 0x33, 0x7e] },
      { key: "F12", expected: [0x00, 0x1b, 0x5b, 0x32, 0x34, 0x7e] },
      { key: "Escape", expected: [0x00, 0x1b] },
      { key: "Tab", expected: [0x00, 0x09] },
      { key: "Shift+Tab", expected: [0x00, 0x1b, 0x5b, 0x5a] },
      { key: "Enter", expected: [0x00, 0x0d] },
      { key: "Backspace", expected: [0x00, 0x7f] },
      // Not Alt+h, Alt+minus, or Alt+equal: those are the menu hotkeys, and
      // `src/keys.ts` swallows them before they reach the terminal.
      { key: "Alt+n", expected: [0x00, 0x1b, 0x6e] },
      { key: "Alt+w", expected: [0x00, 0x1b, 0x77] },
      { key: "Alt+t", expected: [0x00, 0x1b, 0x74] },
    ];

    for (const item of cases) {
      const frame = await pressOnce(page, stub, item.key);
      expect(Array.from(frame)).toEqual(item.expected);
    }
  });
});

test("typed text gives one frame for each character", async () => {
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const first = stub.received.length;
    await page.keyboard.type("ls");
    await waitFor(
      async () => stub.received.length,
      (count) => count >= first + 2,
      "two input frames",
    );
    expect(Array.from(stub.received[first])).toEqual([0x00, 0x6c]);
    expect(Array.from(stub.received[first + 1])).toEqual([0x00, 0x73]);
  });
});

// ── the clipboard chords ──────────────────────────────────────────────────
//
// Criterion 27 has two halves, and a test that asserts one half alone passes
// over the defect. The defect that this section pins: the chord performed its
// clipboard action AND sent characters to the shell. A test that asserts the
// clipboard content alone never sees those characters. Every test below
// therefore asserts the socket as well: a copy chord and an idle chord carry
// ZERO `0x00` frames, and a paste chord carries exactly ONE, with the
// clipboard text as its whole payload.
//
// The chord table that these tests pin. Both pairs work on every platform,
// because the handler reads `metaKey`, `ctrlKey`, and `shiftKey` alone.
//
//   Cmd+C          copy    0 bytes to the shell
//   Ctrl+Shift+C   copy    0 bytes to the shell
//   Cmd+V          paste   the clipboard text alone
//   Ctrl+Shift+V   paste   the clipboard text alone
//   Ctrl+V         none    16, SYN, the byte of a real terminal

/** The copy chords, in the order of the report. */
const COPY_CHORDS = ["Meta+KeyC", "Control+Shift+KeyC"];
/** The paste chords, in the order of the report. */
const PASTE_CHORDS = ["Meta+KeyV", "Control+Shift+KeyV"];

/** The text of the payload of one input frame. */
function payloadText(frame: Uint8Array): string {
  return new TextDecoder().decode(frame.subarray(1));
}

/**
 * Grant the clipboard permissions, and assert the grant.
 *
 * This grant is a precondition of every test below. Measured in the Chromium
 * of this harness, with no grant: `writeText` and `readText` are both
 * rejected with a permission error, and the client then copies nothing and
 * pastes nothing. A test that presses a chord without this call therefore
 * measures the permission, not the chord. The assertion names the
 * precondition instead of trusting it.
 *
 * A browser asks the operator for `clipboard-read` once per origin.
 * `src/input.ts` states that tradeoff and the measurement behind it.
 */
async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await page.evaluate(async () => {
    const read = await navigator.permissions.query({
      name: "clipboard-read" as PermissionName,
    });
    return read.state;
  });
  expect(state).toBe("granted");
}

/** The text of the system clipboard. */
function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Put `text` on the system clipboard, and assert that it is there.
 *
 * `withClient` opens a new browser context for each test, and the clipboard
 * outlives that context. A test that reads an expected value therefore can
 * read a value that an earlier test wrote, and it then passes while the copy
 * under test does nothing. Every test below writes a sentinel first.
 */
async function seedClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((value: string) => navigator.clipboard.writeText(value), text);
  expect(await clipboardText(page)).toBe(text);
}

/**
 * Press `key` and prove that the client sent NO input frame for it.
 *
 * The wait is longer than the wait of `pressOnce`, because the client reads
 * the clipboard in a later task. A byte from a wrong branch arrives inside
 * this window.
 */
async function pressSilently(page: Page, stub: Stub, key: string): Promise<void> {
  const before = framesWithTag(stub.received, 0x00).length;
  await page.keyboard.press(key);
  await idle(300);
  const after = framesWithTag(stub.received, 0x00);
  expect(after.map((frame) => hex(frame))).toEqual(
    framesWithTag(stub.received, 0x00)
      .slice(0, before)
      .map((frame) => hex(frame)),
  );
  expect(after.length).toBe(before);
}

/** Press `key` and return the one input frame that the client sent for it. */
async function pasteFrame(page: Page, stub: Stub, key: string): Promise<Uint8Array> {
  const before = framesWithTag(stub.received, 0x00).length;
  await page.keyboard.press(key);
  await waitFor(
    async () => framesWithTag(stub.received, 0x00).length,
    (count) => count > before,
    `a paste frame for ${key}`,
  );
  // A settle wait. A key byte from a second path would arrive inside this
  // window, next to the paste.
  await idle(200);
  const after = framesWithTag(stub.received, 0x00);
  expect(after.length).toBe(before + 1);
  return after[before];
}

/** Write `text` to the terminal and wait until row 0 holds `first`. */
async function writeAndPaint(page: Page, text: string, first: string): Promise<void> {
  server().send([{ tag: 0x00, text }]);
  await waitFor(
    () => viewportLine(page, 0),
    (line) => line === first,
    "row 0",
  );
  await waitFor(
    () => paintedPixels(page, 0),
    (count) => count > 50,
    "paint on row 0",
  );
}

/**
 * Drag the left button from one cell to another, with real mouse input.
 *
 * `@beamterm/renderer` attaches its mouse listeners to the canvas from Rust,
 * so a synthetic `MouseEvent` moves nothing. Every coordinate comes from the
 * box of the canvas and from the cell size that the renderer reports. The
 * assertions name the preconditions: one canvas, a box that is not empty, a
 * cell size of more than zero, and a grid that holds every cell of the drag.
 */
async function dragCells(
  page: Page,
  from: { col: number; row: number },
  to: { col: number; row: number },
): Promise<void> {
  const count = await page.evaluate(() => document.querySelectorAll("#terminal canvas").length);
  expect(count).toBe(1);
  const box = await page.locator("#terminal canvas").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);

  const grid = await page.evaluate(() => {
    const renderer = (
      globalThis as unknown as {
        __pirate: {
          term: {
            renderer: { cellSize(): { width: number; height: number }; cols: number; rows: number };
          };
        };
      }
    ).__pirate.term.renderer;
    const size = renderer.cellSize();
    return { width: size.width, height: size.height, cols: renderer.cols, rows: renderer.rows };
  });
  expect(grid.width).toBeGreaterThan(0);
  expect(grid.height).toBeGreaterThan(0);
  for (const target of [from, to]) {
    expect(target.col).toBeLessThan(grid.cols);
    expect(target.row).toBeLessThan(grid.rows);
  }

  const at = (col: number, row: number): [number, number] => [
    box!.x + (col + 0.5) * grid.width,
    box!.y + (row + 0.5) * grid.height,
  ];
  const [x0, y0] = at(from.col, from.row);
  const [x1, y1] = at(to.col, to.row);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

test("a copy chord copies the selection and sends no byte to the shell", async () => {
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await writeAndPaint(page, "hello world", "hello world");
    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 0 });
    expect(
      await page.evaluate(() =>
        (
          globalThis as unknown as { __pirate: { selection: { text(): string } } }
        ).__pirate.selection.text(),
      ),
    ).toBe("hello");
    await page.focus("#terminal");

    for (const key of COPY_CHORDS) {
      // The package copies on its own at the mouse-up of a drag
      // (`src/select.ts:6`). The sentinel removes that copy, so the assertion
      // below reads the copy of the chord alone.
      await seedClipboard(page, `<no copy for ${key}>`);
      await pressSilently(page, stub, key);
      await waitFor(
        () => clipboardText(page),
        (text) => text === "hello",
        `the clipboard after ${key}`,
      );
      expect(await clipboardText(page)).toBe("hello");
    }
  });
});

test("a copy chord with no selection keeps the clipboard and sends no byte", async () => {
  // The empty input. A write of the empty string would drop the text that the
  // operator copied before, and the fallback encoder would send a byte.
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    for (const key of COPY_CHORDS) {
      await seedClipboard(page, "<kept>");
      await pressSilently(page, stub, key);
      await idle(150);
      expect(await clipboardText(page)).toBe("<kept>");
    }
  });
});

test("a paste chord sends the clipboard text, and no key byte with it", async () => {
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    const lines: string[] = [];
    for (const key of PASTE_CHORDS) {
      await seedClipboard(page, "echo hi");
      const frame = await pasteFrame(page, stub, key);
      lines.push(show(key, frame));
      // The whole payload is the clipboard text. A `v` byte from the fallback
      // encoder, or a Kitty sequence from it, would appear here.
      expect(payloadText(frame)).toBe("echo hi");
      expect(Array.from(frame)).toEqual([0x00, ...Array.from(new TextEncoder().encode("echo hi"))]);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});

test("an empty clipboard sends nothing for a paste chord", async () => {
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    for (const key of PASTE_CHORDS) {
      await seedClipboard(page, "");
      await pressSilently(page, stub, key);
    }
  });
});

test("Ctrl+V sends SYN and pastes nothing", async () => {
  // Criterion 27 keeps this byte. `Ctrl+V` is the chord of a real terminal,
  // and it is not a paste chord. The single frame proves that no clipboard
  // text follows the byte.
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await seedClipboard(page, "MUST NOT PASTE");
    await page.focus("#terminal");

    const frame = await pressOnce(page, stub, "Control+v");
    expect(Array.from(frame)).toEqual([0x00, 0x16]);
    // A paste would arrive as a second frame. `pressOnce` waits 150 ms, and
    // this wait adds to it, because the clipboard read is asynchronous.
    await idle(200);
    const tail = framesWithTag(stub.received, 0x00);
    expect(payloadText(tail[tail.length - 1])).toBe("\x16");
  });
});

test("a paste chord wraps the text when bracketed paste is on", async () => {
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    // Bracketed paste is off after a load, so the paste carries no marker.
    await seedClipboard(page, "plain");
    expect(payloadText(await pasteFrame(page, stub, "Meta+KeyV"))).toBe("plain");

    // `ESC [?2004h` turns bracketed paste on. The shell of the operator sends
    // this sequence itself.
    stub.send([{ tag: 0x00, text: `${ESC}[?2004h` }]);
    await idle(150);

    await seedClipboard(page, "wrapped");
    expect(payloadText(await pasteFrame(page, stub, "Meta+KeyV"))).toBe(
      `${ESC}[200~wrapped${ESC}[201~`,
    );

    // A clipboard that carries the end marker cannot close the block early.
    // Without this guard the shell reads `rm -rf /` as typed input and runs
    // it on the carriage return that follows.
    await seedClipboard(page, `a${ESC}[201~rm -rf /\n`);
    expect(payloadText(await pasteFrame(page, stub, "Meta+KeyV"))).toBe(
      `${ESC}[200~arm -rf /\r${ESC}[201~`,
    );

    // `ESC [?2004l` turns bracketed paste off again.
    stub.send([{ tag: 0x00, text: `${ESC}[?2004l` }]);
    await idle(150);
    await seedClipboard(page, "bare");
    expect(payloadText(await pasteFrame(page, stub, "Meta+KeyV"))).toBe("bare");
  });
});

test("a paste sends one carriage return for each line break", async () => {
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    await seedClipboard(page, "one\ntwo\r\nthree\rfour");
    const frame = await pasteFrame(page, stub, "Control+Shift+KeyV");
    expect(payloadText(frame)).toBe("one\rtwo\rthree\rfour");
  });
});

test("a chord that is not a clipboard chord keeps its bytes", async () => {
  // The over-application guard. A branch that swallowed every chord with a
  // modifier, or every chord on the C key or the V key, would take these
  // bytes away. Each row below is a measured fallback of this client.
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await seedClipboard(page, "MUST NOT PASTE");
    await page.focus("#terminal");

    const cases: Array<{ key: string; expected: number[]; note: string }> = [
      { key: "Control+c", expected: [0x00, 0x03], note: "the interrupt" },
      { key: "Control+v", expected: [0x00, 0x16], note: "SYN" },
      { key: "Meta+Shift+KeyC", expected: [0x00, 0x43], note: "Cmd+Shift+C, the letter C" },
      { key: "Meta+Shift+KeyV", expected: [0x00, 0x56], note: "Cmd+Shift+V, the letter V" },
      { key: "Meta+KeyX", expected: [0x00, 0x78], note: "Cmd+X, the letter x" },
      {
        key: "Control+Shift+KeyX",
        expected: [0x00, 0x1b, 0x5b, 0x31, 0x32, 0x30, 0x3b, 0x35, 0x75],
        note: "Ctrl+Shift+X, the Kitty sequence CSI 120;5u",
      },
      {
        key: "Control+Shift+KeyA",
        expected: [0x00, 0x1b, 0x5b, 0x39, 0x37, 0x3b, 0x35, 0x75],
        note: "Ctrl+Shift+A, the Kitty sequence CSI 97;5u",
      },
      { key: "Control+Alt+KeyV", expected: [0x00, 0x1b, 0x16], note: "Ctrl+Alt+V, ESC then SYN" },
      { key: "Control+Alt+KeyC", expected: [0x00, 0x1b, 0x03], note: "Ctrl+Alt+C, ESC then ETX" },
      {
        key: "Meta+Control+KeyV",
        expected: [0x00, 0x1b, 0x5b, 0x31, 0x31, 0x38, 0x3b, 0x35, 0x75],
        note: "Cmd+Ctrl+V, the Kitty sequence CSI 118;5u",
      },
      { key: "Meta+Alt+KeyV", expected: [0x00, 0x76], note: "Cmd+Alt+V, the letter v" },
    ];

    const lines: string[] = [];
    for (const item of cases) {
      const frame = await pressOnce(page, stub, item.key);
      lines.push(`${show(item.key, frame)}  (${item.note})`);
      expect(Array.from(frame)).toEqual(item.expected);
    }
    // eslint-disable-next-line no-console
    console.log(`\n${lines.join("\n")}`);
  });
});

// ── the clipboard chords that cannot complete ─────────────────────────────
//
// The tests above all grant `clipboard-read` and `clipboard-write` first. That
// grant is the state of a browser AFTER the operator answered the permission
// prompt of the origin. It is not the state of a browser before that answer,
// and it is not the state of a browser whose operator refused.
//
// A clipboard chord returns true, so the facade calls `preventDefault` and
// encodes nothing. A chord that also fails its clipboard call therefore does
// nothing at all. The two tests below hold the operator's only sign of that.

/** The text of the fault line of the menu, `#menu-note`. */
function menuNote(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById("menu-note")?.textContent ?? "");
}

test("a refused clipboard read tells the operator and sends no byte", async () => {
  // Measured in this Chromium with `clipboard-read` not granted:
  // `navigator.permissions.query` answers `denied`, and `readText` is rejected
  // with `NotAllowedError: ... Read permission denied.`. The client then
  // pastes nothing. Without the fault line the operator gets no sign at all.
  const stub = server();

  await withClient(async (page) => {
    // The write permission alone. The read prompt is unanswered.
    await page.context().grantPermissions(["clipboard-write"]);
    const state = await page.evaluate(async () => {
      const read = await navigator.permissions.query({
        name: "clipboard-read" as PermissionName,
      });
      return read.state;
    });
    expect(state).not.toBe("granted");
    await page.evaluate(() => navigator.clipboard.writeText("echo hi"));
    await page.focus("#terminal");
    expect(await menuNote(page)).toBe("");

    for (const key of PASTE_CHORDS) {
      await page.evaluate(() => {
        document.getElementById("menu-note")!.textContent = "";
      });
      await pressSilently(page, stub, key);
      await waitFor(
        () => menuNote(page),
        (text) => text.length > 0,
        `the fault line after ${key}`,
      );
      expect(await menuNote(page)).toBe(
        "The browser refused the clipboard read. Give this page the clipboard permission. Then paste again.",
      );
    }
  });
});

test("a refused clipboard write tells the operator and sends no byte", async () => {
  // No grant at all. `writeText` is rejected, so the copy chord copies
  // nothing.
  const stub = server();

  await withClient(async (page) => {
    await writeAndPaint(page, "hello world", "hello world");
    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 0 });
    await page.focus("#terminal");
    await page.evaluate(() => {
      document.getElementById("menu-note")!.textContent = "";
    });

    await pressSilently(page, stub, "Meta+KeyC");
    await waitFor(
      () => menuNote(page),
      (text) => text.length > 0,
      "the fault line after Meta+KeyC",
    );
    expect(await menuNote(page)).toBe(
      "The browser refused the clipboard write. Give this page the clipboard permission. Then copy again.",
    );
  });
});

test("a held paste chord pastes once", async () => {
  // The key repeat of `installKeyRepeat` dispatches a synthetic keydown after
  // `repeatDelayMs`, and again on the configured rate. A paste chord performs
  // an action and sends no key byte, so a repeat of it repeats the action.
  // Measured with the repeat armed: a hold of 1600 ms gave 11 pastes.
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await page.focus("#terminal");

    for (const chord of [
      { modifier: "Meta", key: "KeyV" },
      { modifier: "Control", key: "KeyV" },
    ]) {
      await seedClipboard(page, "rm -rf /\n");
      const before = framesWithTag(stub.received, 0x00).length;
      await page.keyboard.down(chord.modifier);
      if (chord.modifier === "Control") {
        await page.keyboard.down("Shift");
      }
      await page.keyboard.down(chord.key);
      // Longer than `repeatDelayMs` of 600 ms, so every repeat tick that the
      // client would generate lands inside this window.
      await idle(1600);
      await page.keyboard.up(chord.key);
      if (chord.modifier === "Control") {
        await page.keyboard.up("Shift");
      }
      await page.keyboard.up(chord.modifier);
      await idle(300);

      const frames = framesWithTag(stub.received, 0x00).slice(before);
      expect(frames.map((frame) => payloadText(frame))).toEqual(["rm -rf /\r"]);
    }
  });
});

test("a held copy chord copies once and still sends no byte", async () => {
  // The same repeat guard on the copy side. A copy chord sends no byte, so
  // this test measures the socket and the clipboard together.
  const stub = server();

  await withClient(async (page) => {
    await grantClipboard(page);
    await writeAndPaint(page, "hello world", "hello world");
    await dragCells(page, { col: 0, row: 0 }, { col: 4, row: 0 });
    await page.focus("#terminal");
    await seedClipboard(page, "<no copy>");

    const before = framesWithTag(stub.received, 0x00).length;
    await page.keyboard.down("Meta");
    await page.keyboard.down("KeyC");
    await idle(1600);
    await page.keyboard.up("KeyC");
    await page.keyboard.up("Meta");
    await idle(300);

    expect(framesWithTag(stub.received, 0x00).length).toBe(before);
    expect(await clipboardText(page)).toBe("hello");
  });
});
