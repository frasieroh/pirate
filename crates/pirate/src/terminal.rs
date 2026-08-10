//! The server-side terminal.
//!
//! Every byte that the PTY produces goes through this terminal before it goes
//! to the browser. The browser runs the same Ghostty parser as WebAssembly, so
//! the two screens agree.
//!
//! The server keeps a screen for two reasons. The first is the state dump: a
//! client that connects gets the screen as VT sequences, so it needs no special
//! code path and a dump is only more bytes. The second is backpressure
//! recovery: a client that falls behind gets its backlog dropped and one fresh
//! dump, which is smaller than the backlog and always correct.
//!
//! CAUTION: `libghostty_vt::Terminal` is neither `Send` nor `Sync`, because the
//! C library can use thread-local state. Therefore this type is `!Send` also,
//! and one thread must create it and use it. `session.rs` gives it that thread.

use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use libghostty_vt::terminal::{Point, PointCoordinate};
use libghostty_vt::{Terminal, TerminalOptions};

/// Lines of scrollback that the server keeps.
///
/// The browser keeps its own scrollback and renders from it, so this buffer
/// serves the state dump only. A small value is sufficient and it caps the
/// memory of one session.
const SCROLLBACK: usize = 1000;

/// Cell size in pixels, for the sequences that report a size in pixels.
///
/// pirate has no font metrics on the server, and the browser owns the true
/// values. These two numbers keep the reports plausible.
const CELL_WIDTH_PX: u32 = 8;
const CELL_HEIGHT_PX: u32 = 16;

/// The largest terminal that a client can ask for.
///
/// The browser owns the true size, and it sends it in a `0x01` resize frame.
/// That frame carries two `u16` values, so a client can ask for 65535 by
/// 65535. Nothing else bounds the grid: the request took 3.9 GB of resident
/// memory in a measurement against the real binary, the dump of that grid
/// never completed, and the memory stayed after the socket closed. One frame
/// of five bytes therefore took the whole process, and every other terminal of
/// the operator with it.
///
/// 2000 is beyond any real display. A 5120-pixel screen at the smallest font
/// that the client offers, 8 pixels, gives about 1066 columns. The measured
/// cost of a 2000 by 2000 grid is about 35 MB.
///
/// CAUTION: A clamp is silent, and it must stay silent. An oversized request
/// gives a clamped terminal, which is a terminal that works. A refusal gives
/// the browser no screen at all.
pub const MAX_COLS: u16 = 2000;
/// The largest number of rows that a client can ask for. See [`MAX_COLS`].
pub const MAX_ROWS: u16 = 2000;

/// Sent before a dump of the alternate screen.
///
/// `ESC [ ? 1049 h` enters the alternate screen and clears it. `ESC [ H` and
/// `ESC [ 2 J` then home the cursor and erase, which makes the start state the
/// same for a client that was already there.
const ENTER_ALTERNATE: &[u8] = b"\x1b[?1049h\x1b[H\x1b[2J";

/// Sent before a dump of the primary screen.
///
/// `ESC [ ? 1049 l` leaves the alternate screen. A client that is not in the
/// alternate screen keeps its content, so this sequence is safe in both cases.
const LEAVE_ALTERNATE: &[u8] = b"\x1b[?1049l\x1b[H\x1b[2J";

/// The private modes that switch the screen.
///
/// 1049 is the mode of tmux, vim, and less. 47 and 1047 are the older modes,
/// and terminfo entries still carry them.
const SCREEN_MODES: [&[u8]; 3] = [b"47", b"1047", b"1049"];

/// The longest parameter of [`SCREEN_MODES`].
const MODE_LEN: usize = 4;

/// The step of [`ScreenScanner`].
#[derive(Clone, Copy)]
enum ScanStep {
    /// Outside an escape sequence.
    Ground,
    /// After ESC.
    Escape,
    /// After `CSI`, before the private mode marker.
    Csi,
    /// Inside the parameters of `CSI ? Pm`.
    Params,
    /// Inside a sequence that cannot switch the screen.
    Ignore,
}

/// A scanner that finds the byte that switches the screen.
///
/// The sequence is `CSI ? Pm h`, which sets a private mode, or `CSI ? Pm r`,
/// which restores one. A parameter of 47, 1047, or 1049 switches the screen.
///
/// The scanner holds its step between calls, because the PTY cuts a chunk at
/// any byte. A sequence that starts in one chunk and ends in the next one
/// therefore counts the same as a sequence inside one chunk.
struct ScreenScanner {
    step: ScanStep,
    /// The parameter that the scanner reads now.
    param: [u8; MODE_LEN],
    /// The length of `param`. A value of more than `MODE_LEN` marks a
    /// parameter that is too long to be a screen mode.
    param_len: usize,
    /// True when a parameter of the current sequence is a screen mode.
    hit: bool,
    /// True when the current sequence holds an intermediate byte, such as the
    /// `$` of `CSI ? Pm $ p`. Such a sequence reports a mode. It sets none.
    intermediate: bool,
}

impl ScreenScanner {
    fn new() -> Self {
        Self {
            step: ScanStep::Ground,
            param: [0; MODE_LEN],
            param_len: 0,
            hit: false,
            intermediate: false,
        }
    }

