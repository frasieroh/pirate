/**
 * The scanner of `web/src/vt/query.ts` against the parser of the engine.
 *
 * The scanner and the parser read the same bytes. An answer is correct only
 * when the parser dispatched the query that the answer replies to. A scanner
 * that ends a sequence one byte later than the parser answers a query that
 * the terminal never got, and a scanner that ends it one byte earlier drops
 * an answer that the program waits for.
 *
 * Each test writes one stream to the engine and to the scanner. The stream
 * carries `ESC [ 6 n`, DSR, at the point that is under test. The engine
 * answers DSR, so the answer of the engine reports whether the parser reached
 * that CSI. The same stream with `ESC [ c` in place of the DSR reports
 * whether the scanner reached it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { answerOf, DA1_ANSWER, loadVt, QueryScanner, type Vt } from "../src/vt";

/** The escape byte, as text. */
const ESC = "\x1b";
/** The bell byte, one terminator of a string sequence. */
const BEL = "\x07";
/** CAN, the byte that stops the sequence in progress. */
const CAN = "\x18";
/** SUB, the second byte that stops the sequence in progress. */
const SUB = "\x1a";

let vt: Vt;

beforeAll(async () => {
  const path = `${import.meta.dir}/../node_modules/ghostty-web/ghostty-vt.wasm`;
  vt = await loadVt(await Bun.file(path).arrayBuffer());
});

/** True when the parser dispatched the DSR that `text` carries. */
function engineReadsCsi(text: string): boolean {
  const term = vt.createTerminal(20, 4);
  try {
    term.write(new TextEncoder().encode(text));
    return term.hasResponse();
  } finally {
    term.dispose();
  }
}

/** True when the scanner named the DA1 that `text` carries. */
function scannerReadsCsi(text: string): boolean {
  const scanner = new QueryScanner();
  const events = scanner.feed(new TextEncoder().encode(text));
  return events.some(
    (event) =>
      answerOf(event.query, {
        isModeSet: () => false,
        background: () => "#000000",
      }) === DA1_ANSWER,
  );
}

/**
 * Give the engine the DSR form and the scanner the DA1 form, and report both.
 *
 * `text` carries `%s` at the place of the query.
 */
function both(text: string): { engine: boolean; scanner: boolean } {
  return {
    engine: engineReadsCsi(text.replace("%s", `${ESC}[6n`)),
    scanner: scannerReadsCsi(text.replace("%s", `${ESC}[c`)),
  };
}

describe("the parser and the scanner end a sequence at the same byte", () => {
  const streams: Record<string, string> = {
    "plain output": `hello %s`,
    "after an OSC that ends with BEL": `${ESC}]0;title${BEL}%s`,
    "after an OSC that ends with ST": `${ESC}]0;title${ESC}\\%s`,
    "inside an OSC body, after the ESC": `${ESC}]0;title%s`,
    "inside an OSC body, after a CAN": `${ESC}]0;title${CAN}%s`,
    "after a DCS that ends with ST": `${ESC}Pdata${ESC}\\%s`,
    "inside a DCS body, after the ESC": `${ESC}Pdata%s`,
    "inside a DCS body, after a BEL": `${ESC}Pdata${BEL}%s`,
    "inside a DCS body, after a CAN": `${ESC}Pdata${CAN}%s`,
    "inside a DCS body, after a SUB": `${ESC}Pdata${SUB}%s`,
    "inside an APC body, after the ESC": `${ESC}_Gf=100%s`,
    "inside an APC body, after a CAN": `${ESC}_Gf=100${CAN}%s`,
    "inside a PM body, after the ESC": `${ESC}^data%s`,
    "inside an SOS body, after the ESC": `${ESC}Xdata%s`,
    "after the doubled ESC of a DCS passthrough": `${ESC}Ptmux;${ESC}${ESC}[c${ESC}\\%s`,
    "after a C0 byte inside a CSI": `${ESC}[${BEL}1;2H%s`,
  };

  for (const [name, stream] of Object.entries(streams)) {
    test(`the query ${name} reaches both`, () => {
      const got = both(stream);
      expect(got.engine).toBe(true);
      expect(got.scanner).toBe(true);
    });
  }
});

describe("a CAN or a SUB inside a CSI drops that CSI in both", () => {
  // The engine logs "invalid C0 character, ignoring" and prints the rest of
  // the sequence as text. An answer for it would be an answer that the
  // terminal never gave.
  test("a CAN before the final byte drops the query", () => {
    expect(engineReadsCsi(`${ESC}[${CAN}6n`)).toBe(false);
    expect(scannerReadsCsi(`${ESC}[${CAN}c`)).toBe(false);
  });

  test("a SUB before the final byte drops the query", () => {
    expect(engineReadsCsi(`${ESC}[${SUB}6n`)).toBe(false);
    expect(scannerReadsCsi(`${ESC}[${SUB}c`)).toBe(false);
  });
});

describe("the engine leaves these queries open", () => {
  // The scanner exists because of this measurement. A version of the engine
  // that answers one of these would make the client send two answers.
  const open: Record<string, string> = {
    DA1: `${ESC}[c`,
    "DA1 with an explicit zero": `${ESC}[0c`,
    DA2: `${ESC}[>c`,
    "the kitty keyboard query": `${ESC}[?u`,
    "OSC 11": `${ESC}]11;?${BEL}`,
    DECRQM: `${ESC}[?2004$p`,
  };

  for (const [name, stream] of Object.entries(open)) {
    test(`${name} gets no answer from the engine`, () => {
      expect(engineReadsCsi(stream)).toBe(false);
    });
  }

  test("DSR gets an answer from the engine", () => {
    expect(engineReadsCsi(`${ESC}[6n`)).toBe(true);
  });
});
