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
      message(_ws: ServerWebSocket<undefined>, message: string | Buffer): void {
        received.push(
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message),
        );
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
      connections = 0;
    },
    setOnOpen(frames: FrameSpec[]): void {
      onOpen = frames;
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
