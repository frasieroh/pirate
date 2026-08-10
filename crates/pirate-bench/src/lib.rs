//! The parts that more than one benchmark binary of this crate needs.
//!
//! Nothing here ships in the pirate binary. The binaries in `src/bin` hold the
//! measurements themselves, and this library holds the server harness and the
//! order statistics that both of them use.

pub mod harness;
pub mod stats;
