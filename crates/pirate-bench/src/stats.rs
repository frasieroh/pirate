//! Order statistics over a list of durations.
//!
//! A latency number needs its spread. A median alone hides the run that a
//! scheduler delayed, so every report of this crate prints a quantile beside
//! the median.

use std::time::Duration;

/// The median. An even count gives the upper of the two middle values.
///
/// # Panics
///
/// Panics on an empty list.
#[must_use]
pub fn median(values: &[Duration]) -> Duration {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

/// The value at quantile `q`, where `q` is between 0.0 and 1.0.
///
/// # Panics
///
/// Panics on an empty list.
#[must_use]
pub fn quantile(values: &[Duration], q: f64) -> Duration {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    let index = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[index]
}

/// The total of a list of durations.
#[must_use]
pub fn total(values: &[Duration]) -> Duration {
    values.iter().sum()
}

/// One duration in milliseconds, with three decimals.
#[must_use]
pub fn ms3(value: Duration) -> String {
    #[allow(clippy::cast_precision_loss)]
    let ms = value.as_micros() as f64 / 1000.0;
    format!("{ms:.3} ms")
}

/// One duration in milliseconds, with two decimals.
#[must_use]
pub fn ms2(value: Duration) -> String {
    #[allow(clippy::cast_precision_loss)]
    let ms = value.as_micros() as f64 / 1000.0;
    format!("{ms:.2} ms")
}

#[cfg(test)]
mod tests {
    use super::{median, ms2, ms3, quantile, total};
    use std::time::Duration;

    fn micros(values: &[u64]) -> Vec<Duration> {
        values.iter().map(|v| Duration::from_micros(*v)).collect()
    }

    #[test]
    fn the_median_takes_the_middle_of_an_odd_count() {
        assert_eq!(
            median(&micros(&[5, 1, 3])),
            Duration::from_micros(3),
            "an unsorted list of three gives the middle value"
        );
    }

    #[test]
    fn the_median_takes_the_upper_middle_of_an_even_count() {
        assert_eq!(median(&micros(&[1, 2, 3, 4])), Duration::from_micros(3));
    }

    #[test]
    fn the_quantile_takes_the_ends() {
        let values = micros(&[1, 2, 3, 4, 5]);
        assert_eq!(quantile(&values, 0.0), Duration::from_micros(1));
        assert_eq!(quantile(&values, 0.5), Duration::from_micros(3));
        assert_eq!(quantile(&values, 1.0), Duration::from_micros(5));
    }

    #[test]
    fn the_quantile_rounds_to_the_nearest_index() {
        // Nine samples put p95 at index 8, which is the largest value.
        let values = micros(&[1, 2, 3, 4, 5, 6, 7, 8, 90]);
        assert_eq!(quantile(&values, 0.95), Duration::from_micros(90));
    }

    #[test]
    fn the_total_adds_every_value() {
        assert_eq!(total(&micros(&[1, 2, 3])), Duration::from_micros(6));
    }

    #[test]
    fn the_formatters_give_milliseconds() {
        assert_eq!(ms3(Duration::from_micros(1234)), "1.234 ms");
        assert_eq!(ms2(Duration::from_micros(1236)), "1.24 ms");
    }
}
