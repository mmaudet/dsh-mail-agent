#!/usr/bin/env bash
#
# Report what a running DSH session is doing, from its persisted log.
#
# The web UI shows this live; this exists so it can be read from a terminal,
# by whoever is not sitting in front of the browser.
#
#   bash scripts/watch-session.sh [workspace-dir]
#
# Defaults to the most recently written session of any workspace.
set -uo pipefail

WORKSPACE="${1:-}"
ROOT="$HOME/.dsh/sessions"

if [ -n "$WORKSPACE" ]; then
  key="--$(echo "$WORKSPACE" | sed 's#^/##; s#/#-#g')--"
  log=$(ls -t "$ROOT/$key"/*/session.jsonl.zstd 2>/dev/null | head -1)
else
  log=$(ls -t "$ROOT"/*/*/session.jsonl.zstd 2>/dev/null | head -1)
fi

if [ -z "${log:-}" ] || [ ! -f "$log" ]; then
  echo "no session log found under $ROOT"
  exit 1
fi

echo "session: $(basename "$(dirname "$log")")"
echo "updated: $(date -r "$log" '+%H:%M:%S')"
echo

zstd -dc "$log" 2>/dev/null | python3 -c '
import json, sys
from collections import Counter

# Every event nests its payload under "data"; the envelope carries type/seq/time.
steps = 0
tools = []
errors = []
last_text = ""
tok_in = tok_out = 0

for line in sys.stdin:
    try:
        e = json.loads(line)
    except Exception:
        continue
    t = e.get("type")
    d = e.get("data") or {}

    if t == "step/start":
        steps += 1
    elif t == "tool/call":
        tools.append(d.get("name") or "?")
    elif t == "tool/result":
        if d.get("isError"):
            blocks = d.get("content") or []
            text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
            errors.append((d.get("name") or "?", text[:110] or "(error)"))
    elif t == "assistant/message":
        for b in d.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                last_text = b["text"]
    elif t == "step/end":
        u = d.get("usage") or {}
        tok_in += u.get("inputTokens") or 0
        tok_out += u.get("outputTokens") or 0

print("steps        : %d" % steps)
print("tool calls   : %d" % len(tools))
if tools:
    print("               " + ", ".join("%s x%d" % (n, c) for n, c in Counter(tools).most_common(8)))
print("tokens       : in %d  out %d" % (tok_in, tok_out))

if errors:
    print("\nfailed tool calls (%d):" % len(errors))
    for name, msg in errors[-5:]:
        print("  - %s: %s" % (name, msg))

if last_text:
    print("\nlast assistant text:")
    for line in last_text.strip().splitlines()[-8:]:
        print("  " + line[:100])
'
