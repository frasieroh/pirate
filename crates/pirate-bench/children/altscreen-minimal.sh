#!/bin/sh
# The control child of the whole-path benchmark.
#
# This script does the same screen work as the two children beside it and it
# starts no other program. It enters the alternate screen, draws it, waits for
# one key, and leaves the alternate screen at once. Its think time is close to
# zero, so the measured total is the cost of pirate alone.
#
# One round of the loop does four steps:
#   1. Print enough lines to fill the primary screen.
#   2. Enter the alternate screen and draw it.
#   3. One key leaves the alternate screen. This is symptom 2.
#   4. Print a prompt line, then wait for one line of input.
#
# The mark `file 0001` tells the benchmark that the alternate screen is drawn.
# The two children beside this one draw the same mark, from a file.

LINES_OF_PRIMARY=400
# The alternate screen holds no scrollback. A count above the row count of the
# window scrolls the mark `file 0001` off the screen, and the benchmark then
# waits for a line that is gone.
LINES_OF_ALTERNATE=30

while :; do
  i=1
  while [ "$i" -le "$LINES_OF_PRIMARY" ]; do
    printf 'primary %04d the quick brown fox jumps over the lazy dog 0123456789\n' "$i"
    i=$((i + 1))
  done
  printf 'PRIMARY-READY\n'

  # Enter the alternate screen, then draw it.
  printf '\033[?1049h\033[H\033[2J'
  i=1
  while [ "$i" -le "$LINES_OF_ALTERNATE" ]; do
    printf 'file %04d the quick brown fox jumps over the lazy dog 0123456789\r\n' "$i"
    i=$((i + 1))
  done

  # Take one key with no line discipline, as a full-screen program does.
  saved=$(stty -g)
  stty raw -echo
  dd bs=1 count=1 >/dev/null 2>&1
  stty "$saved"

  # Leave the alternate screen. This is the sequence that symptom 2 names.
  printf '\033[?1049l'
  printf 'prompt$ EDITOR-GONE\n'
  read -r _ || exit 0
done
