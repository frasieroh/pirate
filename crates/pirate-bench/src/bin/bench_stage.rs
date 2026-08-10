//! Measure the resize of the server-side terminal, and the dump beside it.
//!
//! This program is the control of one candidate for symptom 1.
//! `web/bench/whole-path.e2e.ts` reports 63 ms between the resize frame of the
//! browser and the first frame back, against a wire floor of about 6 ms with no
//! think time. `Session::resize` writes the new size to the PTY first, and it
//! then sends `Command::Resize` to the terminal thread. That thread runs one
//! command at a time, so a slow `ScreenTerminal::resize` would hold the output
//! of the child behind it.
//!
//! The measurement below rejects that candidate. The resize of the server-side
//! terminal costs 0.15 ms at 2000 lines of history, and the dump costs 0.24 ms.
//! `web/bench/whole-path.e2e.ts` then found the 59 ms: one task of the browser
//! main thread, after the send of the resize frame.
//!
//! Run it:
//!
//! ```text
//! cargo run --release -p pirate-bench --bin bench_stage
//! ```
//!
//! No PTY and no socket runs here, so the numbers hold no scheduler noise.

use std::time::{Duration, Instant};

use pirate::terminal::ScreenTerminal;

/// The size that the whole-path benchmark starts at.
const WIDE_COLS: u16 = 109;
/// The second size of the resize storm.
const NARROW_COLS: u16 = 82;
/// The row count of both sizes.
const ROWS: u16 = 38;

/// Lines of history, as the children of `pirate-bench/children` print them.
const HISTORY: [usize; 4] = [0, 100, 400, 2000];

/// Measurements per row. The report gives the median and the 95th percentile.
const REPEATS: usize = 21;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("\n  the resize of the server-side terminal, and the dump beside it\n");
    println!(
        "{:<12} {:>8} {:>12} {:>12} {:>12} {:>12} {:>12}",
        "history", "repeats", "resize med", "resize p95", "dump med", "dump p95", "dump bytes"
    );

    for lines in HISTORY {
        let mut resizes = Vec::with_capacity(REPEATS);
        let mut dumps = Vec::with_capacity(REPEATS);
        let mut bytes = 0;
        let mut terminal = ScreenTerminal::new(WIDE_COLS, ROWS)?;
        for line in 0..lines {
            terminal.write(
                format!("primary {line:04} the quick brown fox jumps over the lazy dog\r\n")
                    .as_bytes(),
            );
        }
        for repeat in 0..REPEATS {
            let cols = if repeat % 2 == 0 {
                NARROW_COLS
            } else {
                WIDE_COLS
            };
            let start = Instant::now();
            terminal.resize(cols, ROWS)?;
            resizes.push(start.elapsed());

            let start = Instant::now();
            let dump = terminal.dump()?;
            dumps.push(start.elapsed());
            bytes = dump.len();
        }
        println!(
            "{:<12} {:>8} {:>12} {:>12} {:>12} {:>12} {:>12}",
            lines,
            REPEATS,
            ms(quantile(&resizes, 0.5)),
            ms(quantile(&resizes, 0.95)),
            ms(quantile(&dumps, 0.5)),
            ms(quantile(&dumps, 0.95)),
            bytes,
        );
    }
    println!();
    Ok(())
}

/// A duration as a string in milliseconds.
fn ms(value: Duration) -> String {
    format!("{:.2} ms", value.as_secs_f64() * 1000.0)
}

/// The value at `fraction` of a sorted copy of `values`.
fn quantile(values: &[Duration], fraction: f64) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let last = sorted.len() - 1;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(last)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantile_reads_the_ends_and_the_middle() {
        let values = [
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(30),
        ];
        assert_eq!(quantile(&values, 0.0), Duration::from_millis(10));
        assert_eq!(quantile(&values, 0.5), Duration::from_millis(20));
        assert_eq!(quantile(&values, 1.0), Duration::from_millis(30));
    }

    #[test]
    fn quantile_of_nothing_is_zero() {
        assert_eq!(quantile(&[], 0.5), Duration::ZERO);
    }

    /// A resize of the server-side terminal keeps the size that it was given.
    #[test]
    fn the_terminal_takes_the_new_size() {
        let mut terminal = ScreenTerminal::new(WIDE_COLS, ROWS).unwrap();
        terminal.resize(NARROW_COLS, ROWS).unwrap();
        assert_eq!(terminal.size().unwrap(), (NARROW_COLS, ROWS));
    }
}