    /// Start a new `CSI ? Pm` sequence.
    fn start_params(&mut self) {
        self.step = ScanStep::Params;
        self.param_len = 0;
        self.hit = false;
        self.intermediate = false;
    }

    /// Close the parameter that the scanner reads now.
    fn end_param(&mut self) {
        if self.param_len <= MODE_LEN && SCREEN_MODES.contains(&&self.param[..self.param_len]) {
            self.hit = true;
        }
        self.param_len = 0;
    }

    /// The index of the byte of `bytes` that switches the screen.
    ///
    /// The scanner consumes every byte up to and including that one. Call this
    /// function again on the rest of the chunk to find the next switch.
    fn next_switch(&mut self, bytes: &[u8]) -> Option<usize> {
        for (i, byte) in bytes.iter().enumerate() {
            // ESC cancels the sequence that came before it, at every step.
            if *byte == 0x1b {
                self.step = ScanStep::Escape;
                continue;
            }
            match self.step {
                ScanStep::Ground => {}
                ScanStep::Escape => {
                    self.step = if *byte == b'[' {
                        ScanStep::Csi
                    } else {
                        ScanStep::Ground
                    };
                }
                ScanStep::Csi => {
                    if *byte == b'?' {
                        self.start_params();
                    } else {
                        self.step = ScanStep::Ignore;
                    }
                }
                ScanStep::Params => match byte {
                    // A C0 control byte runs and leaves the sequence intact.
                    0x00..=0x1f => {}
                    b';' => self.end_param(),
                    0x30..=0x3f => {
                        if self.param_len < MODE_LEN {
                            self.param[self.param_len] = *byte;
                        }
                        self.param_len += 1;
                    }
                    // An intermediate byte, such as the `$` of a mode report.
                    0x20..=0x2f => self.intermediate = true,
                    // The final byte.
                    _ => {
                        self.end_param();
                        self.step = ScanStep::Ground;
                        if !self.intermediate && matches!(byte, b'h' | b'r') && self.hit {
                            return Some(i);
                        }
                    }
                },
                ScanStep::Ignore => {
                    if (0x40..=0x7e).contains(byte) {
                        self.step = ScanStep::Ground;
                    }
                }
            }
        }
        None
    }
}

/// The authoritative screen state of one session.
pub struct ScreenTerminal {
    inner: Terminal<'static, 'static>,
    /// The screen that the last write left active.
    ///
    /// The state dump needs the screen transition, and not the screen alone.
    /// This field holds the value from before the current write.
    alternate: bool,
    /// The dump of the primary screen that the terminal took when it entered
    /// the alternate screen.
    ///
    /// The formatter of libghostty-vt 0.2.1 reads the active screen only, so
    /// this capture is the one record of the screen behind the program. It is
    /// `None` when the primary screen held no text, and again after the
    /// terminal leaves the alternate screen.
    primary: Option<Vec<u8>>,
    /// The scanner that finds the switch inside the stream of the PTY.
    scanner: ScreenScanner,
}

impl ScreenTerminal {
    /// Create a terminal of this size.
    pub fn new(cols: u16, rows: u16) -> Result<Self, libghostty_vt::Error> {
        // The same ceiling as `resize`. This constructor is public too, and
        // the CAUTION on `resize` applies to it word for word.
        let inner = Terminal::new(TerminalOptions {
            cols: cols.clamp(1, MAX_COLS),
            rows: rows.clamp(1, MAX_ROWS),
            max_scrollback: SCROLLBACK,
        })?;
        Ok(Self {
            inner,
            alternate: false,
            primary: None,
            scanner: ScreenScanner::new(),
        })
    }

    /// Feed PTY output into the parser.
    ///
    /// This never fails. libghostty-vt treats the input as untrusted and logs
    /// a malformed sequence instead of stopping.
    ///
    /// The write stops before the byte that switches the screen, and it
    /// captures the primary screen there. See [`Self::dump`].
    pub fn write(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(at) = self.scanner.next_switch(rest) {
            // Every byte up to the final byte of the sequence belongs to the
            // screen that is active now, so those bytes go in first. The
            // partial sequence among them changes no cell.
            self.inner.vt_write(&rest[..at]);
            self.observe(None);
            let capture = self.capture_primary();
            self.inner.vt_write(&rest[at..=at]);
            self.observe(capture);
            rest = &rest[at + 1..];
        }
        self.inner.vt_write(rest);
        self.observe(None);
    }

    /// Read the active screen, then hold or drop the capture of the primary
    /// screen.
    ///
    /// `capture` is the primary screen from before the byte that the caller
    /// wrote last. It becomes [`Self::primary`] when that byte reached the
    /// alternate screen.
    fn observe(&mut self, capture: Option<Vec<u8>>) {
        let alternate = self.on_alternate_screen().unwrap_or(self.alternate);
        if alternate && !self.alternate {
            self.primary = capture;
        } else if !alternate {
            self.primary = None;
        }
        self.alternate = alternate;
    }

    /// A dump of the primary screen, for [`Self::dump`] to send before the
    /// alternate screen.
    ///
    /// The result is `None` when the alternate screen is already active, or
    /// when the primary screen holds no text. An empty capture carries nothing
    /// and it clears the primary screen of a client that holds content there.
    fn capture_primary(&self) -> Option<Vec<u8>> {
        if self.alternate || self.is_blank().unwrap_or(true) {
            return None;
        }
        self.dump().ok()
    }

