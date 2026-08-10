#!/bin/sh
# The child of the whole-path benchmark, with a real editor.
#
# One round of the loop does four steps:
#   1. Print enough lines to fill the primary screen.
#   2. Start the editor. The editor draws on the alternate screen.
#   3. The key `q` quits the editor. This is symptom 2.
#   4. Print a prompt line, then wait for one line of input.
#
# Two programs start this script: `web/bench/whole-path.e2e.ts` and
# `crates/pirate-bench/src/bin/bench_child.rs`. The first one drives it through
# a real pirate server and a real browser. The second one drives it on a bare
# PTY, with no pirate in the path. The difference of the two numbers is the
# cost of pirate.
#
# PIRATE_BENCH_EDITOR names the editor. The default is `nvim`. The editor gets
# no user configuration, so the number holds for a plain editor. An editor with
# plugins is slower.
#
# The mark `file 0001` is the first line of the file. It tells the benchmark
# that the alternate screen is drawn.

EDITOR_BIN="${PIRATE_BENCH_EDITOR:-nvim}"
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
  # `-u NONE` and `-i NONE` keep the editor free of user configuration and of
  # state files. The map turns one key into the quit, so the benchmark presses
  # one key and not a command line.
  "$EDITOR_BIN" -u NONE -i NONE -n -c 'nnoremap q :qa!<CR>' "$BIG"
  # The line that a shell prints after the editor leaves the alternate screen.
  printf 'prompt$ EDITOR-GONE\n'
  # Wait for the benchmark to ask for the next round.
  read -r _ || exit 0
done
