#!/usr/bin/env bash
#
# Acceptance check for the mail-core bundle task.
#
# Exists because prose acceptance criteria were satisfied with two greps that
# matched the agent's own writes. This is not a description of what to verify;
# it is the verification. It exits non-zero when the task is not done, and no
# amount of confident summary changes that.
#
# Run from anywhere:  bash scripts/verify-mail-core-bundle.sh
set -uo pipefail

REPO="${REPO:-$HOME/work/dsh-mail-agent}"
PROFILE="${PROFILE:-mail-agent-dev}"
PKG="$REPO/packages/dsh-mail-core"
fail=0

step() { printf '%-58s' "$1"; }
ok()   { printf 'OK\n'; }
ko()   { printf 'FAIL\n      %s\n' "$1"; fail=1; }

export PATH="$HOME/.npm-global/bin:$PATH"

# ---------------------------------------------------------------------------
step "1. the package compiles"
if (cd "$REPO" && pnpm run build >/dev/null 2>&1); then ok; else
  ko "pnpm run build failed; run it directly to see why"
fi

# ---------------------------------------------------------------------------
step "2. dsh.bundle.patch names a file that exists"
patch=$(python3 - "$PKG/package.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
b = (d.get("dsh") or {}).get("bundle")
print(b.get("patch") if isinstance(b, dict) else "")
PY
)
if [ -z "$patch" ]; then
  ko 'dsh.bundle must be an object: {"patch": "./cordis.patch.yml"}, not true'
elif [ ! -f "$PKG/${patch#./}" ]; then
  ko "dsh.bundle.patch points at $patch, which does not exist"
else ok; fi

# ---------------------------------------------------------------------------
step "3. the plugin entry is reachable as a package export"
entry=$(python3 - "$PKG/package.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
for name, spec in (d.get("exports") or {}).items():
    target = spec.get("default") if isinstance(spec, dict) else spec
    if isinstance(target, str) and target.endswith("plugin.js"):
        print(name); break
PY
)
if [ -z "$entry" ]; then
  ko "no export resolves to plugin.js; a row naming the package root gets index.js, which has no apply()"
elif [ ! -f "$PKG/dist/plugin.js" ]; then
  ko "dist/plugin.js is missing; build did not emit it"
else ok; fi

# ---------------------------------------------------------------------------
step "4. the bundle patch row points at that export"
if [ -n "$patch" ] && [ -f "$PKG/${patch#./}" ]; then
  if grep -qE "name:.*mail-core/" "$PKG/${patch#./}"; then ok; else
    ko "the row must name the subpath export, not the package root"
  fi
else ko "no patch file to check"; fi

# ---------------------------------------------------------------------------
step "5. the bundle is mounted in the profile"
if grep -q "dsh-mail-agent/mail-core" "$HOME/.dsh/profiles/$PROFILE/package.json" 2>/dev/null \
   && python3 - "$HOME/.dsh/profiles/$PROFILE/package.json" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if "@dsh-mail-agent/mail-core" in d["dsh"]["profile"]["bundles"] else 1)
PY
then ok; else
  ko "not in dsh.profile.bundles; add it with: dsh plugin --profile $PROFILE add $PKG"
fi

# ---------------------------------------------------------------------------
step "6. it appears as a composition layer"
if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "^# == @dsh-mail-agent/mail-core"; then
  ok
else
  ko "no '# == @dsh-mail-agent/mail-core' layer in --dump-config"
fi

# ---------------------------------------------------------------------------
# The one that actually matters. Composing is not booting: a row naming a
# module without apply() passes every check above and fails here.
step "7. the profile BOOTS"
# --port 0 lets the OS pick a free port, so this never collides with a running
# session — including the one an agent may be running this script from.
log=$(mktemp)
( cd /tmp && exec dsh --profile "$PROFILE" --port 0 >"$log" 2>&1 ) &
boot_pid=$!
for _ in $(seq 1 25); do
  sleep 2
  grep -q "dsh web:" "$log" 2>/dev/null && break
  kill -0 "$boot_pid" 2>/dev/null || break
done
if grep -q "dsh web:" "$log" 2>/dev/null; then ok; else
  ko "$(grep -m1 -E 'Error:' "$log" 2>/dev/null || echo 'did not reach "dsh web:"')"
fi
# Kill only the instance this script started, never one already running.
kill "$boot_pid" 2>/dev/null
wait "$boot_pid" 2>/dev/null
rm -f "$log"

# ---------------------------------------------------------------------------
echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — the task is done."
else
  echo "FAIL — the task is not done. Fix the lines marked FAIL and run this again."
fi
exit "$fail"
