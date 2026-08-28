/**
 * App-password authentication for IMAP and SMTP (iCloud, Fastmail, Dovecot).
 *
 * The password is read from the harness secret service at connection time and
 * returned to the caller that opens the connection. It is never held on a
 * long-lived object, so a heap dump or a serialised config cannot carry it.
 */

import type { SecretStore } from './token-store.js';

export interface AppPasswordConfig {
  readonly user: string;
  /** Reference such as `dsh:secret:imap-app-password`, never the password. */
  readonly passwordRef: string;
}

export interface AppPasswordCredentials {
  readonly user: string;
  readonly password: string;
}

export async function readAppPassword(
  config: AppPasswordConfig,
  secrets: SecretStore,
): Promise<AppPasswordCredentials> {
  if (config.user.length === 0) throw new TypeError('An app password needs a user');

  const password = await secrets.read(config.passwordRef);
  if (password === null || password.length === 0) {
    throw new TypeError(`Secret ${config.passwordRef} is not provisioned`);
  }
  return { user: config.user, password };
}

/**
 * Rejects a configuration that carries a credential inline.
 *
 * Configuration is reviewed, diffed and shipped in a public repository, so a
 * password reaching it is a leak whatever the intent. This turns that into a
 * startup failure rather than something a reviewer has to notice.
 */
export function assertNoInlineSecret(config: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(config)) {
    const looksLikeSecret = /password|secret|token|api[-_]?key/i.test(key);
    const isReference = typeof value === 'string' && value.startsWith('dsh:secret:');
    if (looksLikeSecret && typeof value === 'string' && !isReference && !key.endsWith('Ref')) {
      throw new TypeError(`${key} must be a dsh:secret: reference, not a literal value`);
    }
  }
}
