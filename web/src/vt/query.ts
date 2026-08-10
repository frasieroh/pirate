/**
 * The scanner that answers the queries which the wasm engine leaves open.
 *
 * A full-screen program asks the terminal what it can do, then it waits for
 * the answer. ghostty-vt.wasm 0.4.0 answers DSR and CPR alone. Measurement
 * with the raw exports, one query per write, `hasResponse` read after each
 * write:
 *
 *     ESC [ c          DA1              false
 *     ESC [ 0 c        DA1              false
 *     ESC [ > c        DA2              false
 *     ESC [ ? u        kitty keyboard   false
 *     ESC ] 11 ; ? BEL OSC 11           false, and the module logs
 *                                       "OSC 11 requires an allocator"
 *     ESC [ ? 2004 $ p DECRQM           false, and the module logs
 *                                       "ignoring unimplemented CSI p"
 *     ESC [ 6 n        DSR              true, `ESC [ 1 ; 1 R`
 *
 * A program that gets no answer waits for its own timeout. The measured cost
 * of the DA1 timeout of one editor is 1004 to 1055 ms, on the exit from the
 * alternate screen.
 *
 * This scanner reads the same byte stream that goes to the parser. It names
 * each query that it holds and gives the byte offset of the end of that
 * query. The caller writes the stream to the parser in the segments that
 * these offsets mark, then it builds each answer with `answerOf`. Two results
 * come from that order:
 *
 * - An answer of this scanner and an answer of the module leave in the order
 *   that a real terminal produces them.
 * - An answer reports the state of the terminal after the bytes before the
 *   query. A stream of `ESC [ ? 2004 h ESC [ ? 2004 $ p` therefore reports
 *   the mode as set.
 *
 * The scanner is not a second VT parser. It tracks the sequence boundaries
 * that it needs to hold the shapes apart, and it recognizes five shapes. It
 * keeps no grid, no mode, and no cursor.
 *
 * # What the scanner answers, and what it leaves
 *
 * DA1, `ESC [ c` and `ESC [ 0 c`, gets `ESC [ ? 62 ; 22 c`. 62 is the VT220
 * class and 22 is ANSI color.
 *
 * DECRQM, `ESC [ ? Ps $ p`, gets `ESC [ ? Ps ; Pm $ y`. Pm is 1, "set", when
 * `isModeSet` answers true. Pm is 0, "mode not recognized", for every other
 * mode. `ghostty_terminal_get_mode` gives one boolean, so a mode that is
 * reset and a mode that the module does not hold give the same value, and 0
 * is the truthful report of that ignorance.
 *
 * OSC 11, `ESC ] 11 ; ?`, gets the background of the theme, in the
 * `rgb:rrrr/gggg/bbbb` form of xterm, with the terminator of the query. The
 * value comes from the caller, not from the module: the module reports
 * 0,0,0 for the background of a new terminal, and `src/render/palette.ts`
 * paints the background of the theme instead.
 *
 * DA2, `ESC [ > c`, is left open. A DA2 answer names a terminal type and a
 * firmware version, and a program maps that pair to a feature set. pirate
 * matches no such pair.
 *
 * The kitty keyboard query, `ESC [ ? u`, is left open. `src/input.ts` states
 * that the client negotiates no kitty keyboard protocol, and the key encoder
 * of the module carries one option, `OPT_CURSOR_KEY_APPLICATION`. An answer
 * of `ESC [ ? 0 u` reports a flag stack, and the program then pushes flags
 * that this client cannot honor. A terminal without the protocol answers
 * nothing, and the DA1 answer above ends the wait of the program.
 *
 * # Limits
 *
 * The scanner holds its state across calls, so a query that a server frame
 * splits at any byte is still recognized. The answer then comes with the
 * write that carries the last byte of the query.
 *
 * The scanner ends a sequence where the engine ends it. ghostty-vt.wasm 0.4.0
 * ends a DCS, an OSC, an APC, a PM, and an SOS body on ESC, on BEL, on CAN
 * (0x18), and on SUB (0x1a), and it then reads the bytes after that byte as a
 * new sequence. `tests/query-parity.spec.ts` holds the measurement. A stream of
 * `ESC ] 0 ; t ESC [ c` therefore gives a DA1 answer, because the parser that
 * paints the screen dispatches a DA1 for it.
 *
 * The scanner answers a query in plain output, as a real terminal does: a
 * program that writes those bytes to the screen writes a query.
 */

/** BEL, one terminator of a string sequence. */
const BEL = 0x07;
/** ESC, the start of a sequence and the first byte of the `ESC \` terminator. */
const ESC = 0x1b;
/** The `\` that ends the `ESC \` terminator. */
const BACKSLASH = 0x5c;

/** CAN, the byte that stops the sequence in progress. */
const CAN = 0x18;
/** SUB, the second byte that stops the sequence in progress. */
const SUB = 0x1a;

