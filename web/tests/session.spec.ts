/**
 * The life of a session: a dropped connection, and a `0x02` exit frame.
 *
 * Each client owns one PTY. The server sends SIGHUP to the process when the
 * socket closes, so a reconnect gives a new shell and not the old session.
 * The client must show that difference and must not keep the dead screen.
 */

import { beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";
import {
  clientState,
  ESC,
  framesWithTag,
  idle,
  paintedPixels,
  server,
  statusText,
  viewportLine,
  viewportText,
  waitFor,
  withClient,
} from "./harness";

beforeEach(() => {
  server().reset();
});

test("a dropped connection gives a new shell, and the old screen goes away", async () => {
  const stub = server();
  stub.setOnOpen([{ tag: 0x00, text: "first shell ready\r\n$ " }]);

  await withClient(async (page) => {
    await waitFor(() => viewportLine(page, 0), (line) => line === "first shell ready", "shell 1");

    // The next socket gets a dump, as the real server sends on every open.
    stub.setOnOpen([
      { tag: 0x01, text: `${ESC}[H${ESC}[2J${ESC}[1;1Hsecond shell ready${ESC}[2;1H$ ` },
    ]);
    stub.closeSocket();

    await waitFor(
      async () => (await clientState(page)).connections,
      (count) => count === 2,
      "a second connection",
    );

    // The dump of the new shell must reach the screen, and no text of the
    // dead shell must stay on it.
    await waitFor(
      () => viewportLine(page, 0),
      (line) => line === "second shell ready",
      "the dump of shell 2",
    );
    const text = await viewportText(page);
    expect(text.some((line) => line.includes("first shell"))).toBe(false);
    expect(await paintedPixels(page, 0)).toBeGreaterThan(50);

    // The user must be able to tell that the old session ended.
    expect(await statusText(page)).toContain("new shell");
  });
});

test("the client sends the size of the terminal on every connection", async () => {
  const stub = server();

  await withClient(async (page) => {
    await waitFor(
      async () => stub.received.filter((f) => f[0] === 0x01).length,
      (count) => count === 1,
      "the resize frame of connection 1",
    );
    stub.closeSocket();
    await waitFor(
      async () => (await clientState(page)).connections,
      (count) => count === 2,
      "a second connection",
    );
    await waitFor(
      async () => stub.received.filter((f) => f[0] === 0x01).length,
      (count) => count === 2,
      "the resize frame of connection 2",
    );
  });
});

test("a 0x02 frame shows the exit status and stops the reconnect", async () => {
  const stub = server();

  await withClient(async (page) => {
    stub.send([{ tag: 0x02, status: 3 }]);
    await waitFor(
      async () => (await clientState(page)).exitStatus,
      (value) => value === 3,
      "the exit status",
    );
    expect(await statusText(page)).toContain("status 3");

    // The shell of this client ended. A reconnect would start another shell
    // that the user did not ask for.
    stub.closeSocket();
    await idle(1000);
    expect(stub.connections).toBe(1);
    expect((await clientState(page)).connections).toBe(1);
  });
});

test("a 0x02 frame carries a big-endian i32 status", async () => {
  const stub = server();

  await withClient(async (page) => {
    stub.send([{ tag: 0x02, status: 130 }]);
    await waitFor(
      async () => (await clientState(page)).exitStatus,
      (value) => value === 130,
      "the exit status",
    );
  });
});

// ── the focus ─────────────────────────────────────────────────────────────
//
// CAUTION: No test below calls `page.focus`. The client must take the focus
// for itself at load time. A test that focuses the terminal first cannot see
// the defect that these tests measure, and every other focus test of this
// suite focuses it first.

/** The active element of the page, and whether it sits inside `#terminal`. */
function activeElement(page: Page): Promise<{ tag: string; inTerminal: boolean }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const terminal = document.getElementById("terminal");
    return {
      tag: active === null ? "none" : active.tagName,
      inTerminal: active !== null && terminal !== null && terminal.contains(active),
    };
  });
}

test("the client takes the focus at load, with no click and no explicit focus", async () => {
  // The operator logs in and types. Nothing else happens in between. Before
  // the repair the active element was BODY, and every keystroke went nowhere.
  // `src/input.ts` returns the focus on the first `mousedown`, so one click
  // hides this defect. This test never clicks.
  const stub = server();

  await withClient(async (page) => {
    const active = await activeElement(page);
    // eslint-disable-next-line no-console
    console.log(`  active element at load: ${JSON.stringify(active)}`);
    expect(active.inTerminal).toBe(true);

    // The behavior that the operator sees: a keystroke reaches the shell.
    const before = framesWithTag(stub.received, 0x00).length;
    await page.keyboard.type("hello");
    await waitFor(
      async () => framesWithTag(stub.received, 0x00).length,
      (count) => count >= before + 5,
      "one input frame for each of the five keys",
    );
  });
});

test("the terminal does not take the focus off a menu button", async () => {
  // Criterion 20, the menu path. The operator moves to a menu control and
  // leaves it there. No rebuild runs, so no facade is built, and the focus
  // must stay where the operator put it.
  await withClient(async (page) => {
    await page.focus("#font-increase");
    await idle(500);
    const held = await activeElement(page);
    // eslint-disable-next-line no-console
    console.log(`  active element after 500 ms on a menu button: ${JSON.stringify(held)}`);
    expect(held.inTerminal).toBe(false);
    expect(held.tag).toBe("BUTTON");
  });
});

test("a reconnect does not move the focus", async () => {
  // Criterion 20, the reconnect path. `ws.onopen` builds no facade, so a
  // dropped socket must leave the focus of the operator alone.
  const stub = server();

  await withClient(async (page) => {
    await page.focus("#font-increase");
    const before = await activeElement(page);

    stub.closeSocket();
    await waitFor(
      async () => (await clientState(page)).connections,
      (count) => count >= 2,
      "the second connection",
    );
    await idle(400);

    const after = await activeElement(page);
    // eslint-disable-next-line no-console
    console.log(`  focus across a reconnect: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    expect(after).toEqual(before);
    expect(after.inTerminal).toBe(false);
  });
});
