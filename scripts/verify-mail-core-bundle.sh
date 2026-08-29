#!/usr/bin/env bash
#
# Acceptance check for the mail-core bundle task.
#
# Exists because prose criteria were satisfied with greps matching the agent's
# own writes. This is not a description of what to verify; it is the
# verification, and it exits non-zero when the task is not done.
#
#   bash scripts/verify-mail-core-bundle.sh
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
patch=$(node -e '
  const d = require(process.argv[1]);
  const b = d.dsh && d.dsh.bundle;
  process.stdout.write(b && typeof b === "object" && b.patch ? b.patch : "");
' "$PKG/package.json" 2>/dev/null)
if [ -z "$patch" ]; then
  ko 'dsh.bundle must be an object: {"patch": "./cordis.patch.yml"}, not true'
elif [ ! -f "$PKG/${patch#./}" ]; then
  ko "dsh.bundle.patch points at $patch, which does not exist"
else ok; fi

# ---------------------------------------------------------------------------
# One property, not one implementation: whatever the patch row names must
# resolve to a module exporting apply(). A ./plugin subpath export is the
# obvious way; re-exporting from the package root is equally valid, and a check
# that demanded the first would fail working work.
step "3. the patch row resolves to a module exporting apply()"
if [ -z "$patch" ] || [ ! -f "$PKG/${patch#./}" ]; then
  ko "no patch file to check"
else
  spec=$(sed -nE "s/^[[:space:]]*name:[[:space:]]*['\"]([^'\"]+)['\"].*/\1/p" "$PKG/${patch#./}" | head -1)
  if [ -z "$spec" ]; then
    ko "no name: field in the patch row"
  else
    detail=$(node -e '
      const path = require("node:path");
      const pkgPath = process.argv[1], spec = process.argv[2];
      const pkg = require(pkgPath), dir = path.dirname(pkgPath);
      const name = pkg.name || "";
      const sub = spec === name ? "."
        : spec.startsWith(name + "/") ? "." + spec.slice(name.length)
        : null;
      if (!sub) { console.log("NOMATCH"); process.exit(0); }
      const entry = (pkg.exports || {})[sub];
      const target = entry && typeof entry === "object" ? entry.default : entry;
      if (!target) { console.log("NOEXPORT"); process.exit(0); }
      const file = path.join(dir, target);
      require("node:fs").existsSync(file)
        ? import("file://" + file)
            .then((m) => console.log(typeof m.apply === "function" ? "OK" : "NOAPPLY:" + target))
            .catch((e) => console.log("IMPORTFAIL:" + String(e.message).slice(0, 60)))
        : console.log("NOFILE:" + target);
    ' "$PKG/package.json" "$spec" 2>/dev/null)

    case "${detail:-EMPTY}" in
      OK)          ok ;;
      NOMATCH)     ko "$spec is not this package or a subpath of it" ;;
      NOEXPORT)    ko "$spec matches no entry in package.json exports" ;;
      NOFILE:*)    ko "$spec resolves to ${detail#NOFILE:}, which the build did not emit" ;;
      NOAPPLY:*)   ko "${detail#NOAPPLY:} exports no apply(); mounting fails with 'invalid plugin'" ;;
      IMPORTFAIL:*) ko "could not import it: ${detail#IMPORTFAIL:}" ;;
      *)           ko "could not resolve $spec" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
step "4. the bundle is mounted in the profile"
if node -e '
  const d = require(process.argv[1]);
  const b = (d.dsh && d.dsh.profile && d.dsh.profile.bundles) || [];
  process.exit(b.includes("@dsh-mail-agent/mail-core") ? 0 : 1);
' "$HOME/.dsh/profiles/$PROFILE/package.json" 2>/dev/null
then ok; else
  ko "not in dsh.profile.bundles; add it with: dsh plugin --profile $PROFILE add $PKG"
fi

# ---------------------------------------------------------------------------
step "5. it appears as a composition layer"
if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "^# == @dsh-mail-agent/mail-core"; then
  ok
else
  ko "no '# == @dsh-mail-agent/mail-core' layer in --dump-config"
fi

# ---------------------------------------------------------------------------
# The one that matters. Composing is not booting: every check above passes on a
# row naming a module the loader cannot mount.
step "6. the profile BOOTS"
# --port 0 asks the OS for a free port, so this never collides with a running
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
