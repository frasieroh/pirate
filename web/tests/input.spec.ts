/**
 * Input frames: tag `0x00` from the client.
 *
 * ghostty-web attaches its own InputHandler and encodes each key with the
 * KeyEncoder of libghostty. `src/main.ts` sends the bytes of the `onData`
 * event and holds no key table. These tests assert the exact bytes that the
 * stub server received.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import { framesWithTag, hex, idle, server, waitFor, withClient } from "./harness";
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
  // These seven chords are the measured defects of ghostty-web. Each one
  // goes through `attachCustomKeyEventHandler` in `src/input.ts`, and each
  // must give exactly one frame, with the bytes of a real terminal.
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
