/**
 * A {@link SecretStore} over the harness home `.env` file.
 *
 * The credential seam addresses secrets by environment-variable name, and the
 * local provider reads `.env` layers, so this is the writable layer a
 * command-line bootstrap can use before any harness process exists.
 *
 * It is deliberately not a general key-value store: it refuses names that
 * decide how a process starts, and it never widens file permissions.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SecretStore } from './token-store.js';

/**
 * Variables the harness rejects from `.env` files because they decide how the
 * process starts. Writing one here would be silently ineffective at best.
 */
const RESERVED = /^(PATH|HOME|SHELL|DSH_|XDG_|LD_|NODE_OPTIONS|.*_PROXY|https?_proxy)/i;

export class EnvFileStore implements SecretStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(ref: string): Promise<string | null> {
    assertName(ref);
    const lines = await this.#lines();
    // Last definition wins, matching how a shell sources a file.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const value = parseLine(lines[index] ?? '', ref);
      if (value !== null) return value.length > 0 ? value : null;
    }
    return null;
  }

  async write(ref: string, value: string): Promise<void> {
    assertName(ref);
    if (value.includes('\n')) {
      throw new TypeError(`${ref} cannot contain a newline`);
    }
    const kept = (await this.#lines()).filter((line) => parseLine(line, ref) === null);
    kept.push(`${ref}=${value}`);
    await this.#save(kept);
  }

  async delete(ref: string): Promise<void> {
    assertName(ref);
    const kept = (await this.#lines()).filter((line) => parseLine(line, ref) === null);
    await this.#save(kept);
  }

  async #lines(): Promise<string[]> {
    try {
      const text = await readFile(this.#path, 'utf8');
      return text.split('\n').filter((line) => line.length > 0);
    } catch (error: unknown) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async #save(lines: readonly string[]): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    // Written before the content lands, so the file is never briefly readable.
    await writeFile(this.#path, `${lines.join('\n')}\n`, { mode: 0o600 });
    await chmod(this.#path, 0o600);
  }
}

/** Read one line as `NAME=value`, returning the value only for a matching name. */
function parseLine(line: string, ref: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return null;

  const separator = trimmed.indexOf('=');
  if (separator <= 0) return null;
  if (trimmed.slice(0, separator).trim() !== ref) return null;

  const raw = trimmed.slice(separator + 1).trim();
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted?.[2] ?? raw;
}

function assertName(ref: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) {
    throw new TypeError(
      `${ref} is not an environment-variable name; the credential seam addresses secrets by name`,
    );
  }
  if (RESERVED.test(ref)) {
    throw new TypeError(`${ref} decides how a process starts and is rejected from a .env file`);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
