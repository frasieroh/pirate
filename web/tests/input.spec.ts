/**
 * Input frames: tag `0x00` from the client.
 *
 * ghostty-web attaches its own InputHandler and encodes each key with the
 * KeyEncoder of libghostty. `src/main.ts` sends the bytes of the `onData`
 * event and holds no key table. These tests assert the exact bytes that the
 * stub server received.
 */

import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { hex, server, waitFor, withClient } from "./harness";
import type { Stub } from "./stub-server";

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
  stub.reset();

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

test("typed text gives one frame for each character", async () => {
  const stub = server();
  stub.reset();

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
