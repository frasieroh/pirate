/**
 * The VT layer: `web/src/vt`.
 *
 * Every assertion reads the state of the wasm engine through the layer. No
 * browser and no canvas take part. The tests write bytes to the parser, then
 * they read cells, the cursor, the modes, or the dirty state.
 *
 * The wasm binary comes from `node_modules`, through `Bun.file`. `bun test`
 * is not Vite, and bun cannot resolve the `?url` suffix that the production
 * path uses, so this file gives the bytes to `loadVt` itself. `loadVt` reads
 * the bundled asset only when it gets no argument.
 *
 * Every terminal here has 10 columns or more. ghostty-vt.wasm 0.4.0 corrupts
 * its heap when it frees a narrower grid, and one module serves the whole
 * file. See the note on `VtTerminal.dispose`.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  loadVt,
  VtCellFlags,
  VtKey,
  VtKeyAction,
  VtMods,
  type Vt,
  type VtCell,
  type VtTerminal,
} from "../src/vt";

/** The escape byte, as text. */
const ESC = "\x1b";
/** The bell byte, the terminator of an OSC sequence. */
const BEL = "\x07";

let vt: Vt;
let wasmBytes: ArrayBuffer;

beforeAll(async () => {
  const path = `${import.meta.dir}/../node_modules/ghostty-web/ghostty-vt.wasm`;
  wasmBytes = await Bun.file(path).arrayBuffer();
  vt = await loadVt(wasmBytes);
});

/**
 * Load one more module, for a test that must not share a heap.
 *
 * ghostty-vt.wasm 0.4.0 corrupts its heap when it frees a terminal that held
 * a grapheme cluster. See the note on `VtTerminal.dispose`. A test that hits
 * that path takes its own module, so the corruption reaches no other test.
 */
function freshVt(): Promise<Vt> {
  return loadVt(wasmBytes);
}

/** Make a terminal, run the body, then free the wasm memory. */
function withTerminal(
  cols: number,
  rows: number,
  body: (term: VtTerminal) => void,
): void {
  const term = vt.createTerminal(cols, rows);
  try {
    body(term);
  } finally {
    term.dispose();
  }
}

/** The text of one viewport row, without the trailing empty cells. */
function rowText(term: VtTerminal, row: number): string {
  const line = term.getLine(row);
  if (line === null) {
    return "";
  }
  return line
    .map((cell) => (cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint)))
    .join("")
    .trimEnd();
}

/** The codepoint of a one-character string. */
function cp(char: string): number {
  const value = char.codePointAt(0);
  if (value === undefined) {
    throw new Error("cp needs one character");
  }
  return value;
}

/** The cell at one viewport position. */
function cellAt(term: VtTerminal, x: number, y: number): VtCell {
  const line = term.getLine(y);
  if (line === null) {
    throw new Error(`row ${y} is outside the viewport`);
  }
  return line[x];
}

// ============================================================================
// The nine parse-to-cell behaviors
// ============================================================================

test("plain text lands in the cells of the first row", () => {
  withTerminal(20, 4, (term) => {
    term.write("pirate");

    expect(rowText(term, 0)).toBe("pirate");
    expect(cellAt(term, 0, 0).codepoint).toBe(cp("p"));
    expect(cellAt(term, 5, 0).codepoint).toBe(cp("e"));
    // An untouched cell holds no codepoint.
    expect(cellAt(term, 6, 0).codepoint).toBe(0);
  });
});

test("an SGR foreground color reaches the cell", () => {
  withTerminal(20, 4, (term) => {
    // SGR 38;2;R;G;B sets a direct foreground color. A direct color removes
    // the palette from the assertion, so the test holds for any theme.
    term.write(`${ESC}[38;2;10;200;30mA${ESC}[0mB`);

    const colored = cellAt(term, 0, 0);
    expect([colored.fgR, colored.fgG, colored.fgB]).toEqual([10, 200, 30]);

    // SGR 0 puts the default foreground back, and the default is not the
    // color that this test set.
    const plain = cellAt(term, 1, 0);
    expect([plain.fgR, plain.fgG, plain.fgB]).not.toEqual([10, 200, 30]);
  });
});

test("an SGR background color reaches the cell", () => {
  withTerminal(20, 4, (term) => {
    term.write(`${ESC}[48;2;70;80;90mA${ESC}[0mB`);

    const colored = cellAt(term, 0, 0);
    expect([colored.bgR, colored.bgG, colored.bgB]).toEqual([70, 80, 90]);
    // The foreground of the same cell did not change.
    expect([colored.bgR, colored.bgG, colored.bgB]).not.toEqual([
      colored.fgR,
      colored.fgG,
      colored.fgB,
    ]);

    const plain = cellAt(term, 1, 0);
    expect([plain.bgR, plain.bgG, plain.bgB]).toEqual([0, 0, 0]);
  });
});