    /// True when the active screen holds no text.
    fn is_blank(&self) -> Result<bool, libghostty_vt::Error> {
        let options = FormatterOptions::new()
            .with_format(Format::Plain)
            .with_unwrap(false)
            .with_trim(true);
        let mut formatter = Formatter::new(&self.inner, options)?;
        let text = formatter.format_alloc(None)?;
        Ok(text.iter().all(u8::is_ascii_whitespace))
    }

    /// Apply a new window size.
    ///
    /// The PTY takes the same size in the same handler, so the two cannot
    /// drift. See `Session::resize`.
    ///
    /// CAUTION: Keep the clamp here as well as in `Session::resize`. This is
    /// defense in depth and it is not a duplicate: this type is public, and a
    /// later caller can reach it without passing through `Session`.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), libghostty_vt::Error> {
        self.inner.resize(
            cols.clamp(1, MAX_COLS),
            rows.clamp(1, MAX_ROWS),
            CELL_WIDTH_PX,
            CELL_HEIGHT_PX,
        )
    }

    /// The screen as VT sequences, ready to send as a `0x01` frame.
    ///
    /// The result starts with a screen switch and a clear, so a client that
    /// applies it replaces its screen and does not add to it. It ends with the
    /// cursor position.
    ///
    /// # Two faults in the formatter of libghostty-vt 0.2.1
    ///
    /// Both workarounds below have a test. Do not remove one without a
    /// measurement that shows that the formatter changed.
    ///
    /// **Fault 1: the tabstops move the cursor.** The formatter emits the
    /// cursor position with CUP, and then emits the tabstop program. That
    /// program is `ESC [ 3 g`, then `ESC [ n G` and `ESC H` for each stop, and
    /// `ESC [ n G` moves the cursor. A replayed dump therefore left the cursor
    /// at the last tabstop. The last sequence of this dump puts the cursor back.
    ///
    /// **Fault 2: the dump never leaves the alternate screen.** The formatter
    /// emits a mode only when that mode differs from its default. The primary
    /// screen is the default, so a dump of the primary screen carries no
    /// `ESC [ ? 1049 l`. A client that was inside vim or tmux therefore stayed
    /// in the alternate screen and took the primary content onto it, which is
    /// the mixed state that a slow tmux user would have seen after a resync.
    /// This function emits the switch itself, in both directions.
    ///
    /// The switch also fixes the order. A clear must come after the switch and
    /// never before it, because a clear before the switch erases the screen
    /// that the client is leaving. That screen is the one that this dump does
    /// not carry, and its content must survive.
    ///
    /// # The screen behind the alternate screen
    ///
    /// The formatter carries the active screen only, and libghostty-vt 0.2.1
    /// gives no way to read the other one. A client that connected while a
    /// program held the alternate screen therefore got an empty primary
    /// screen, and it saw that empty screen when the program ended.
    ///
    /// [`Self::write`] captures the primary screen at the moment that the
    /// terminal enters the alternate screen. A dump of the alternate screen
    /// sends that capture first. The order is the primary screen, the switch,
    /// the alternate screen, and the cursor.
    ///
    /// The capture is absent when the primary screen held no text. A blank
    /// capture carries nothing, and its clear would erase the shell history of
    /// a client that already has it.
    ///
    /// The capture holds the width and the height of the screen at the moment
    /// of the switch. A resize after that moment reflows the primary screen of
    /// this terminal, and a line that is longer than the new width therefore
    /// wraps at a different column on a client that replays the capture.
    pub fn dump(&self) -> Result<Vec<u8>, libghostty_vt::Error> {
        // Every extra that the formatter offers is on. A dump that omits the
        // modes or the palette gives the browser a screen that differs from
        // this one, and the difference is silent.
        let options = FormatterOptions::new()
            .with_format(Format::Vt)
            .with_unwrap(false)
            .with_trim(false)
            .with_palette(true)
            .with_modes(true)
            .with_scrolling_region(true)
            .with_tabstops(true)
            .with_keyboard(true)
            .with_cursor(true)
            .with_style(true)
            .with_hyperlink(true)
            .with_protection(true)
            .with_kitty_keyboard(true)
            .with_charsets(true);

        let mut formatter = Formatter::new(&self.inner, options)?;
        let bytes = formatter.format_alloc(None)?;

        // Put the client on the screen that this terminal is on, and only then
        // clear. See fault 2 above.
        let alternate = self.on_alternate_screen()?;
        let prefix = if alternate {
            ENTER_ALTERNATE
        } else {
            LEAVE_ALTERNATE
        };

        // The screen behind the alternate screen goes first. It carries its
        // own leave and clear, so it lands on the primary screen of a client
        // that is on either screen.
        let primary: &[u8] = if alternate {
            self.primary.as_deref().unwrap_or(&[])
        } else {
            &[]
        };

        // CUP is one-based, and the terminal reports a zero-based position.
        let (x, y) = self.cursor()?;
        let cursor = format!("\x1b[{};{}H", u32::from(y) + 1, u32::from(x) + 1);

        let mut out = Vec::with_capacity(primary.len() + prefix.len() + bytes.len() + cursor.len());
        out.extend_from_slice(primary);
        out.extend_from_slice(prefix);
        out.extend_from_slice(&bytes);
        out.extend_from_slice(cursor.as_bytes());
        Ok(out)
    }

    /// The cursor position, as a zero-based column and row.
    pub fn cursor(&self) -> Result<(u16, u16), libghostty_vt::Error> {
        Ok((self.inner.cursor_x()?, self.inner.cursor_y()?))
    }

    /// The size, as columns and rows.
    pub fn size(&self) -> Result<(u16, u16), libghostty_vt::Error> {
        Ok((self.inner.cols()?, self.inner.rows()?))
    }

    /// True when the alternate screen is active.
    ///
    /// tmux, vim, and less all run there. The dump must land a client on the
    /// same screen, so this value is part of the state that the dump carries.
    pub fn on_alternate_screen(&self) -> Result<bool, libghostty_vt::Error> {
        Ok(self.inner.active_screen()? == libghostty_vt::screen::Screen::Alternate)
    }

    /// The character in one cell of the active area.
    ///
    /// An empty cell gives a space, so a caller can compare a whole row.
    pub fn cell(&self, x: u16, y: u16) -> Result<char, libghostty_vt::Error> {
        let grid = self
            .inner
            .grid_ref(Point::Active(PointCoordinate { x, y: u32::from(y) }))?;
        let codepoint = grid.cell()?.codepoint();
        match codepoint {
            Ok(0) | Err(_) => Ok(' '),
            Ok(c) => Ok(char::from_u32(c).unwrap_or(' ')),
        }
    }

    /// One row of the active area as text, with trailing spaces removed.
    pub fn row(&self, y: u16) -> Result<String, libghostty_vt::Error> {
        let cols = self.inner.cols()?;
        let mut text = String::with_capacity(usize::from(cols));
        for x in 0..cols {
            text.push(self.cell(x, y)?);
        }
        while text.ends_with(' ') {
            text.pop();
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_resize_is_clamped_and_not_refused() {
        // The resize frame carries two `u16` values, so a client can ask for
        // 65535 by 65535. That grid took 3.9 GB against the real binary and
        // its dump never completed. The clamp is what makes the frame cheap.
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.resize(u16::MAX, u16::MAX).unwrap();

        // The screen still works, and it works at the clamped size.
        term.write(b"hello");
        assert_eq!(term.cell(0, 0).unwrap(), 'h');

        let dump = term.dump().unwrap();
        assert!(
            dump.len() < 4 * 1024 * 1024,
            "a clamped screen must give a small dump, and this one is {} bytes",
            dump.len()
        );

        // A zero on either side still gives a terminal of at least one cell.
        term.resize(0, 0).unwrap();
        term.write(b"x");
        assert_eq!(term.cell(0, 0).unwrap(), 'x');
    }

    #[test]
    fn plain_text_lands_on_the_first_row() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.write(b"hello");

        assert_eq!(term.row(0).unwrap(), "hello");
        assert_eq!(term.cell(0, 0).unwrap(), 'h');
        assert_eq!(term.cell(4, 0).unwrap(), 'o');
        // The cursor sits after the last character, on the same row.
        assert_eq!(term.cursor().unwrap(), (5, 0));
    }

    #[test]
    fn a_newline_moves_the_cursor_down() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.write(b"first\r\nsecond\r\n");

        assert_eq!(term.row(0).unwrap(), "first");
        assert_eq!(term.row(1).unwrap(), "second");
        assert_eq!(term.cursor().unwrap(), (0, 2));
    }

    #[test]
    fn cursor_position_sequences_move_the_cursor() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        // CSI 5 ; 10 H is row 5, column 10, both one-based.
        term.write(b"\x1b[5;10HX");

        assert_eq!(term.cursor().unwrap(), (10, 4));
        assert_eq!(term.cell(9, 4).unwrap(), 'X');
        assert_eq!(term.cell(8, 4).unwrap(), ' ');
    }

    #[test]
    fn erase_in_display_clears_the_screen() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.write(b"keep me\r\n");
        term.write(b"\x1b[H\x1b[2J");

        assert_eq!(term.row(0).unwrap(), "");
        assert_eq!(term.cursor().unwrap(), (0, 0));
    }

    #[test]
    fn text_wraps_at_the_last_column() {
        let mut term = ScreenTerminal::new(10, 4).unwrap();
        term.write(b"0123456789abc");

        assert_eq!(term.row(0).unwrap(), "0123456789");
        assert_eq!(term.row(1).unwrap(), "abc");
    }

    #[test]
    fn a_style_does_not_change_the_cell_text() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        // CSI 1 ; 32 m is bold green. CSI 0 m resets.
        term.write(b"\x1b[1;32mgreen\x1b[0m");

        assert_eq!(term.row(0).unwrap(), "green");
    }

    #[test]
    fn resize_changes_the_reported_size() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.resize(120, 40).unwrap();

        assert_eq!(term.size().unwrap(), (120, 40));
    }

    #[test]
    fn a_zero_size_becomes_one() {
        // A browser can report a zero size while its window is hidden.
        // libghostty-vt rejects zero, so the size floor is one.
        let mut term = ScreenTerminal::new(0, 0).unwrap();
        assert_eq!(term.size().unwrap(), (1, 1));
        term.resize(0, 0).unwrap();
        assert_eq!(term.size().unwrap(), (1, 1));
    }

    #[test]
    fn a_primary_dump_starts_with_a_leave_and_a_clear() {
        let term = ScreenTerminal::new(80, 24).unwrap();
        let dump = term.dump().unwrap();

        assert!(
            dump.starts_with(LEAVE_ALTERNATE),
            "a dump of the primary screen must leave the alternate screen first"
        );
    }

    #[test]
    fn an_alternate_dump_starts_with_an_enter_and_a_clear() {
        let mut term = ScreenTerminal::new(80, 24).unwrap();
        term.write(b"\x1b[?1049h");
        let dump = term.dump().unwrap();

        assert!(
            dump.starts_with(ENTER_ALTERNATE),
            "a dump of the alternate screen must enter it before it clears"
        );
    }

    #[test]
    fn a_dump_replays_into_an_equal_screen() {
        // This is the property that the 0x01 frame depends on. Feed a screen,
        // dump it, then apply the dump to a second terminal. The two screens
        // must agree on the text and on the cursor.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[1;31mred line\x1b[0m\r\n");
        source.write(b"second line\r\n");
        source.write(b"\x1b[4;20Hfar right");
        let dump = source.dump().unwrap();

        let mut replica = ScreenTerminal::new(40, 8).unwrap();
        replica.write(&dump);

        for y in 0..8 {
            assert_eq!(
                replica.row(y).unwrap(),
                source.row(y).unwrap(),
                "row {y} differs"
            );
        }
        assert_eq!(replica.cursor().unwrap(), source.cursor().unwrap());
    }

    #[test]
    fn a_dump_removes_stale_content() {
        // The backpressure path applies a dump to a screen that already holds
        // old bytes. The clear prefix must remove them.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"new");
        let dump = source.dump().unwrap();

        let mut stale = ScreenTerminal::new(40, 8).unwrap();
        stale.write(b"old content that must go away\r\nand this row too\r\n");
        stale.write(&dump);

        assert_eq!(stale.row(0).unwrap(), "new");
        assert_eq!(stale.row(1).unwrap(), "");
    }

    // --- The alternate screen --- //
    //
    // tmux, vim, and less all hold the alternate screen. The user runs tmux to
    // share a session, so this screen is the main path and not an edge case.

    /// Assert that two terminals hold the same screen, text, and cursor.
    fn assert_same_screen(replica: &ScreenTerminal, source: &ScreenTerminal, rows: u16) {
        assert_eq!(
            replica.on_alternate_screen().unwrap(),
            source.on_alternate_screen().unwrap(),
            "the two terminals are on different screens"
        );
        for y in 0..rows {
            assert_eq!(
                replica.row(y).unwrap(),
                source.row(y).unwrap(),
                "row {y} differs"
            );
        }
        assert_eq!(
            replica.cursor().unwrap(),
            source.cursor().unwrap(),
            "the cursor differs"
        );
    }

    /// A client that already holds the alternate screen, with shell history on
    /// the primary screen behind it. This is a user inside vim.
    fn client_inside_vim() -> ScreenTerminal {
        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(b"shell history\r\nmore history\r\n");
        client.write(b"\x1b[?1049h\x1b[2J\x1b[Hold vim line\r\nold vim two");
        client
    }

    #[test]
    fn an_alternate_screen_dump_replays_into_an_equal_screen() {
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"shell history\r\n");
        source.write(b"\x1b[?1049h\x1b[2J\x1b[H");
        source.write(b"\x1b[1;32mVIM STATUS\x1b[0m\r\n");
        source.write(b"line of text\r\n");
        source.write(b"\x1b[5;12Hcursor here");
        assert!(source.on_alternate_screen().unwrap());
        let dump = source.dump().unwrap();

        let mut replica = ScreenTerminal::new(40, 8).unwrap();
        replica.write(&dump);

        assert!(
            replica.on_alternate_screen().unwrap(),
            "the dump must put the client on the alternate screen"
        );
        assert_same_screen(&replica, &source, 8);
        assert_eq!(replica.row(0).unwrap(), "VIM STATUS");
        assert_eq!(replica.cursor().unwrap(), (22, 4));
    }

    #[test]
    fn leaving_the_alternate_screen_brings_the_primary_screen_back() {
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"primary one\r\nprimary two\r\n");
        source.write(b"\x1b[?1049h\x1b[2J\x1b[HALTERNATE ONLY TEXT");
        source.write(b"\x1b[?1049l");
        assert!(!source.on_alternate_screen().unwrap());
        let dump = source.dump().unwrap();

        let mut replica = ScreenTerminal::new(40, 8).unwrap();
        replica.write(&dump);

        assert_same_screen(&replica, &source, 8);
        assert_eq!(replica.row(0).unwrap(), "primary one");
        assert_eq!(replica.row(1).unwrap(), "primary two");
        // A dump taken after the switch must not bring the alternate content
        // back to life.
        for y in 0..8 {
            assert!(
                !replica.row(y).unwrap().contains("ALTERNATE ONLY TEXT"),
                "the dump resurrected alternate screen content on row {y}"
            );
        }
    }

    #[test]
    fn a_primary_dump_pulls_a_client_out_of_the_alternate_screen() {
        // This is fault 2. Before the workaround, the client stayed inside vim
        // and took the shell screen onto the alternate screen.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"back at the shell\r\n$ ");
        assert!(!source.on_alternate_screen().unwrap());
        let dump = source.dump().unwrap();

        let mut client = client_inside_vim();
        assert!(client.on_alternate_screen().unwrap());
        client.write(&dump);

        assert!(
            !client.on_alternate_screen().unwrap(),
            "the dump left the client inside the alternate screen"
        );
        assert_same_screen(&client, &source, 8);
        assert_eq!(client.row(0).unwrap(), "back at the shell");
    }

    #[test]
    fn a_resync_inside_the_alternate_screen_stays_inside_it() {
        // The real backpressure case. A user inside vim falls behind, so the
        // server drops the backlog and sends one dump. The user must land back
        // inside vim, on the current screen, and never in a mixed state.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"shell history\r\nmore history\r\n");
        source.write(b"\x1b[?1049h\x1b[2J\x1b[H");
        source.write(b"NEW VIM LINE\r\nNEW VIM TWO\r\n");
        source.write(b"\x1b[8;1H-- INSERT --");
        let dump = source.dump().unwrap();

        let mut client = client_inside_vim();
        client.write(&dump);

        assert!(client.on_alternate_screen().unwrap());
        assert_same_screen(&client, &source, 8);
        assert_eq!(client.row(0).unwrap(), "NEW VIM LINE");
        assert_eq!(client.row(7).unwrap(), "-- INSERT --");
        // No row holds a mix of the old screen and the new screen.
        for y in 0..8 {
            assert!(
                !client.row(y).unwrap().contains("old vim"),
                "row {y} still holds the old alternate screen"
            );
        }
    }

    #[test]
    fn an_alternate_dump_does_not_damage_the_primary_screen() {
        // The dump carries the active screen only. Therefore it must leave the
        // other screen alone. A clear before the screen switch would erase the
        // shell history that the user sees again after vim ends.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hvim is running");
        let dump = source.dump().unwrap();

        let mut client = client_inside_vim();
        client.write(&dump);
        assert_eq!(client.row(0).unwrap(), "vim is running");

        // vim ends. The shell history behind it must still be there.
        client.write(b"\x1b[?1049l");
        assert!(!client.on_alternate_screen().unwrap());
        assert_eq!(client.row(0).unwrap(), "shell history");
        assert_eq!(client.row(1).unwrap(), "more history");
    }

    #[test]
    fn an_alternate_dump_does_not_damage_a_client_on_the_primary_screen() {
        // The same rule for a client that is not in the alternate screen yet.
        // It gets the dump, enters the alternate screen, and its own primary
        // screen must survive.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hvim is running");
        let dump = source.dump().unwrap();

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(b"client history\r\nsecond row\r\n");
        assert!(!client.on_alternate_screen().unwrap());
        client.write(&dump);

        assert!(client.on_alternate_screen().unwrap());
        assert_eq!(client.row(0).unwrap(), "vim is running");

        client.write(b"\x1b[?1049l");
        assert_eq!(client.row(0).unwrap(), "client history");
        assert_eq!(client.row(1).unwrap(), "second row");
    }

    #[test]
    fn two_dumps_in_a_row_inside_the_alternate_screen_agree() {
        // A client can fall behind twice. The second dump must give the same
        // screen as the first one, and not add to it.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hfirst\r\nsecond");
        let dump = source.dump().unwrap();

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(&dump);
        client.write(&dump);

        assert_same_screen(&client, &source, 8);
        assert_eq!(client.row(0).unwrap(), "first");
        assert_eq!(client.row(1).unwrap(), "second");
    }

    #[test]
    fn the_alternate_screen_survives_a_resize() {
        // tmux resizes its panes on every window change. A resize inside the
        // alternate screen must not throw the client back to the shell.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hinside vim");
        source.resize(60, 12).unwrap();
        assert!(source.on_alternate_screen().unwrap());

        let dump = source.dump().unwrap();
        let mut replica = ScreenTerminal::new(60, 12).unwrap();
        replica.write(&dump);

        assert!(replica.on_alternate_screen().unwrap());
        assert_eq!(replica.row(0).unwrap(), "inside vim");
        assert_eq!(replica.size().unwrap(), (60, 12));
    }

    // --- The screen behind the alternate screen --- //

    /// Rows of the active area that hold text.
    fn rows_of_text(term: &ScreenTerminal) -> usize {
        let (_, rows) = term.size().unwrap();
        (0..rows)
            .filter(|y| !term.row(*y).unwrap().is_empty())
            .count()
    }

    /// A terminal with `lines` rows of primary content, inside a program that
    /// holds the alternate screen.
    fn source_inside_a_program(cols: u16, rows: u16, lines: u16) -> ScreenTerminal {
        let mut source = ScreenTerminal::new(cols, rows).unwrap();
        for line in 0..lines {
            source.write(format!("primary line {line}\r\n").as_bytes());
        }
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hstatus one\r\nstatus two");
        assert!(source.on_alternate_screen().unwrap());
        source
    }

    #[test]
    fn a_client_that_joins_inside_the_alternate_screen_gets_the_whole_screen() {
        // The web suite reports "rows of text after the exit of a joined
        // client". That count was 2 before the capture: the client had the
        // alternate screen, and an empty primary screen behind it.
        let mut source = source_inside_a_program(80, 40, 38);

        let mut client = ScreenTerminal::new(80, 40).unwrap();
        client.write(&source.dump().unwrap());

        // The program ends on both terminals.
        source.write(b"\x1b[?1049l");
        client.write(b"\x1b[?1049l");

        assert_eq!(rows_of_text(&source), 38);
        assert_eq!(
            rows_of_text(&client),
            rows_of_text(&source),
            "the joined client lost the primary screen behind the program"
        );
    }

    #[test]
    fn a_joined_client_gets_the_primary_screen_that_stood_behind_the_program() {
        let mut source = source_inside_a_program(40, 8, 5);

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(&source.dump().unwrap());
        // The dump lands the client inside the program first.
        assert!(client.on_alternate_screen().unwrap());
        assert_same_screen(&client, &source, 8);

        source.write(b"\x1b[?1049l");
        client.write(b"\x1b[?1049l");

        assert!(!client.on_alternate_screen().unwrap());
        assert_same_screen(&client, &source, 8);
        assert_eq!(client.row(0).unwrap(), "primary line 0");
        assert_eq!(client.row(4).unwrap(), "primary line 4");
    }

    #[test]
    fn a_resize_inside_the_alternate_screen_keeps_the_primary_capture() {
        // tmux resizes its panes on every window change. The capture holds the
        // size of the screen at the switch, so this test keeps every primary
        // line shorter than both widths.
        let mut source = source_inside_a_program(40, 8, 5);
        source.resize(60, 12).unwrap();
        assert!(source.on_alternate_screen().unwrap());

        let mut client = ScreenTerminal::new(60, 12).unwrap();
        client.write(&source.dump().unwrap());

        source.write(b"\x1b[?1049l");
        client.write(b"\x1b[?1049l");

        assert_eq!(rows_of_text(&client), 5);
        for y in 0..12 {
            assert_eq!(
                client.row(y).unwrap(),
                source.row(y).unwrap(),
                "row {y} differs after the resize"
            );
        }
    }

    #[test]
    fn a_switch_that_two_chunks_cut_apart_still_captures_the_primary_screen() {
        // The PTY gives the server 8192 bytes at a time, so a sequence can
        // straddle two reads.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"primary one\r\nprimary two\r\n");
        source.write(b"\x1b[?10");
        source.write(b"49h\x1b[2J\x1b[Hinside the program");
        assert!(source.on_alternate_screen().unwrap());

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(&source.dump().unwrap());
        client.write(b"\x1b[?1049l");

        assert_eq!(client.row(0).unwrap(), "primary one");
        assert_eq!(client.row(1).unwrap(), "primary two");
    }

    #[test]
    fn the_capture_goes_away_when_the_program_ends() {
        // A dump taken after the program ends carries the primary screen once,
        // and the terminal holds no capture behind it.
        let mut source = source_inside_a_program(40, 8, 3);
        source.write(b"\x1b[?1049l");
        assert!(source.primary.is_none());

        let dump = source.dump().unwrap();
        assert!(dump.starts_with(LEAVE_ALTERNATE));
    }

    #[test]
    fn a_program_over_an_empty_primary_screen_stores_no_capture() {
        // The capture would clear the primary screen of a client that holds
        // its own shell history. See `capture_primary`.
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"\x1b[?1049h\x1b[2J\x1b[Hvim is running");

        assert!(source.primary.is_none());
        assert!(source.dump().unwrap().starts_with(ENTER_ALTERNATE));
    }

    /// The index of the switch inside one chunk, from a new scanner.
    fn switch_at(bytes: &[u8]) -> Option<usize> {
        ScreenScanner::new().next_switch(bytes)
    }

    #[test]
    fn the_scanner_finds_the_sequences_that_switch_the_screen() {
        // A mode that is not a screen mode must not cost a capture.
        assert!(switch_at(b"plain text").is_none());
        assert!(switch_at(b"\x1b[?25l").is_none());
        assert!(switch_at(b"\x1b[?1049l").is_none());
        assert!(switch_at(b"\x1b[?104h").is_none());

        // The index is the index of the final byte of the sequence.
        assert_eq!(switch_at(b"ab\x1b[?1049h"), Some(9));
        assert_eq!(switch_at(b"\x1b[?25l\x1b[?47h"), Some(11));
        assert_eq!(switch_at(b"\x1b[?25;1049h"), Some(10));
        assert_eq!(switch_at(b"\x1b[?1047h"), Some(7));

        // A sequence that the chunk cuts short holds the scanner.
        assert!(switch_at(b"\x1b[?10").is_none());

        // A restore of a saved mode enters the alternate screen also.
        assert_eq!(switch_at(b"\x1b[?1049r"), Some(7));
    }

    #[test]
    fn a_parameter_that_only_contains_a_screen_mode_does_not_switch() {
        // 10490 and 447 hold the digits of 1049 and 47. Neither is a screen
        // mode, and a scanner that compares a substring switches on both.
        assert!(switch_at(b"\x1b[?10490h").is_none());
        assert!(switch_at(b"\x1b[?447h").is_none());
        assert!(switch_at(b"\x1b[?4700h").is_none());
        assert!(switch_at(b"\x1b[?110471h").is_none());
        assert!(switch_at(b"\x1b[?1;10490;2h").is_none());
    }

    #[test]
    fn a_sequence_that_reports_or_saves_a_mode_does_not_switch() {
        // `CSI ? Pm $ p` asks for the value of a mode. `CSI ? Pm s` saves it.
        // Neither one moves the terminal to the alternate screen.
        assert!(switch_at(b"\x1b[?1049$p").is_none());
        assert!(switch_at(b"\x1b[?1049s").is_none());
        assert!(switch_at(b"\x1b[?47$p").is_none());
    }

    #[test]
    fn the_digits_of_a_screen_mode_inside_a_string_do_not_switch() {
        // A payload of an OSC or an APC string is data. A CSI parameter of a
        // sequence that is not private is data also.
        let mut term = ScreenTerminal::new(40, 8).unwrap();
        term.write(b"\x1b]0;1049h\x07\x1b_G1049h\x1b\\\x1b[1049;47htext");
        assert!(!term.on_alternate_screen().unwrap());
        assert!(term.primary.is_none());
    }

    /// True when the primary screen reaches a client that joins after the
    /// chunks arrive.
    fn primary_reaches_a_client(chunks: &[&[u8]]) -> bool {
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"primary one\r\nprimary two\r\n");
        for chunk in chunks {
            source.write(chunk);
        }
        source.write(b"\x1b[2J\x1b[Hinside the program");
        assert!(
            source.on_alternate_screen().unwrap(),
            "not on the alternate"
        );

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(&source.dump().unwrap());
        client.write(b"\x1b[?1049l");
        client.row(0).unwrap() == "primary one" && client.row(1).unwrap() == "primary two"
    }

    #[test]
    fn a_switch_that_any_split_cuts_apart_still_captures_the_primary_screen() {
        // The PTY cuts a chunk at any byte, and a split before the `[` leaves
        // no `ESC [ ?` in either chunk.
        let sequence: &[u8] = b"\x1b[?1049h";
        for i in 0..=sequence.len() {
            let (head, tail) = sequence.split_at(i);
            assert!(primary_reaches_a_client(&[head, tail]), "split at {i}");
        }
        for i in 0..=sequence.len() {
            for j in i..=sequence.len() {
                let (head, rest) = sequence.split_at(i);
                let (middle, tail) = rest.split_at(j - i);
                assert!(
                    primary_reaches_a_client(&[head, middle, tail]),
                    "split at {i} and {j}"
                );
            }
        }
        let single: Vec<&[u8]> = sequence.chunks(1).collect();
        assert!(primary_reaches_a_client(&single), "one byte at a time");
    }

    #[test]
    fn an_enter_inside_the_alternate_screen_keeps_the_capture() {
        // vim sets 1049 again after a suspend, and tmux sets 47 and 1047 too.
        let mut source = source_inside_a_program(40, 8, 3);
        source.write(b"\x1b[?1049h");
        assert!(
            source.primary.is_some(),
            "the second enter lost the capture"
        );
        source.write(b"\x1b[?47h\x1b[?1047h");
        assert!(source.primary.is_some(), "47 or 1047 lost the capture");

        let mut client = ScreenTerminal::new(40, 8).unwrap();
        client.write(&source.dump().unwrap());
        client.write(b"\x1b[?1049l");
        assert_eq!(client.row(0).unwrap(), "primary line 0");
    }

    #[test]
    fn a_leave_on_the_primary_screen_keeps_the_screen() {
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        source.write(b"shell history\r\n");
        source.write(b"\x1b[?1049l\x1b[?1049l");
        assert!(source.primary.is_none());
        assert_eq!(source.row(0).unwrap(), "shell history");
    }

    #[test]
    fn a_long_parameter_run_neither_panics_nor_switches() {
        let mut source = ScreenTerminal::new(40, 8).unwrap();
        let mut sequence = b"\x1b[?".to_vec();
        sequence.extend(std::iter::repeat_n(b'9', 100_000));
        sequence.extend_from_slice(b"h");
        source.write(&sequence);
        assert!(!source.on_alternate_screen().unwrap());

        // The run ends with a real screen mode, which switches.
        let mut sequence = b"\x1b[?".to_vec();
        sequence.extend(std::iter::repeat_n(b'9', 100_000));
        sequence.extend_from_slice(b";1049h");
        source.write(&sequence);
        assert!(source.on_alternate_screen().unwrap());
    }

    #[test]
    fn many_switches_leave_one_capture_at_most() {
        // A program that enters and leaves the alternate screen must not make
        // the terminal hold more than the one capture behind it. A measurement
        // over 10000 cycles gave a flat cost per cycle and a capture of 5632
        // bytes throughout. The loop below is short, because each capture is a
        // full dump and the debug build takes about 20 ms for one cycle.
        let mut source = ScreenTerminal::new(80, 24).unwrap();
        source.write(b"shell history\r\n");
        for _ in 0..200 {
            source.write(b"\x1b[?1049h\x1b[2J\x1b[Hthe program");
            source.write(b"\x1b[?1049l");
        }
        assert!(source.primary.is_none());
        assert_eq!(source.row(0).unwrap(), "shell history");

        source.write(b"\x1b[?1049h");
        let capture = source.primary.as_ref().expect("no capture").len();
        assert!(capture < 1 << 20, "the capture grew to {capture} bytes");
    }
}
