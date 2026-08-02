/**
 * The key repeat: tag `0x00` frames from a held key.
 *
 * `src/input.ts` suppresses the native repeat of the browser and generates
 * its own, on the fixed delay of `state.repeatDelayMs` and the configured
 * rate of `state.repeatRate`. Playwright sends one keydown for
 * `page.keyboard.down`, with `repeat` false, and it never simulates the
 * native repeat of an operating system. A frame that arrives after the down
 * event, while the key stays down, is therefore a frame that pirate itself
 * generated.
 */

import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { clientState, framesWithTag, idle, menuState, server, waitFor, withClient } from "./harness";
import type { Stub } from "./stub-server";

/** The count of `0x00` frames the stub holds now. */
function inputFrameCount(stub: Stub): number {
  return framesWithTag(stub.received, 0x00).length;
}

/** Click a menu button and wait for `#repeat-value` to show `expected`. */
async function setRateByClicks(page: Page, buttonId: string, clicks: number): Promise<void> {
  for (let i = 0; i < clicks; i += 1) {
    await page.click(buttonId);
  }
}

test("a synthetic keydown with repeat true gives no frame", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const before = inputFrameCount(stub);

    // A real held key gives `repeat: true` on the keydown of the operating
    // system. The event goes on the textarea of ghostty-web, inside
    // `#terminal`, and it bubbles from there, the same path as a real key.
    await page.evaluate(() => {
      const field = document.querySelector("#terminal textarea") as HTMLElement;
      field.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyA", key: "a", repeat: true, bubbles: true }),
      );
    });

    // A settle wait, so that a frame with a slow path has time to arrive.
    await idle(300);
    expect(inputFrameCount(stub)).toBe(before);
  });
});

test("the first repeat arrives after the delay, and not before", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const state = await clientState(page);
    expect(state.repeatDelayMs).toBe(600);

    const before = inputFrameCount(stub);
    await page.keyboard.down("a");
    await waitFor(
      async () => inputFrameCount(stub),
      (count) => count >= before + 1,
      "the frame of the first press",
    );

    // Short of the delay. Only the first press has given a frame.
    await idle(state.repeatDelayMs - 250);
    expect(inputFrameCount(stub)).toBe(before + 1);

    // Past the delay. The first repeat has now arrived.
    await waitFor(
      async () => inputFrameCount(stub),
      (count) => count >= before + 2,
      "the first repeat",
      2000,
    );

    await page.keyboard.up("a");
  });
});

test("a held key repeats at about the configured rate", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const state = await clientState(page);
    expect(state.repeatRate).toBe(10);

    const before = inputFrameCount(stub);
    const holdMs = 2000;
    await page.keyboard.down("a");
    await idle(holdMs);
    await page.keyboard.up("a");
    // A settle wait, so that a tick in flight when the key came up still
    // lands before the count below is read.
    await idle(150);

    const frames = inputFrameCount(stub) - before;
    // At 10 keys per second, a hold of 2000 ms past a delay of 600 ms gives
    // about 1 + (2000 - 600) / 100 = 15 frames. Playwright gives no native
    // repeat of its own, so a count near 1 would mean this module generated
    // none, and a count in the hundreds would mean a runaway loop. The band
    // below is wide, to hold under the timing jitter of a browser test, and
    // narrow enough to fail on either fault.
    // eslint-disable-next-line no-console
    console.log(`  held 'a' for ${holdMs} ms at 10/s: ${frames} frames`);
    expect(frames).toBeGreaterThan(8);
    expect(frames).toBeLessThan(25);
  });
});

test("a keyup stops the repeat", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const before = inputFrameCount(stub);

    await page.keyboard.down("a");
    // Past the delay, so that at least one repeat has started.
    await waitFor(
      async () => inputFrameCount(stub),
      (count) => count >= before + 2,
      "the first repeat",
      2000,
    );
    await page.keyboard.up("a");
    const atRelease = inputFrameCount(stub);

    // A window well past one more tick of the default rate. No further
    // frame must arrive: the keyup stopped the repeat.
    await idle(400);
    expect(inputFrameCount(stub)).toBe(atRelease);
  });
});

test("a rate change in the menu changes the measured rate", async () => {
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    expect(((await page.textContent("#repeat-value")) ?? "").trim()).toBe("10");

    const holdMs = 1500;

    // The default rate, 10 keys per second.
    let before = inputFrameCount(stub);
    await page.keyboard.down("a");
    await idle(holdMs);
    await page.keyboard.up("a");
    await idle(150);
    const defaultFrames = inputFrameCount(stub) - before;

    // The slowest rate, 2 keys per second. `#repeat-decrease` steps by 1, so
    // 8 clicks take the rate from 10 to 2.
    await setRateByClicks(page, "#repeat-decrease", 8);
    expect(((await page.textContent("#repeat-value")) ?? "").trim()).toBe("2");
    expect((await clientState(page)).repeatRate).toBe(2);

    await page.focus("#terminal");
    before = inputFrameCount(stub);
    await page.keyboard.down("b");
    await idle(holdMs);
    await page.keyboard.up("b");
    await idle(150);
    const slowFrames = inputFrameCount(stub) - before;

    // eslint-disable-next-line no-console
    console.log(`  ${holdMs} ms hold: 10/s gave ${defaultFrames}, 2/s gave ${slowFrames}`);
    expect(slowFrames).toBeLessThan(defaultFrames);
  });
});

test("a menu hotkey held down fires once, not many times", async () => {
  // `page.keyboard.down` gives one keydown with `repeat` false, and it never
  // simulates the native repeat of a held key: it cannot see the defect this
  // test proves. A real held key gives one keydown with `repeat` false, then
  // more keydowns with `repeat` true, at the rate of the operating system.
  // This test dispatches that same sequence directly, on `window`, where
  // `src/keys.ts` attaches its one listener.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    expect(await menuState(page)).toBe("open");

    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyH", altKey: true, repeat: false, bubbles: true }),
      );
    });
    await waitFor(() => menuState(page), (s) => s === "hidden", "the hidden menu");

    // Five more keydowns, each carrying `repeat: true`, the way the
    // operating system repeats a held key. The action must run once, on the
    // first press only: the menu must stay `hidden` after every one of
    // these, never toggling back to `open`.
    for (let i = 0; i < 5; i += 1) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { code: "KeyH", altKey: true, repeat: true, bubbles: true }),
        );
      });
      expect(await menuState(page)).toBe("hidden");
    }
  });
});

test("an IME composition keydown arms no repeat", async () => {
  // ghostty-web's own `handleKeyDown` bails on `event.isComposing` and on
  // `event.keyCode === 229`, before it encodes anything. This module's
  // repeat listener runs earlier, in the capture phase, so it must bail the
  // same way. Before the fix, one composing keydown armed the held-key
  // state, and the client sent three unrequested ESC bytes about 600, 700,
  // and 800 ms later, from ghostty-web's own encoding of the synthetic
  // repeat that this module dispatched.
  const stub = server();
  stub.reset();

  await withClient(async (page) => {
    await page.focus("#terminal");
    const before = inputFrameCount(stub);

    await page.evaluate(() => {
      const field = document.querySelector("#terminal textarea") as HTMLElement;
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyA",
          key: "a",
          isComposing: true,
          bubbles: true,
        }),
      );
    });

    // Past the repeat delay of 600 ms, and past the first tick that a
    // wrongly armed repeat would give.
    await idle(1200);
    expect(inputFrameCount(stub)).toBe(before);
  });
});
