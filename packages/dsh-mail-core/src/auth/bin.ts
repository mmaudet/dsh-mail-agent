#!/usr/bin/env node
/**
 * `mail-auth` entry point.
 *
 * Thin on purpose: it binds the process to {@link run} and turns a thrown
 * error into one line and a non-zero exit. Everything worth testing lives in
 * `cli.ts`, which takes its environment as an argument.
 */

import { run, readStdin } from './cli.js';

const code = await run(process.argv.slice(2), {
  env: process.env,
  log: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  readStdin,
}).catch((error: unknown) => {
  // The message may quote a failed request; the OIDC client redacts
  // credentials before they reach one, so this prints what is left.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

process.exit(code);