/** The `[` of a CSI sequence. */
const CSI = 0x5b;
/** The `]` of an OSC sequence. */
const OSC = 0x5d;
/** The `P` of a DCS sequence. */
const DCS = 0x50;
/** The `X` of an SOS sequence. */
const SOS = 0x58;
/** The `^` of a PM sequence. */
const PM = 0x5e;
/** The `_` of an APC sequence. */
const APC = 0x5f;

/** The first byte of the parameter range and the intermediate range of a CSI. */
const CSI_BODY_MIN = 0x20;
/** The last byte of the parameter range of a CSI. */
const CSI_BODY_MAX = 0x3f;
/** The first byte of the final-byte range of a CSI. */
const CSI_FINAL_MIN = 0x40;
/** The last byte of the final-byte range of a CSI. */
const CSI_FINAL_MAX = 0x7e;

/**
 * The byte limit of the parameters of one CSI sequence.
 *
 * A longer sequence gets no answer. The longest shape here,
 * `ESC [ ? 65535 $ p`, holds 7 parameter bytes.
 */
const CSI_MAX = 32;

/**
 * The byte limit of the body of one OSC sequence that the scanner keeps.
 *
 * A longer body gets no answer. The shape here, `11;?`, holds 4 bytes. The
 * limit stops a stream that starts with `ESC ]` and never terminates from
 * growing without bound. `src/vt/osc8.ts` uses the same limit.
 */
const OSC_MAX = 4096;

/** The answer for DA1: a VT220 with ANSI color. */
export const DA1_ANSWER = "\x1b[?62;22c";

/** Where the scanner is in the byte stream. */
enum State {
  /** Outside a sequence. */
  GROUND = 0,
  /** An ESC came, and the next byte selects the sequence. */
  AFTER_ESC = 1,
  /** Inside the parameters and the intermediates of a CSI sequence. */
  CSI_BODY = 2,
  /** Inside the body of an OSC sequence. */
  OSC_BODY = 3,
  /** An ESC came inside an OSC body. A `\` ends the sequence. */
  OSC_AFTER_ESC = 4,
  /** Inside the body of a DCS, an APC, a PM, or an SOS sequence. */
  STRING_BODY = 5,
  /** An ESC came inside such a body. A `\` ends the sequence. */
  STRING_AFTER_ESC = 6,
}

/** The live state that an answer needs. The caller owns both values. */
export interface QueryContext {
  /**
   * True when the DEC private mode `mode` is set.
   *
   * A mode that the terminal does not hold gives false, and DECRQM then
   * reports "mode not recognized".
   */
  isModeSet(mode: number): boolean;

  /**
   * The background of the screen that the renderer paints, as `#rrggbb`.
   *
   * A value of another shape gets no OSC 11 answer.
   */
  background(): string;
}

/** One query that the scanner recognizes. */
export type Query =
  | { readonly kind: "da1" }
  | { readonly kind: "decrqm"; readonly mode: number }
  | { readonly kind: "osc11"; readonly terminator: string };

/** One query in the byte stream, with its end. */
export interface QueryEvent {
  /**
   * The offset in the fed array, one byte after the last byte of the query.
   *
   * The caller writes the bytes before this offset to the parser, then it
   * builds the answer with `answerOf`. The state of the terminal at that
   * point is the state that the query asks about.
   */
  readonly end: number;
  /** The query itself. */
  readonly query: Query;
}

/**
 * The answer for one query, or null for a query that this client leaves open.
 *
 * The caller runs this function after it wrote the bytes of the query to the
 * parser, so `context` reports the state that the query asks about.
 */
export function answerOf(query: Query, context: QueryContext): string | null {
  switch (query.kind) {
    case "da1":
      return DA1_ANSWER;
    case "decrqm": {
      const value = context.isModeSet(query.mode) ? 1 : 0;
      return `\x1b[?${query.mode};${value}$y`;
    }
    case "osc11": {
      const color = rgbOfHex(context.background());
      return color === null ? null : `\x1b]11;${color}${query.terminator}`;
    }
  }
}

export class QueryScanner {
  private state: State = State.GROUND;
  /** The parameter bytes and the intermediate bytes of the CSI in progress. */
  private csi: number[] = [];
  /** The body bytes of the OSC in progress. */
  private osc: number[] = [];
  /** True when the sequence in progress is longer than its limit. */
  private overflow = false;

  /**
   * Give the bytes of one write to the scanner, and take the queries.
   *
   * The queries come in the order of the stream. An array with no member is
   * the usual result.
   */
  feed(bytes: Uint8Array): QueryEvent[] {
    const events: QueryEvent[] = [];
    for (let at = 0; at < bytes.length; at += 1) {
      const query = this.step(bytes[at]);
      if (query !== null) {
        events.push({ end: at + 1, query });
      }
    }
    return events;
  }

