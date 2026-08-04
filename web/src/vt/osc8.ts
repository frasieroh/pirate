/**
 * The OSC 8 hyperlink scanner.
 *
 * The wasm module marks a cell that holds a hyperlink, but it exports no
 * accessor for the URI of that hyperlink. This scanner reads the URIs out of
 * the same byte stream that goes to the parser.
 *
 * The scanner is not a second VT parser. It looks for one shape only:
 *
 *     ESC ] 8 ; params ; URI  ST
 *
 * ST is BEL (0x07) or `ESC \`. The `params` field is empty in most streams,
 * and a stream can also carry `id=name`. A sequence with an empty URI closes
 * the hyperlink and carries no URI.
 *
 * The scanner holds its state across calls, because one write can end in the
 * middle of a sequence.
 *
 * The scanner keeps one URI, not a table. The wasm module gives the same
 * hyperlink id to every cell with a hyperlink, so a table keyed by that id
 * cannot select a URI. A stream with one URI is therefore the only stream in
 * which a cell and a URI can be matched, and `uri()` gives null for any other
 * stream.
 */

/** BEL, one of the two string terminators of an OSC sequence. */
const BEL = 0x07;
/** ESC, the start of a sequence and the first byte of the `ESC \` terminator. */
const ESC = 0x1b;
/** The `]` that starts an OSC sequence. */
const OSC = 0x5d;
/** The `\` that ends the `ESC \` terminator. */
const BACKSLASH = 0x5c;

/**
 * The byte limit of one OSC body that the scanner keeps.
 *
 * A URI longer than this limit is dropped, and the scanner marks the stream
 * as ambiguous. The limit stops a stream of text that starts with `ESC ]` and
 * never terminates from growing without bound.
 */
const BODY_MAX = 4096;

/** Where the scanner is in the byte stream. */
enum State {
  /** Outside a sequence. */
  TEXT = 0,
  /** An ESC came, and the next byte selects the sequence. */
  AFTER_ESC = 1,
  /** Inside the body of an OSC sequence. */
  BODY = 2,
  /** An ESC came inside the body. A `\` ends the sequence. */
  BODY_AFTER_ESC = 3,
}

export class Osc8Scanner {
  private state: State = State.TEXT;
  private body: number[] = [];
  /** The one URI that the stream carried, or null for none. */
  private found: string | null = null;
  /** True when the stream carried more than one URI, or a dropped URI. */
  private ambiguous = false;

  /** Give the bytes of one write to the scanner. */
  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.step(byte);
    }
  }

  /**
   * The URI of the hyperlinks in this stream.
   *
   * This gives null when the stream carried no URI, and null when the stream
   * carried more than one URI.
   */
  uri(): string | null {
    return this.ambiguous ? null : this.found;
  }

  private step(byte: number): void {
    switch (this.state) {
      case State.TEXT:
        if (byte === ESC) {
          this.state = State.AFTER_ESC;
        }
        return;

      case State.AFTER_ESC:
        if (byte === OSC) {
          this.state = State.BODY;
          this.body = [];
          return;
        }
        // An ESC directly after an ESC starts the sequence again.
        this.state = byte === ESC ? State.AFTER_ESC : State.TEXT;
        return;

      case State.BODY:
        if (byte === BEL) {
          this.end();
          return;
        }
        if (byte === ESC) {
          this.state = State.BODY_AFTER_ESC;
          return;
        }
        if (this.body.length < BODY_MAX) {
          this.body.push(byte);
        } else {
          // The body is too long to keep. The stream can hold a URI that this
          // scanner did not read, so no URI in it can be trusted.
          this.ambiguous = true;
        }
        return;

      case State.BODY_AFTER_ESC:
        if (byte === BACKSLASH) {
          this.end();
          return;
        }
        // Any other byte after the ESC ends the OSC sequence without a
        // terminator. The parser of the module makes the same decision.
        this.body = [];
        this.state = byte === ESC ? State.AFTER_ESC : State.TEXT;
        return;
    }
  }

  /** The body is complete. Read a URI out of it, then go back to the text. */
  private end(): void {
    const body = new TextDecoder().decode(new Uint8Array(this.body));
    this.body = [];
    this.state = State.TEXT;

    // `8;params;uri`. The URI holds a `;` in no valid form, but a split with
    // a limit keeps a `;` inside the URI whole anyway.
    if (!body.startsWith("8;")) {
      return;
    }
    const semicolon = body.indexOf(";", 2);
    if (semicolon < 0) {
      return;
    }
    const uri = body.slice(semicolon + 1);
    if (uri.length === 0) {
      return;
    }
    if (this.found !== null && this.found !== uri) {
      this.ambiguous = true;
      return;
    }
    this.found = uri;
  }
}
