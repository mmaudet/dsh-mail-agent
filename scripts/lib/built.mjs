// Refuses to measure against a build older than the source it came from.
//
// Every script here imports the compiled package rather than the TypeScript,
// and the measurements run on a remote host where `git pull` and `tsc -b` are
// two separate things somebody has to remember. One night they were not: a
// draft measurement compared two conditions that had compiled to the same
// prompt, and reported the difference between them as a result.
//
// A stale build does not fail. It answers, plausibly, about code that is no
// longer there — which is the worst kind of wrong a measurement can be.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const newest = (dir) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(path));
    else if (entry.name.endsWith('.ts')) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
};

/**
 * Exits non-zero when `dist` predates `src`.
 *
 * @param {string} packageDir absolute path to the package being measured
 */
export function assertBuilt(packageDir) {
  const dist = join(packageDir, 'dist', 'index.js');
  let built;
  try {
    built = statSync(dist).mtimeMs;
  } catch {
    console.error(`Refusing: ${dist} does not exist. Run \`npx tsc -b\` first.`);
    process.exit(2);
  }
  const source = newest(join(packageDir, 'src'));
  if (source > built) {
    const behind = Math.round((source - built) / 60000);
    console.error(`Refusing: dist is ${String(behind)} minutes older than src.`);
    console.error('Run `npx tsc -b` — a measurement against a stale build answers about code that is gone.');
    process.exit(2);
  }
}
