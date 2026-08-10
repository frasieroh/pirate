/**
 * The query scanner: `web/src/vt/query.ts`.
 *
 * The assertions read the answers that the scanner gives for a byte stream.
 * No browser, no canvas, and no wasm module take part. `tests/output.spec.ts`
 * drives the same answers through the whole client, from the stub server to
 * the socket.
 */

import { describe, expect, test } from "bun:test";
import { answerOf, DA1_ANSWER, QueryScanner, type QueryContext } from "../src/vt";

/** The escape byte, as text. */
const ESC = "\x1b";
/** The bell byte, one terminator of a string sequence. */
const BEL = "\x07";

/** The background of the dark default theme of `src/theme.ts`. */
const BACKGROUND = "#16161e";

/** The OSC 11 answer for that background, without the terminator. */
const BACKGROUND_ANSWER = `${ESC}]11;rgb:1616/1616/1e1e`;

/** A context with the modes of `set` and the background of the dark theme. */
function context(set: number[] = [], background = BACKGROUND): QueryContext {
  return {
    isModeSet: (mode: number): boolean => set.includes(mode),
    background: (): string => background,
  };
}

/** The answer texts for one write, in order. A query with no answer is left out. */
function answers(text: string, ctx: QueryContext = context()): string[] {
  const scanner = new QueryScanner();
  const out: string[] = [];
  for (const event of scanner.feed(new TextEncoder().encode(text))) {
    const answer = answerOf(event.query, ctx);
    if (answer !== null) {
      out.push(answer);
    }
  }
  return out;
}

describe("DA1", () => {
  test("the bare form gives the VT220 answer", () => {
    expect(answers(`${ESC}[c`)).toEqual([DA1_ANSWER]);
    expect(DA1_ANSWER).toBe(`${ESC}[?62;22c`);
  });

  test("the explicit zero gives the same answer", () => {
    expect(answers(`${ESC}[0c`)).toEqual([DA1_ANSWER]);
  });

  test("the answer ends at the byte after the query", () => {
    const scanner = new QueryScanner();
    const got = scanner.feed(new TextEncoder().encode(`ab${ESC}[ccd`));
    expect(got.length).toBe(1);
    expect(got[0].end).toBe(5);
    expect(got[0].query).toEqual({ kind: "da1" });
  });

  test("two queries in one write give two answers, in order", () => {
    const scanner = new QueryScanner();
    const got = scanner.feed(new TextEncoder().encode(`${ESC}[c${ESC}[c`));
    expect(got.map((event) => event.end)).toEqual([3, 6]);
    expect(answers(`${ESC}[c${ESC}[c`)).toEqual([DA1_ANSWER, DA1_ANSWER]);
  });

  test("a query split across two writes is recognized", () => {
    const scanner = new QueryScanner();
    const encoder = new TextEncoder();
    expect(scanner.feed(encoder.encode(`${ESC}[`))).toEqual([]);
    const got = scanner.feed(encoder.encode("c"));
    expect(got.length).toBe(1);
    expect(got[0].end).toBe(1);
    expect(answerOf(got[0].query, context())).toBe(DA1_ANSWER);
  });

  test("a query split at every byte is recognized", () => {
    const query = `${ESC}[0c`;
    const scanner = new QueryScanner();
    const encoder = new TextEncoder();
    const got: string[] = [];
    for (const byte of query) {
      for (const event of scanner.feed(encoder.encode(byte))) {
        got.push(answerOf(event.query, context()) ?? "");
      }
    }
    expect(got).toEqual([DA1_ANSWER]);
  });
});