test("SGR 1 sets the bold bit of the cell", () => {
  withTerminal(20, 4, (term) => {
    term.write(`${ESC}[1mA${ESC}[0mB`);

    expect(cellAt(term, 0, 0).flags & VtCellFlags.BOLD).toBe(VtCellFlags.BOLD);
    // Bold alone sets no other style bit.
    expect(cellAt(term, 0, 0).flags & VtCellFlags.ITALIC).toBe(0);
    expect(cellAt(term, 1, 0).flags & VtCellFlags.BOLD).toBe(0);
  });
});

test("SGR 3 sets the italic bit of the cell", () => {
  withTerminal(20, 4, (term) => {
    term.write(`${ESC}[3mA${ESC}[0mB`);

    expect(cellAt(term, 0, 0).flags & VtCellFlags.ITALIC).toBe(VtCellFlags.ITALIC);
    expect(cellAt(term, 0, 0).flags & VtCellFlags.BOLD).toBe(0);
    expect(cellAt(term, 1, 0).flags & VtCellFlags.ITALIC).toBe(0);
  });
});

test("SGR 4 sets the underline bit of the cell", () => {
  withTerminal(20, 4, (term) => {
    term.write(`${ESC}[4mA${ESC}[0mB`);

    expect(cellAt(term, 0, 0).flags & VtCellFlags.UNDERLINE).toBe(
      VtCellFlags.UNDERLINE,
    );
    expect(cellAt(term, 1, 0).flags & VtCellFlags.UNDERLINE).toBe(0);
  });
});

test("three SGR attributes together set three bits of one cell", () => {
  withTerminal(20, 4, (term) => {
    term.write(`${ESC}[1;3;4mA`);

    const cell = cellAt(term, 0, 0);
    expect(cell.flags & VtCellFlags.BOLD).toBe(VtCellFlags.BOLD);
    expect(cell.flags & VtCellFlags.ITALIC).toBe(VtCellFlags.ITALIC);
    expect(cell.flags & VtCellFlags.UNDERLINE).toBe(VtCellFlags.UNDERLINE);
  });
});

test("cursor motion puts the character in the addressed cell", () => {
  withTerminal(20, 6, (term) => {
    // CUP counts from 1. Row 3 and column 5 give the 0-based cell (4, 2).
    term.write(`${ESC}[3;5HX`);

    expect(cellAt(term, 4, 2).codepoint).toBe(cp("X"));
    expect(cellAt(term, 3, 2).codepoint).toBe(0);
    expect(term.getCursor()).toEqual({ x: 5, y: 2, visible: true });

    // CUB moves the cursor back over the character it wrote.
    term.write(`${ESC}[2D`);
    expect(term.getCursor().x).toBe(3);
    expect(term.getCursor().y).toBe(2);
  });
});

test("the alternate screen hides the text of the normal screen", () => {
  withTerminal(20, 4, (term) => {
    term.write("normal");
    expect(term.isAlternateScreen()).toBe(false);

    term.write(`${ESC}[?1049h`);
    expect(term.isAlternateScreen()).toBe(true);
    // The alternate screen starts empty. The text of the normal screen is
    // gone from the viewport.
    expect(rowText(term, 0)).toBe("");

    // DEC mode 1049 keeps the cursor, so the write starts at column 6. CUP
    // brings it home first.
    term.write(`${ESC}[Halternate`);
    expect(rowText(term, 0)).toBe("alternate");

    // A switch back gives the normal screen and its text.
    term.write(`${ESC}[?1049l`);
    expect(term.isAlternateScreen()).toBe(false);
    expect(rowText(term, 0)).toBe("normal");
  });
});

test("dirty tracking marks the written row and clears on demand", () => {
  withTerminal(20, 4, (term) => {
    term.write("first");
    expect(term.isDirty()).toBe(true);

    term.clearDirty();
    expect(term.isDirty()).toBe(false);
    expect(term.isRowDirty(0)).toBe(false);
    expect(term.isRowDirty(2)).toBe(false);

    // A write to row 2 alone marks row 2 alone.
    term.write(`${ESC}[3;1Hthird`);
    expect(term.isDirty()).toBe(true);
    expect(term.isRowDirty(2)).toBe(true);
    expect(term.isRowDirty(1)).toBe(false);
  });
});

