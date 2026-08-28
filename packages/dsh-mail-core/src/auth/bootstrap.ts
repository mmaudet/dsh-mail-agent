/**
 * The one-off JMAP authorisation, as steps a person can drive.
 *
 * Getting the first token is interactive by nature: a browser has to reach the
 * identity provider and a human has to authenticate. What can be automated is
 * everything either side of that — building the request, holding the PKCE
 * verifier across the gap, exchanging the code, and storing the result.
 *
 * The gap itself is deliberately explicit. `begin()` hands back a URL and a
 * pending state; `complete()` takes the code the operator recovered. How the
 * code was recovered — a local callback, a hostname redirected at the
 * workstation, or an address bar — is an operational choice, and none of the
 * three is baked in here.
 */

import { OidcClient, type HttpClient, type OidcConfig } from './oidc-jmap.js';
import { TokenStore, isExpired, type SecretStore, type StoredTokens } from './token-store.js';

/** What must survive between the browser leaving and the code coming back. */
export interface PendingAuthorization {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}

export interface BootstrapOptions {
  readonly config: OidcConfig;
  readonly secrets: SecretStore;
  readonly http: HttpClient;
  /** Environment-variable name holding the stored token record. */
  readonly tokensRef: string;
}

export class JmapBootstrap {
  readonly #client: OidcClient;
  readonly #store: TokenStore;

  constructor(options: BootstrapOptions) {
    this.#client = new OidcClient(options.config, options.secrets, options.http);
    this.#store = new TokenStore(options.secrets, options.tokensRef);
  }

  /** Step one: the URL to open, and the state to carry across the gap. */
  async begin(): Promise<PendingAuthorization> {
    const request = await this.#client.createAuthorizationRequest();
    return { url: request.url, state: request.state, verifier: request.pkce.verifier };
  }

  /**
   * Step two: exchange the recovered code.
   *
   * The returned `state` is checked against the pending one before the code is
   * spent. A mismatch means the callback did not belong to this request, which
   * is the case the parameter exists to catch.
   */
  async complete(
    pending: PendingAuthorization,
    code: string,
    returnedState: string | null,
  ): Promise<StoredTokens> {
    OidcClient.verifyState(pending.state, returnedState);

    const tokens = await this.#client.exchangeCode(code, pending.verifier);
    if (tokens.refreshToken === null) {
      throw new Error(
        'The grant returned no refresh token; request the offline_access scope, '
          + 'otherwise the agent cannot renew without a browser',
      );
    }
    await this.#store.save(tokens);
    return tokens;
  }

  /**
   * Adopt a refresh token obtained elsewhere.
   *
   * A refresh token is bound to the OAuth client, not to the process that
   * obtained it, so one issued to another application under the same
   * `client_id` is usable here. It is redeemed immediately rather than stored
   * as given: that proves it works now, instead of failing at the first
   * unattended run.
   */
  async adoptRefreshToken(refreshToken: string): Promise<StoredTokens> {
    const tokens = await this.#client.refresh(refreshToken);
    await this.#store.save({
      ...tokens,
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
    return tokens;
  }

  /** Renew when due; returns the current tokens either way. */
  async refreshIfDue(now: Date = new Date()): Promise<StoredTokens | null> {
    const stored = await this.#store.load();
    if (stored === null) return null;
    if (!isExpired(stored, now)) return stored;
    if (stored.refreshToken === null) return null;

    const renewed = await this.#client.refresh(stored.refreshToken);
    const tokens: StoredTokens = {
      ...renewed,
      // A provider that does not rotate returns no new refresh token; keeping
      // the old one is what makes the next renewal possible.
      refreshToken: renewed.refreshToken ?? stored.refreshToken,
    };
    await this.#store.save(tokens);
    return tokens;
  }

  /** What is stored, without disclosing any of it. */
  async status(now: Date = new Date()): Promise<AuthorizationStatus> {
    const stored = await this.#store.load();
    if (stored === null) return { configured: false };
    return {
      configured: true,
      expiresAt: stored.expiresAt,
      expired: isExpired(stored, now),
      canRenew: stored.refreshToken !== null,
      scope: stored.scope,
    };
  }
}

export type AuthorizationStatus =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly expiresAt: Date;
      readonly expired: boolean;
      readonly canRenew: boolean;
      readonly scope: string;
    };

/** A `fetch`-backed {@link HttpClient}; the only place this package does I/O. */
export function createHttpClient(fetcher: typeof fetch = fetch): HttpClient {
  return {
    async getJson(url: string): Promise<unknown> {
      const response = await fetcher(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`GET ${url} returned ${String(response.status)}`);
      }
      return response.json();
    },

    async postForm(url: string, form: Readonly<Record<string, string>>): Promise<unknown> {
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
      });
      // A token endpoint reports a rejected grant in a JSON body with a
      // non-2xx status, so the body is read either way and the caller
      // classifies it.
      return response.json().catch(() => ({ error: `http_${String(response.status)}` }));
    },
  };
}

/**
 * Recover the `code` and `state` from whatever the operator pasted.
 *
 * Accepts a full redirect URL, a bare query string, or the code alone, because
 * an operator recovering a code from an address bar will paste any of the
 * three and none of them is wrong.
 */
export function parseCallback(input: string): { code: string; state: string | null } | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed;
  const params = new URLSearchParams(query);

  const error = params.get('error');
  if (error !== null) {
    throw new Error(
      `The identity provider refused: ${error}${
        params.get('error_description') === null ? '' : ` (${params.get('error_description') ?? ''})`
      }`,
    );
  }

  const code = params.get('code');
  if (code !== null) return { code, state: params.get('state') };

  // Not a query string at all: treat the whole input as the code.
  return /[?&=]/.test(trimmed) ? null : { code: trimmed, state: null };
}
