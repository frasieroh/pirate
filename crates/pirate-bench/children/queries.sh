#!/bin/sh
# The child that asks the terminal questions.
#
# A full-screen program asks the terminal several questions and waits for the
# answers. `nvim` asks for the primary device attributes when it quits, and it
# leaves the alternate screen after the answer or after its own timeout. A
# terminal that answers nothing therefore holds the exit for that timeout.
#
# This child prints one question for each line that it reads. The benchmark
# then reads what the client sends back.
#
# `web/bench/whole-path.e2e.ts` drives it.
#
# Each pattern starts with `*`, and the reason is a measurement. An answer of
# the terminal arrives on the same input queue as the next name, and it carries
# no line feed. The line that `read` gives back is therefore the answer and the
# name joined: after the client answers DSR, the next line is `\033[0ncpr` and
# not `cpr`. A pattern without the `*` misses that line, the child prints no
# question, and the report then says `no answer` for a question that the client
# does answer.

while IFS= read -r name; do
  case "$name" in
    # Primary device attributes.
    *da1) printf '\033[c' ;;
    # Secondary device attributes.
    *da2) printf '\033[>c' ;;
    # Device status report.
    *dsr) printf '\033[5n' ;;
    # The position of the cursor.
    *cpr) printf '\033[6n' ;;
    # The flags of the kitty keyboard protocol.
    *kitty) printf '\033[?u' ;;
    # The background color.
    *bg) printf '\033]11;?\007' ;;
    # The state of the synchronized update mode.
    *sync) printf '\033[?2026$p' ;;
    *) ;;
  esac
done