test("a screen switch asks for a full redraw", () => {
  withTerminal(20, 4, (term) => {
    term.write("normal");
    term.clearDirty();
    expect(term.needsFullRedraw()).toBe(false);

    term.write(`${ESC}[?1049h`);
    expect(term.needsFullRedraw()).toBe(true);

    term.clearDirty();
    expect(term.needsFullRedraw()).toBe(false);
  });
});

// ============================================================================
// Cells and lines
// ============================================================================

describe("cells and lines", () => {
  test("the viewport holds one cell per position, in row-major order", () => {
    withTerminal(10, 3, (term) => {
      term.write(`A${ESC}[2;1HB${ESC}[3;10HC`);
      const viewport = term.getViewport();

      // Row-major order: the index of a cell is `y * cols + x`.
      expect(viewport.length).toBe(30);
      expect(viewport[0].codepoint).toBe(cp("A"));
      expect(viewport[10].codepoint).toBe(cp("B"));
      expect(viewport[29].codepoint).toBe(cp("C"));
    });
  });

  test("getLine gives a copy, and the viewport reuses its cells", () => {
    withTerminal(10, 2, (term) => {
      term.write("A");
      const line = term.getLine(0);
      const pooled = term.getViewport()[0];

      // A later write changes the pooled cell. The copy from `getLine` keeps
      // the value that it had.
      term.write(`${ESC}[1;1HZ`);
      term.getViewport();
      expect(pooled.codepoint).toBe(cp("Z"));
      expect(line?.[0].codepoint).toBe(cp("A"));
    });
  });

  test("a row outside the viewport gives null", () => {
    withTerminal(10, 2, (term) => {
      expect(term.getLine(-1)).toBeNull();
      expect(term.getLine(2)).toBeNull();
      expect(term.getLine(1.5)).toBeNull();
      expect(term.getLine(1)).not.toBeNull();
    });
  });
});

// ============================================================================
// Scrollback
// ============================================================================

describe("scrollback", () => {
  test("a line that leaves the viewport lands in the scrollback", () => {
    withTerminal(10, 2, (term) => {
      expect(term.getScrollbackLength()).toBe(0);

      term.write("one\r\ntwo\r\nthree\r\nfour\r\n");
      expect(term.getScrollbackLength()).toBe(3);

      // Offset 0 is the oldest line.
      const oldest = term.getScrollbackLine(0);
      expect(oldest?.length).toBe(10);
      expect(String.fromCodePoint(oldest?.[0].codepoint ?? 0)).toBe("o");

      const newest = term.getScrollbackLine(2);
      expect(String.fromCodePoint(newest?.[0].codepoint ?? 0)).toBe("t");
      expect(String.fromCodePoint(newest?.[4].codepoint ?? 0)).toBe("e");
    });
  });

  test("an offset outside the scrollback gives null", () => {
    withTerminal(10, 2, (term) => {
      term.write("one\r\ntwo\r\nthree\r\n");
      expect(term.getScrollbackLine(-1)).toBeNull();
      expect(term.getScrollbackLine(99)).toBeNull();
    });
  });
});

// ============================================================================
// Colors, modes, graphemes, hyperlinks, responses
// ============================================================================

describe("colors", () => {
  test("the default colors are a foreground and a background", () => {
    withTerminal(10, 2, (term) => {
      const colors = term.getColors();
      expect(colors.foreground).toEqual({ r: 0xcc, g: 0xcc, b: 0xcc });
      expect(colors.background).toEqual({ r: 0, g: 0, b: 0 });
    });
  });
});

describe("modes", () => {
  test("bracketed paste, focus events, and mouse tracking follow the stream", () => {
    withTerminal(10, 2, (term) => {
      expect(term.hasBracketedPaste()).toBe(false);
      expect(term.hasFocusEvents()).toBe(false);
      expect(term.hasMouseTracking()).toBe(false);

      term.write(`${ESC}[?2004h${ESC}[?1004h${ESC}[?1000h`);
      expect(term.hasBracketedPaste()).toBe(true);
      expect(term.hasFocusEvents()).toBe(true);
      expect(term.hasMouseTracking()).toBe(true);

      term.write(`${ESC}[?2004l${ESC}[?1004l${ESC}[?1000l`);
      expect(term.hasBracketedPaste()).toBe(false);
      expect(term.hasFocusEvents()).toBe(false);
      expect(term.hasMouseTracking()).toBe(false);
    });
  });

  test("one mode by number follows the stream", () => {
    withTerminal(10, 2, (term) => {
      // DEC mode 25 is the cursor visibility. It starts set.
      expect(term.getMode(25)).toBe(true);
      term.write(`${ESC}[?25l`);
      expect(term.getMode(25)).toBe(false);
      expect(term.getCursor().visible).toBe(false);
    });
  });
});

