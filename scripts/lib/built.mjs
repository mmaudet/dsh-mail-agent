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

const newest = (dir, suffix) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, newest(path, suffix));
    else if (entry.name.endsWith(suffix)) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
};

/**
 * Exits non-zero when `dist` predates `src`.
 *
 * @param {string} packageDir absolute path to the package being measured
 */
export function assertBuilt(packageDir) {
  // The newest output, not `dist/index.js`: an incremental build rewrites only
  // what changed, so the entry point can be older than a build that did run.
  // Checking one file made the guard refuse a build it had just watched happen.
  let built;
  try {
    built = newest(join(packageDir, 'dist'), '.js');
  } catch {
    console.error(`Refusing: ${join(packageDir, 'dist')} does not exist. Run \`npx tsc -b\` first.`);
    process.exit(2);
  }
  if (built === 0) {
    console.error(`Refusing: ${join(packageDir, 'dist')} holds no compiled output.`);
    process.exit(2);
  }
  const source = newest(join(packageDir, 'src'), '.ts');
  if (source > built) {
    const behind = Math.round((source - built) / 60000);
    console.error(`Refusing: dist is ${String(behind)} minutes older than src.`);
    console.error('Run `npx tsc -b` — a measurement against a stale build answers about code that is gone.');
    process.exit(2);
  }
}