describe("the queries that the scanner leaves open", () => {
  // `src/vt/query.ts` holds the evidence for each of these decisions.
  test("DA2 gets no answer", () => {
    expect(answers(`${ESC}[>c`)).toEqual([]);
    expect(answers(`${ESC}[>0c`)).toEqual([]);
  });

  test("DA3 gets no answer", () => {
    expect(answers(`${ESC}[=c`)).toEqual([]);
  });

  test("the kitty keyboard query gets no answer", () => {
    expect(answers(`${ESC}[?u`)).toEqual([]);
  });

  test("a DA1 after a kitty keyboard query still gets its answer", () => {
    // This pair is the shape that ends the wait of a program that asks for
    // the kitty keyboard protocol.
    expect(answers(`${ESC}[?u${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("an OSC 11 that sets a color gets no answer", () => {
    expect(answers(`${ESC}]11;#ff0000${BEL}`)).toEqual([]);
  });

  test("the ANSI form of DECRQM gets no answer", () => {
    expect(answers(`${ESC}[4$p`, context([4]))).toEqual([]);
  });

  test("a CSI of another shape gets no answer", () => {
    expect(answers(`${ESC}[6n${ESC}[2J${ESC}[?1049l${ESC}[5;10H`)).toEqual([]);
  });
});

describe("DECRQM", () => {
  // The answer reports 1 or 2 for a mode that this client honors, and 0,
  // "mode not recognized", for every other mode. `HONORED_MODES` in
  // `src/vt/query.ts` names the evidence in the client for each entry.

  test("the cursor key mode reports 1 when it is set", () => {
    // DEC mode 1, DECCKM. `src/vt/terminal.ts:539` reads it for each key.
    expect(answers(`${ESC}[?1$p`, context([1]))).toEqual([`${ESC}[?1;1$y`]);
  });

  test("the cursor key mode reports 2 when it is reset", () => {
    expect(answers(`${ESC}[?1$p`)).toEqual([`${ESC}[?1;2$y`]);
  });

  test("bracketed paste reports 1 when it is set", () => {
    // DEC mode 2004. `src/input.ts:231` wraps a paste when it is set.
    expect(answers(`${ESC}[?2004$p`, context([2004]))).toEqual([`${ESC}[?2004;1$y`]);
  });

  test("bracketed paste reports 2 when it is reset", () => {
    expect(answers(`${ESC}[?2004$p`)).toEqual([`${ESC}[?2004;2$y`]);
  });

  test("a mode that the client does not honor reports 0", () => {
    // The engine holds mode 2026, synchronized output, but no code under
    // `src/` reads it. An answer of 1 or 2 would name a capability that the
    // renderer does not have.
    expect(answers(`${ESC}[?2026$p`, context([2026]))).toEqual([`${ESC}[?2026;0$y`]);
  });

  test("a mode that no terminal holds reports 0", () => {
    expect(answers(`${ESC}[?12345$p`)).toEqual([`${ESC}[?12345;0$y`]);
  });

  test("the answer carries the mode of the query", () => {
    expect(answers(`${ESC}[?2004$p`, context([1, 2004]))).toEqual([
      `${ESC}[?2004;1$y`,
    ]);
  });

  test("a mode number longer than five digits gets no answer", () => {
    expect(answers(`${ESC}[?123456$p`)).toEqual([]);
  });
});

describe("OSC 11", () => {
  test("the BEL form gives the background of the theme", () => {
    expect(answers(`${ESC}]11;?${BEL}`)).toEqual([`${BACKGROUND_ANSWER}${BEL}`]);
  });

  test("the answer carries the terminator of the query", () => {
    expect(answers(`${ESC}]11;?${ESC}\\`)).toEqual([`${BACKGROUND_ANSWER}${ESC}\\`]);
  });

  test("a background of another shape gets no answer", () => {
    expect(answers(`${ESC}]11;?${BEL}`, context([], "red"))).toEqual([]);
  });

  test("a light background gives its own value", () => {
    expect(answers(`${ESC}]11;?${BEL}`, context([], "#ffffff"))).toEqual([
      `${ESC}]11;rgb:ffff/ffff/ffff${BEL}`,
    ]);
  });
});

describe("string bodies", () => {
  // The engine ends a string body on ESC, on BEL, on CAN, and on SUB, and it
  // reads the bytes after that byte as a new sequence.
  // `tests/query-parity.spec.ts` holds that measurement and drives the same
  // streams through the engine.
  test("the ESC of a query ends a DCS body, and the query gets its answer", () => {
    expect(answers(`${ESC}P1;2q${ESC}[c${ESC}\\`)).toEqual([DA1_ANSWER]);
  });

  test("the ESC of a query ends an APC body", () => {
    expect(answers(`${ESC}_G${ESC}[c${ESC}\\`)).toEqual([DA1_ANSWER]);
  });

  test("the ESC of a query ends an OSC body", () => {
    expect(answers(`${ESC}]0;title${ESC}[c${BEL}`)).toEqual([DA1_ANSWER]);
  });

  test("a CAN ends an OSC body", () => {
    expect(answers(`${ESC}]0;title\x18${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("the doubled ESC of a DCS passthrough ends the body", () => {
    // tmux writes `ESC ESC` for one ESC of the payload. The engine ends the
    // DCS at the first of the two.
    expect(answers(`${ESC}Ptmux;${ESC}${ESC}[c${ESC}\\`)).toEqual([DA1_ANSWER]);
  });

  test("a DCS body ends, and the next query gets its answer", () => {
    expect(answers(`${ESC}Pdata${ESC}\\${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("a DCS body that ends with BEL leaves the scanner usable", () => {
    // The scanner ends a string body on ST or on BEL. A body that never ends
    // would stop every later answer.
    expect(answers(`${ESC}Pdata${BEL}${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("an OSC body longer than the limit leaves the scanner usable", () => {
    // The scanner keeps 4096 body bytes. It drops the rest, it answers that
    // sequence not at all, and it reads the next query as usual.
    expect(answers(`${ESC}]11;${"x".repeat(5000)}?${BEL}${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("a CSI longer than the limit leaves the scanner usable", () => {
    expect(answers(`${ESC}[${"1;".repeat(40)}c${ESC}[c`)).toEqual([DA1_ANSWER]);
  });
});

describe("CAN and SUB", () => {
  // The engine drops the sequence in progress on either byte and prints the
  // rest as text. An answer for such a sequence is an answer that the
  // terminal never gave.
  test("a CAN inside a CSI drops the query", () => {
    expect(answers(`${ESC}[\x18c`)).toEqual([]);
  });

  test("a SUB inside a CSI drops the query", () => {
    expect(answers(`${ESC}[\x1ac`)).toEqual([]);
  });

  test("a CAN inside an OSC 11 query drops the answer", () => {
    expect(answers(`${ESC}]11;\x18?${BEL}`)).toEqual([]);
  });

  test("a CAN after the ESC drops the sequence", () => {
    expect(answers(`${ESC}\x18[c${ESC}[c`)).toEqual([DA1_ANSWER]);
  });

  test("the scanner reads the next query after a CAN", () => {
    expect(answers(`${ESC}[\x18c${ESC}[c`)).toEqual([DA1_ANSWER]);
  });
});