describe("graphemes", () => {
  test("a combining mark joins the base character in one cell", async () => {
    // This test writes a grapheme cluster, so it takes its own module. See
    // `freshVt`.
    const solo = await freshVt();
    const term = solo.createTerminal(80, 24);
    try {
      // Row 0 holds `AB`. Row 1 holds `e`, then U+0301, the combining acute
      // accent, then `Z`. The escape keeps the two codepoints apart in this
      // file. A precomposed acute `e` is one codepoint and proves nothing
      // about a cluster.
      term.write("AB\r\ne\u0301Z");

      expect(cellAt(term, 0, 1).graphemeLength).toBe(1);
      expect(term.getGrapheme(0, 1)).toEqual([0x65, 0x301]);
      expect(term.getGraphemeString(0, 1)).toBe("e\u0301");

      // The cluster sits at the column 0 of the row 1. The wasm call takes
      // the row before the column, so a call with the two arguments in the
      // other order reads the cell (1, 0) and answers `B`.
      expect(term.getGrapheme(1, 0)).toEqual([cp("B")]);
      expect(term.getGraphemeString(1, 1)).toBe("Z");
    } finally {
      term.dispose();
    }
  });

  test("a plain cell gives one codepoint", () => {
    withTerminal(10, 2, (term) => {
      term.write("AB");

      expect(term.getGrapheme(0, 0)).toEqual([cp("A")]);
      expect(term.getGraphemeString(1, 0)).toBe("B");
    });
  });

  test("a cell outside the viewport gives null and a space", () => {
    withTerminal(10, 2, (term) => {
      expect(term.getGrapheme(99, 0)).toBeNull();
      expect(term.getGraphemeString(99, 0)).toBe(" ");
      // An empty cell inside the viewport gives a space, not an empty string.
      expect(term.getGraphemeString(5, 0)).toBe(" ");
    });
  });
});

describe("hyperlinks", () => {
  test("a cell of an OSC 8 link gives the URI, and a plain cell gives null", () => {
    withTerminal(20, 2, (term) => {
      term.write(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL} plain`);

      expect(cellAt(term, 0, 0).hyperlinkId).not.toBe(0);
      expect(term.getHyperlinkUri(0, 0)).toBe("https://example.com");
      expect(term.getHyperlinkUri(3, 0)).toBe("https://example.com");
      // The space and the word after the closing sequence carry no link.
      expect(term.getHyperlinkUri(5, 0)).toBeNull();
      expect(term.getHyperlinkUri(99, 0)).toBeNull();
    });
  });

  test("a scrollback cell of an OSC 8 link gives the URI", () => {
    withTerminal(10, 2, (term) => {
      term.write(`${ESC}]8;;https://example.com${BEL}ab${ESC}]8;;${BEL}\r\n`);
      term.write("two\r\nthree\r\nfour\r\n");

      expect(term.getScrollbackLength()).toBeGreaterThan(0);
      expect(term.getScrollbackHyperlinkUri(0, 0)).toBe("https://example.com");
      expect(term.getScrollbackHyperlinkUri(0, 5)).toBeNull();
      expect(term.getScrollbackHyperlinkUri(99, 0)).toBeNull();
    });
  });

  test("a stream of two different URIs gives null, not a wrong URI", () => {
    withTerminal(20, 2, (term) => {
      term.write(`${ESC}]8;;https://one.example${BEL}A${ESC}]8;;${BEL}`);
      term.write(`${ESC}]8;;https://two.example${BEL}B${ESC}]8;;${BEL}`);

      // The wasm module gives the same hyperlink id to both cells, so the
      // layer cannot say which URI belongs to which cell.
      expect(cellAt(term, 0, 0).hyperlinkId).toBe(cellAt(term, 1, 0).hyperlinkId);
      expect(term.getHyperlinkUri(0, 0)).toBeNull();
      expect(term.getHyperlinkUri(1, 0)).toBeNull();
    });
  });

  test("an OSC 8 sequence split across two writes gives the URI", () => {
    withTerminal(20, 2, (term) => {
      term.write(`${ESC}]8;;https://split.ex`);
      term.write(`ample${BEL}A${ESC}]8;;${BEL}`);

      expect(term.getHyperlinkUri(0, 0)).toBe("https://split.example");
    });
  });

  test("an ESC backslash terminator ends the sequence too", () => {
    withTerminal(20, 2, (term) => {
      term.write(`${ESC}]8;;https://st.example${ESC}\\A${ESC}]8;;${ESC}\\`);

      expect(term.getHyperlinkUri(0, 0)).toBe("https://st.example");
    });
  });
});

