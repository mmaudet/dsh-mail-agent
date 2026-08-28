/**
 * Persistence for OAuth tokens.
 *
 * Encryption is not implemented here on purpose. The harness secret service
 * already encrypts at rest and owns key handling, so this store delegates to
 * it and never sees a key. A token reaches disk only through `dsh-secrets`.
 */

/**
 * The subset of the harness secret service this package needs.
 *
 * References look like `dsh:secret:jmap-oidc-client-id`; the value behind one
 * never appears in this repository, in configuration, or in a log line.
 */
export interface SecretStore {
  read(ref: string): Promise<string | null>;
  write(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface StoredTokens {
  readonly accessToken: string;
  /** Present only when the grant included `offline_access`. */
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
  readonly scope: string;
}

/** How long before real expiry a token is treated as expired. */
export const EXPIRY_SKEW_MS = 60_000;

export class TokenStore {
  readonly #secrets: SecretStore;
  readonly #ref: string;

  constructor(secrets: SecretStore, ref: string) {
    this.#secrets = secrets;
    this.#ref = ref;
  }

  async load(): Promise<StoredTokens | null> {
    const raw = await this.#secrets.read(this.#ref);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A malformed record is indistinguishable from no record: re-authorising
      // is safe, and reporting the content would leak it.
      return null;
    }
    return toStoredTokens(parsed);
  }

  async save(tokens: StoredTokens): Promise<void> {
    await this.#secrets.write(
      this.#ref,
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        scope: tokens.scope,
      }),
    );
  }

  async clear(): Promise<void> {
    await this.#secrets.delete(this.#ref);
  }
}

/** True when the token is expired, or close enough that a refresh is due. */
export function isExpired(tokens: StoredTokens, now: Date = new Date()): boolean {
  return tokens.expiresAt.getTime() - EXPIRY_SKEW_MS <= now.getTime();
}

function toStoredTokens(value: unknown): StoredTokens | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const accessToken = record['accessToken'];
  const expiresAt = record['expiresAt'];
  if (typeof accessToken !== 'string' || typeof expiresAt !== 'string') return null;

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;

  const refreshToken = record['refreshToken'];
  const scope = record['scope'];
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : null,
    expiresAt: expiry,
    scope: typeof scope === 'string' ? scope : '',
  };
}

/**
 * Replaces every known secret with a placeholder.
 *
 * Error paths are where credentials escape: a failed token exchange wants to
 * quote the request that failed. Everything user-facing goes through this.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}
