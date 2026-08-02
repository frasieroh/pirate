/**
 * The wire protocol of pirate.
 *
 * Each WebSocket frame is binary. The first byte is the tag. The rest of the
 * frame is the payload. All integers are big-endian.
 *
 * | Direction       | Tag    | Payload                                 |
 * |-----------------|--------|-----------------------------------------|
 * | server → client | `0x00` | raw PTY output bytes                    |
 * | server → client | `0x01` | full state dump, as VT sequences        |
 * | server → client | `0x02` | process exited: `i32` status            |
 * | client → server | `0x00` | encoded input bytes                     |
 * | client → server | `0x01` | resize: `u16` cols, `u16` rows          |
 * | client → server | `0x02` | ask for a full-state dump: no payload   |
 *
 * This table is a contract with the server. Do not change it here alone.
 */

/** Server to client. The payload is raw PTY output. */
export const SERVER_OUTPUT = 0x00;
/** Server to client. The payload is the full screen, as VT sequences. */
export const SERVER_DUMP = 0x01;
/** Server to client. The payload is an `i32` exit status. */
export const SERVER_EXIT = 0x02;

/** Client to server. The payload is encoded input. */
export const CLIENT_INPUT = 0x00;
/** Client to server. The payload is a `u16` cols and a `u16` rows. */
export const CLIENT_RESIZE = 0x01;
/** Client to server. A request for a full-state dump. The frame carries no payload. */
export const CLIENT_DUMP = 0x02;

/** The byte count of the `i32` status in a server `0x02` frame. */
const EXIT_STATUS_BYTES = 4;

/** Build a `0x00` input frame from encoded input bytes. */
export function encodeInput(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = CLIENT_INPUT;
  frame.set(bytes, 1);
  return frame;
}

/**
 * Build a `0x01` resize frame.
 *
 * `DataView.setUint16` writes big-endian when the second argument is false.
 */
export function encodeResize(cols: number, rows: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5);
  const view = new DataView(frame.buffer);
  view.setUint8(0, CLIENT_RESIZE);
  view.setUint16(1, cols, false);
  view.setUint16(3, rows, false);
  return frame;
}

/**
 * Build a `0x02` dump request frame.
 *
 * The frame is the tag alone. The server answers with one `0x01` frame, the
 * same full-state dump that it sends when a socket opens. `src/main.ts` sends
 * this frame after it builds a new terminal, so the new terminal gets the
 * screen back.
 */
export function encodeDumpRequest(): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(1);
  frame[0] = CLIENT_DUMP;
  return frame;
}

/**
 * Read the `i32` status out of the payload of a server `0x02` frame.
 *
 * A short payload gives -1, because a truncated frame carries no status.
 */
export function decodeExitStatus(payload: Uint8Array): number {
  if (payload.length < EXIT_STATUS_BYTES) {
    return -1;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, EXIT_STATUS_BYTES);
  return view.getInt32(0, false);
}