describe("responses", () => {
  test("DSR gives one cursor position report, and one only", () => {
    withTerminal(10, 3, (term) => {
      expect(term.hasResponse()).toBe(false);
      expect(term.readResponse()).toBeNull();

      term.write(`${ESC}[2;3H${ESC}[6n`);
      expect(term.hasResponse()).toBe(true);
      // DSR counts from 1, so row 2 and column 3 come back as 2 and 3.
      expect(term.readResponse()).toBe(`${ESC}[2;3R`);

      expect(term.hasResponse()).toBe(false);
      expect(term.readResponse()).toBeNull();
    });
  });
});

// ============================================================================
// Key encoding
// ============================================================================

describe("key encoding", () => {
  /** Encode one key press and give the bytes as text. */
  function press(term: VtTerminal, key: number, mods = VtMods.NONE, utf8?: string) {
    const bytes = term.encodeKey({ action: VtKeyAction.PRESS, key, mods, utf8 });
    return new TextDecoder().decode(bytes);
  }

  test("a printable key, Control, and Enter give their bytes", () => {
    withTerminal(10, 2, (term) => {
      expect(press(term, VtKey.A, VtMods.NONE, "a")).toBe("a");
      expect(press(term, VtKey.C, VtMods.CTRL, "c")).toBe("\x03");
      expect(press(term, VtKey.ENTER)).toBe("\r");
      // A modifier alone produces nothing.
      expect(press(term, VtKey.SHIFT_LEFT, VtMods.SHIFT)).toBe("");
    });
  });

  test("the cursor keys follow DEC mode 1 of the terminal", () => {
    withTerminal(10, 2, (term) => {
      expect(press(term, VtKey.UP)).toBe(`${ESC}[A`);
      expect(press(term, VtKey.LEFT)).toBe(`${ESC}[D`);

      // DECCKM selects the application form. A program such as vim sets it.
      term.write(`${ESC}[?1h`);
      expect(press(term, VtKey.UP)).toBe(`${ESC}OA`);
      expect(press(term, VtKey.LEFT)).toBe(`${ESC}OD`);

      term.write(`${ESC}[?1l`);
      expect(press(term, VtKey.UP)).toBe(`${ESC}[A`);
    });
  });

  test("what the terminal encodes comes back through the parser", () => {
    withTerminal(10, 3, (term) => {
      term.write("abc");
      expect(term.getCursor()).toEqual({ x: 3, y: 0, visible: true });

      // Enter encodes CR alone. CR brings the cursor to column 0 and holds
      // the row. The host, not the terminal, turns CR into CR and LF.
      const bytes = term.encodeKey({
        action: VtKeyAction.PRESS,
        key: VtKey.ENTER,
        mods: VtMods.NONE,
      });
      term.write(bytes);
      expect(term.getCursor()).toEqual({ x: 0, y: 0, visible: true });

      // The printable key gives the character back to the cell.
      term.write(term.encodeKey({ action: VtKeyAction.PRESS, key: VtKey.Z, mods: 0, utf8: "z" }));
      expect(cellAt(term, 0, 0).codepoint).toBe(cp("z"));
    });
  });
});

// ============================================================================
// Lifetime
// ============================================================================

describe("lifetime", () => {
  test("a terminal of a wrong size is refused", () => {
    expect(() => vt.createTerminal(0, 24)).toThrow();
    expect(() => vt.createTerminal(80, -1)).toThrow();
    expect(() => vt.createTerminal(80.5, 24)).toThrow();
  });

  test("dispose runs one time", () => {
    const term = vt.createTerminal(10, 2);
    term.write("A");
    term.dispose();
    // A second call frees nothing again. A double free corrupts the wasm heap.
    expect(() => term.dispose()).not.toThrow();
  });

  test("one module serves many terminals", () => {
    withTerminal(10, 2, (first) => {
      withTerminal(10, 2, (second) => {
        first.write("one");
        second.write("two");
        expect(rowText(first, 0)).toBe("one");
        expect(rowText(second, 0)).toBe("two");
      });
    });
  });
});
