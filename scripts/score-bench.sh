#!/usr/bin/env bash
#
# Score a benchmark run from outside the run's reach.
#
#   bash scripts/score-bench.sh ab-deepseek [ab-deepseek-acp]
#
# Exists because the judge lives inside the workspace the subject can write to.
# One run edited it — correctly, and it said so — but the criterion stopped
# being independent at that moment, and nothing but the reviewer's attention
# caught it. Three steps were being done by hand, and one was once forgotten:
#
#   1. has the bench's copy of the judge been edited?
#   2. the verdict must come from a copy the subject cannot reach
#   3. is the work its own, or a copy of the reference implementation?
set -uo pipefail

BENCH="${1:?usage: score-bench.sh <bench-dir> [profile]}"
PROFILE="${2:-${BENCH}-acp}"

BENCH_DIR="${BENCH_DIR:-$HOME/work/$BENCH}"
REF_DIR="${REF_DIR:-$HOME/work/dsh-mail-agent}"
JUDGE="$REF_DIR/scripts/verify-mail-core-bundle.sh"
REF_PLUGIN="$REF_DIR/packages/dsh-mail-core/src/plugin.ts"

for f in "$JUDGE" "$REF_PLUGIN"; do
  [ -f "$f" ] || { echo "missing: $f"; exit 2; }
done
[ -d "$BENCH_DIR" ] || { echo "missing bench: $BENCH_DIR"; exit 2; }

rule() { printf '\n%s\n' "── $1 ──────────────────────────────────────────"; }

# The two default rows are meant to differ per bench; nothing else is.
normalise() { sed -E 's#^(REPO|PROFILE)="\$\{(REPO|PROFILE):-[^}]*\}"$#\1=<per-bench>#' "$1"; }

# ---------------------------------------------------------------------------
rule "1. was the judge tampered with?"
subject_copy="$BENCH_DIR/scripts/verify-mail-core-bundle.sh"
tampered=0
if [ ! -f "$subject_copy" ]; then
  echo "the bench has no copy of the judge (fine: it cannot have edited it)"
elif diff -q <(normalise "$JUDGE") <(normalise "$subject_copy") >/dev/null; then
  echo "unchanged from canonical"
else
  tampered=1
  echo "EDITED by the run — the diff is the finding, read it before the verdict:"
  diff <(normalise "$JUDGE") <(normalise "$subject_copy") | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
rule "2. verdict, from the canonical judge"
REPO="$BENCH_DIR" PROFILE="$PROFILE" bash "$JUDGE"
verdict=$?

# ---------------------------------------------------------------------------
rule "3. is it the run's own work?"
bench_plugin="$BENCH_DIR/packages/dsh-mail-core/src/plugin.ts"
leaked=0
if [ ! -f "$bench_plugin" ]; then
  echo "no plugin.ts — nothing to compare"
else
  differing=$(diff "$bench_plugin" "$REF_PLUGIN" | grep -c '^[<>]')
  echo "differing lines vs reference: $differing  ($(wc -l < "$bench_plugin") vs $(wc -l < "$REF_PLUGIN") lines)"
  # A threshold, not a proof. Ten lines apart on a file this size means the
  # run had the answer open, whatever route it took to get there.
  if [ "$differing" -lt 10 ]; then
    leaked=1
    echo "LEAK — too close to the reference to be independent work"
  else
    echo "independent enough to score"
  fi
fi

# ---------------------------------------------------------------------------
rule "summary"
[ "$tampered" -eq 1 ] && echo "  judge   : EDITED — verdict below is from the canonical copy"
[ "$leaked"   -eq 1 ] && echo "  origin  : LEAKED — run is void whatever the checks say"
[ "$verdict"  -eq 0 ] && echo "  checks  : PASS" || echo "  checks  : FAIL"

if [ "$leaked" -eq 1 ]; then
  echo "  VOID"
  exit 2
fi
exit "$verdict"
