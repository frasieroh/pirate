/**
 * A stub of the pirate server, for the browser tests.
 *
 * The Rust server does not exist yet. This module speaks the same wire
 * protocol, serves the built client from `web/dist`, and gives the tests
 * direct control of the socket. The tests run in this process, so the stub
 * needs no control API over HTTP.
 *
 * The real server has none of the control methods of this file.
 */

import type { ServerWebSocket, Server } from "bun";

/** One frame that a test asks the stub to send. */
export interface FrameSpec {
  /** The tag byte: 0 for output, 1 for dump, 2 for exit. */
  tag: number;
  /** A text payload. The stub encodes it as UTF-8. */
  text?: string;
  /**
   * A raw payload. It wins over `text`.
   *
   * The latency fixtures are recorded PTY bytes, and a PTY carries bytes that
   * are not valid UTF-8. This field carries them without a conversion.
   */
  bytes?: Uint8Array;
  /** An `i32` status, for tag 2. */
  status?: number;
}

/** The stub, as a test drives it. */
export interface Stub {
  /** The origin of the stub, for `page.goto`. */
  readonly url: string;
  /** The count of sockets that the stub accepted. */
  readonly connections: number;
  /** True while a socket is open. */
  readonly open: boolean;
  /** Every frame that a client sent, in order. */
  readonly received: Uint8Array[];
  /** Forget every frame and every counter. */
  reset(): void;
  /** Set the frames that the stub sends when a socket opens. */
  setOnOpen(frames: FrameSpec[]): void;
  /**
   * Set the frames that the stub sends for a `0x02` dump request.
   *
   * A test that calls this never falls back. An empty array is therefore an
   * answer of no frames.
   */
  setOnDump(frames: FrameSpec[]): void;
  /** Send frames on the open socket, now. */
  send(frames: FrameSpec[]): void;
  /** Close the open socket, as a dropped connection does. */
  closeSocket(): void;
  /** Stop the stub. */
  stop(): void;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  json: "application/json",
};

/**
 * The tag of a dump request, from the client.
 *
 * This file holds its own copy of the tag, as it holds its own copy of every
 * other tag. The stub is the other side of the wire, so it must not verify
 * `src/protocol.ts` against itself.
 */
const CLIENT_DUMP = 0x02;

/** Build one binary frame from a specification. */
export function buildFrame(spec: FrameSpec): Uint8Array {
  if (spec.tag === 0x02) {
    const frame = new Uint8Array(5);
    const view = new DataView(frame.buffer);
    view.setUint8(0, 0x02);
    view.setInt32(1, spec.status ?? 0, false);
    return frame;
  }
  const body = spec.bytes ?? new TextEncoder().encode(spec.text ?? "");
  const frame = new Uint8Array(1 + body.length);
  frame[0] = spec.tag;
  frame.set(body, 1);
  return frame;
}

/**
 * Start the stub on a free port.
 *
 * The root holds the output of `vite build`. The client must be built before
 * the tests run.
 */
export function startStub(root: string): Stub {
  let received: Uint8Array[] = [];
  let onOpen: FrameSpec[] = [];
  /** The answer to a dump request, or null when a test set none. */
  let onDump: FrameSpec[] | null = null;
  let connections = 0;
  let current: ServerWebSocket<undefined> | null = null;

  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, self) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (self.upgrade(request)) {
          return undefined as unknown as Response;
        }
        return new Response("expected a websocket", { status: 426 });
      }
      const name = url.pathname === "/" ? "/index.html" : url.pathname;
      if (name.includes("..")) {
        return new Response("bad path", { status: 400 });
      }
      const file = Bun.file(`${root}${name}`);
      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      const extension = name.split(".").pop() ?? "";
      return new Response(await file.arrayBuffer(), {
        headers: { "content-type": MIME[extension] ?? "application/octet-stream" },
      });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>): void {
        connections += 1;
        current = ws;
        for (const spec of onOpen) {
          ws.send(buildFrame(spec));
        }
      },
      message(ws: ServerWebSocket<undefined>, message: string | Buffer): void {
        const frame =
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);
        // Every frame goes to `received`, the dump request included. The tests
        // count frames by tag.
        received.push(frame);
        if (frame.length > 0 && frame[0] === CLIENT_DUMP) {
          // The fallback: the real server answers a dump request with the same
          // `0x01` dump that it sends when a socket opens. A test that set only
          // `setOnOpen` therefore gets that screen back, and a test of the
          // theme rebuild needs no second setup call.
          for (const spec of onDump ?? onOpen) {
            ws.send(buildFrame(spec));
          }
        }
      },
      close(ws: ServerWebSocket<undefined>): void {
        if (current === ws) {
          current = null;
        }
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    get connections(): number {
      return connections;
    },
    get open(): boolean {
      return current !== null;
    },
    get received(): Uint8Array[] {
      return received;
    },
    reset(): void {
      received = [];
      onOpen = [];
      onDump = null;
      connections = 0;
    },
    setOnOpen(frames: FrameSpec[]): void {
      onOpen = frames;
    },
    setOnDump(frames: FrameSpec[]): void {
      onDump = frames;
    },
    send(frames: FrameSpec[]): void {
      if (current === null) {
        throw new Error("the stub has no open socket");
      }
      for (const spec of frames) {
        current.send(buildFrame(spec));
      }
    },
    closeSocket(): void {
      current?.close(1001, "test");
    },
    stop(): void {
      // Do not wait for the promise of `stop`. In bun 1.3.14 it does not
      // settle when a socket of the server was already closed, and the test
      // run then hangs in the teardown hook.
      void server.stop(true);
    },
  };
}
