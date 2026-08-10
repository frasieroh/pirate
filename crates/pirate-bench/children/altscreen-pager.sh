#!/bin/sh
# The child of the whole-path benchmark, with a real pager.
#
# This child exists because of a measurement. `nvim` 0.12.4 on this machine
# writes nothing when the PTY changes size, so it cannot show symptom 1. `less`
# redraws on `SIGWINCH`, so the resize measurement uses this child and the exit
# measurement can use either one.
#
# One round of the loop does four steps:
#   1. Print enough lines to fill the primary screen.
#   2. Start the pager. The pager draws on the alternate screen.
#   3. The key `q` quits the pager. This is symptom 2.
#   4. Print a prompt line, then wait for one line of input.
#
# PIRATE_BENCH_PAGER names the pager. The default is `less`.
#
# The mark `file 0001` is the first line of the file. It tells the benchmark
# that the alternate screen is drawn.

PAGER_BIN="${PIRATE_BENCH_PAGER:-less}"
BIG="$HOME/pirate-bench-big.txt"
LINES_OF_PRIMARY=400
LINES_OF_FILE=2000

if [ ! -f "$BIG" ]; then
  i=1
  while [ "$i" -le "$LINES_OF_FILE" ]; do
    printf 'file %04d the quick brown fox jumps over the lazy dog 0123456789\n' "$i"
    i=$((i + 1))
  done >"$BIG"
fi

while :; do
  i=1
  while [ "$i" -le "$LINES_OF_PRIMARY" ]; do
    printf 'primary %04d the quick brown fox jumps over the lazy dog 0123456789\n' "$i"
    i=$((i + 1))
  done
  printf 'PRIMARY-READY\n'
  "$PAGER_BIN" "$BIG"
  # The line that a shell prints after the pager leaves the alternate screen.
  printf 'prompt$ EDITOR-GONE\n'
  # Wait for the benchmark to ask for the next round.
  read -r _ || exit 0
done
