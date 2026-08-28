/**
 * XOAUTH2 for IMAP and SMTP (Gmail, Outlook 365).
 *
 * The SASL exchange carries a bearer token, so the value is built at call time
 * from a token the caller already holds and is never stored here.
 */

import type { SecretStore } from './token-store.js';

/**
 * Encodes an XOAUTH2 initial client response.
 *
 * The wire format is `user=<email>^Aauth=Bearer <token>^A^A`, base64-encoded,
 * where `^A` is a single 0x01 byte.
 */
export function buildXoauth2Token(user: string, accessToken: string): string {
  if (user.length === 0) throw new TypeError('XOAUTH2 needs a user');
  if (accessToken.length === 0) throw new TypeError('XOAUTH2 needs an access token');

  // A literal 0x01 in source is invisible in review, so it is escaped here.
  const sep = '\x01';
  const parts = `user=${user}${sep}auth=Bearer ${accessToken}${sep}${sep}`;
  return Buffer.from(parts, 'utf8').toString('base64');
}

export interface Xoauth2Config {
  readonly user: string;
  /** Reference to the stored token record, resolved through the secret service. */
  readonly tokensRef: string;
}

export interface Xoauth2Credentials {
  readonly user: string;
  readonly accessToken: string;
}

/**
 * Reads the current access token for an account.
 *
 * Refreshing is the caller's job: this returns what is stored so a connection
 * can be opened, and a caller that finds it expired refreshes through the OIDC
 * client before retrying.
 */
export async function readXoauth2Credentials(
  config: Xoauth2Config,
  secrets: SecretStore,
): Promise<Xoauth2Credentials | null> {
  const raw = await secrets.read(config.tokensRef);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const accessToken =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['accessToken']
      : undefined;

  return typeof accessToken === 'string' && accessToken.length > 0
    ? { user: config.user, accessToken }
    : null;
}
