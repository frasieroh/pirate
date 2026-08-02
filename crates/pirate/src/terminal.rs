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

/// The authoritative screen state of one session.
pub struct ScreenTerminal {
    inner: Terminal<'static, 'static>,
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
        Ok(Self { inner })
    }

    /// Feed PTY output into the parser.
    ///
    /// This never fails. libghostty-vt treats the input as untrusted and logs
    /// a malformed sequence instead of stopping.
    pub fn write(&mut self, bytes: &[u8]) {
        self.inner.vt_write(bytes);
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
    /// # Limit
    ///
    /// The formatter carries the active screen only. A dump of the alternate
    /// screen therefore does not carry the primary screen behind it. This is
    /// correct for pirate: a client of this session already had those bytes
    /// before it fell behind, and the sequences above leave that screen alone.
    /// A client that connects while a program holds the alternate screen gets
    /// an empty primary screen, and it sees that screen when the program ends.
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
        let prefix = if self.on_alternate_screen()? {
            ENTER_ALTERNATE
        } else {
            LEAVE_ALTERNATE
        };

        // CUP is one-based, and the terminal reports a zero-based position.
        let (x, y) = self.cursor()?;
        let cursor = format!("\x1b[{};{}H", u32::from(y) + 1, u32::from(x) + 1);

        let mut out = Vec::with_capacity(prefix.len() + bytes.len() + cursor.len());
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
}