  /**
   * Take one byte. This gives the query when the byte ends one that the
   * scanner recognizes, and null for every other byte.
   */
  private step(byte: number): Query | null {
    if (byte === CAN || byte === SUB) {
      // The engine drops the sequence in progress on either byte. A sequence
      // that this scanner holds open would give an answer that the engine
      // never dispatched.
      this.state = State.GROUND;
      this.csi = [];
      this.osc = [];
      this.overflow = false;
      return null;
    }
    switch (this.state) {
      case State.GROUND:
        if (byte === ESC) {
          this.state = State.AFTER_ESC;
        }
        return null;

      case State.AFTER_ESC:
        return this.afterEsc(byte);

      case State.CSI_BODY:
        if (byte === ESC) {
          // The ESC ends this sequence and starts the next one.
          this.state = State.AFTER_ESC;
          return null;
        }
        if (byte >= CSI_FINAL_MIN && byte <= CSI_FINAL_MAX) {
          this.state = State.GROUND;
          return this.overflow ? null : this.dispatchCsi(byte);
        }
        if (byte >= CSI_BODY_MIN && byte <= CSI_BODY_MAX) {
          if (this.csi.length < CSI_MAX) {
            this.csi.push(byte);
          } else {
            this.overflow = true;
          }
        }
        // A C0 byte runs on its own and leaves the CSI in progress.
        return null;

      case State.OSC_BODY:
        if (byte === BEL) {
          this.state = State.GROUND;
          return this.overflow ? null : this.dispatchOsc("\x07");
        }
        if (byte === ESC) {
          this.state = State.OSC_AFTER_ESC;
          return null;
        }
        if (this.osc.length < OSC_MAX) {
          this.osc.push(byte);
        } else {
          this.overflow = true;
        }
        return null;

      case State.OSC_AFTER_ESC:
        if (byte === BACKSLASH) {
          this.state = State.GROUND;
          return this.overflow ? null : this.dispatchOsc("\x1b\\");
        }
        // Any other byte after the ESC ends the OSC without a terminator. The
        // ESC starts the next sequence, and a query in that sequence gets its
        // answer.
        this.osc = [];
        return this.afterEsc(byte);

      case State.STRING_BODY:
        if (byte === BEL) {
          this.state = State.GROUND;
          return null;
        }
        if (byte === ESC) {
          this.state = State.STRING_AFTER_ESC;
        }
        return null;

      case State.STRING_AFTER_ESC:
        if (byte === BACKSLASH) {
          this.state = State.GROUND;
          return null;
        }
        // The ESC ended the body. It also starts the next sequence.
        return this.afterEsc(byte);
    }
  }

  /** The byte after an ESC selects the sequence. */
  private afterEsc(byte: number): null {
    this.overflow = false;
    switch (byte) {
      case CSI:
        this.csi = [];
        this.state = State.CSI_BODY;
        return null;
      case OSC:
        this.osc = [];
        this.state = State.OSC_BODY;
        return null;
      case DCS:
      case APC:
      case PM:
      case SOS:
        // The scanner keeps no byte of such a body. It holds the state to
        // mark the sequence boundary.
        this.state = State.STRING_BODY;
        return null;
      default:
        return this.afterEscOrGround(byte);
    }
  }

  /** An ESC starts the next sequence. Any other byte is text. */
  private afterEscOrGround(byte: number): null {
    this.state = byte === ESC ? State.AFTER_ESC : State.GROUND;
    return null;
  }

  /** A CSI sequence is complete. Name the query in it, or give null. */
  private dispatchCsi(final: number): Query | null {
    const body = String.fromCharCode(...this.csi);
    this.csi = [];

    // DA1. The private forms `ESC [ > c` and `ESC [ = c` are DA2 and DA3, and
    // they carry the `>` or the `=` in `body`.
    if (final === 0x63 && (body === "" || body === "0")) {
      return { kind: "da1" };
    }

    // DECRQM, the DEC private form alone. The ANSI form, `ESC [ Ps $ p`,
    // reports the ANSI modes, and this scanner reads no ANSI mode.
    if (final === 0x70) {
      const match = /^\?(\d{1,5})\$$/.exec(body);
      if (match !== null) {
        return { kind: "decrqm", mode: Number(match[1]) };
      }
    }

    return null;
  }

  /** An OSC sequence is complete. Name the query in it, or give null. */
  private dispatchOsc(terminator: string): Query | null {
    const body = String.fromCharCode(...this.osc);
    this.osc = [];
    return body === "11;?" ? { kind: "osc11", terminator } : null;
  }
}

/**
 * `#rrggbb` as the `rgb:rrrr/gggg/bbbb` form of xterm.
 *
 * The form of xterm carries 16 bits per channel. An 8-bit value doubles into
 * that width: `0x16` gives `1616`. A string of another shape gives null.
 */
function rgbOfHex(hex: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  const channel = (at: number): string => {
    const byte = hex.slice(at, at + 2).toLowerCase();
    return `${byte}${byte}`;
  };
  return `rgb:${channel(1)}/${channel(3)}/${channel(5)}`;
}
