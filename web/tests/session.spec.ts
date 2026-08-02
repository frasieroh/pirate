/**
 * The life of a session: a dropped connection, and a `0x02` exit frame.
 *
 * Each client owns one PTY. The server sends SIGHUP to the process when the
 * socket closes, so a reconnect gives a new shell and not the old session.
 * The client must show that difference and must not keep the dead screen.
 */

import { beforeEach, expect, test } from "bun:test";
import {
  clientState,
  ESC,
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
