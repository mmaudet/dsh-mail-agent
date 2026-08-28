/**
 * OIDC authorization for JMAP: Authorization Code with PKCE (RFC 7636).
 *
 * The bootstrap route is deliberately not baked in. An operator can hand this
 * module an authorization code obtained any way at all, or an existing refresh
 * token, or let it drive a callback of its own. Which one suits a deployment
 * is an operational decision, and hard-coding one would make the module wrong
 * for the others.
 *
 * No credential is a literal here. `clientIdRef` and `clientSecretRef` name
 * entries in the harness secret service, and values are read at call time.
 */

import { createHash, randomBytes } from 'node:crypto';

import { redact, type SecretStore, type StoredTokens } from './token-store.js';

export interface OidcConfig {
  /** Issuer base URL; discovery appends `/.well-known/openid-configuration`. */
  readonly issuer: string;
  readonly clientIdRef: string;
  /** Set for a confidential client; `null` for a public one. */
  readonly clientSecretRef: string | null;
  /**
   * Must match a redirect URI registered for this client at the issuer. It is
   * configuration rather than a constant precisely because the registered
   * value differs between deployments.
   */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

/** Minimal HTTP surface, injected so no test reaches the network. */
export interface HttpClient {
  getJson(url: string): Promise<unknown>;
  postForm(url: string, form: Readonly<Record<string, string>>): Promise<unknown>;
}

export interface OidcEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly pkce: PkcePair;
}

/**
 * Builds a PKCE pair (RFC 7636 section 4).
 *
 * S256 only: the `plain` method offers no protection against an intercepted
 * authorization code, which is the whole point of the extension.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function createState(): string {
  return base64Url(randomBytes(16));
}

export class OidcClient {
  readonly #config: OidcConfig;
  readonly #secrets: SecretStore;
  readonly #http: HttpClient;
  #endpoints: OidcEndpoints | null = null;

  constructor(config: OidcConfig, secrets: SecretStore, http: HttpClient) {
    this.#config = config;
    this.#secrets = secrets;
    this.#http = http;
  }

  /** Reads `authorization_endpoint` and `token_endpoint` from discovery. */
  async discover(): Promise<OidcEndpoints> {
    if (this.#endpoints !== null) return this.#endpoints;

    const url = `${this.#config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const document = await this.#http.getJson(url);

    const authorizationEndpoint = readString(document, 'authorization_endpoint');
    const tokenEndpoint = readString(document, 'token_endpoint');
    if (authorizationEndpoint === null || tokenEndpoint === null) {
      throw new TypeError(`Discovery at ${url} returned no usable endpoints`);
    }

    this.#endpoints = { authorizationEndpoint, tokenEndpoint };
    return this.#endpoints;
  }

  /** Route 1 and 2: the URL a browser opens to obtain an authorization code. */
  async createAuthorizationRequest(): Promise<AuthorizationRequest> {
    const { authorizationEndpoint } = await this.discover();
    const clientId = await this.#requireSecret(this.#config.clientIdRef);
    const pkce = createPkcePair();
    const state = createState();

    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('scope', this.#config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', pkce.method);

    return { url: url.toString(), state, pkce };
  }

  /**
   * Route 1 and 2: trade an authorization code for tokens.
   *
   * The code may come from a callback this process served or from an operator
   * who copied it out of a browser; the exchange is identical either way.
   */
  async exchangeCode(code: string, verifier: string): Promise<StoredTokens> {
    return this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#config.redirectUri,
      code_verifier: verifier,
    });
  }

  /**
   * Route 3, and every renewal afterwards.
   *
   * A refresh token is bound to the client, not to the process that obtained
   * it, so one issued to another application registered under the same
   * `client_id` is usable here without involving the identity provider.
   */
  async refresh(refreshToken: string): Promise<StoredTokens> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Rejects a callback whose `state` does not match the request that started it. */
  static verifyState(expected: string, received: string | null): void {
    if (received === null || received !== expected) {
      throw new TypeError('OAuth state mismatch: the callback did not match the request');
    }
  }

  async #token(grant: Readonly<Record<string, string>>): Promise<StoredTokens> {
    const { tokenEndpoint } = await this.discover();
    const clientId = await this.#requireSecret(this.#config.clientIdRef);
    const clientSecret =
      this.#config.clientSecretRef === null
        ? null
        : await this.#requireSecret(this.#config.clientSecretRef);

    const form: Record<string, string> = { ...grant, client_id: clientId };
    if (clientSecret !== null) form['client_secret'] = clientSecret;

    let response: unknown;
    try {
      response = await this.#http.postForm(tokenEndpoint, form);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Token request failed: ${redact(message, [clientId, clientSecret, ...Object.values(grant)])}`,
        { cause: error },
      );
    }

    return toTokens(response, clientId, clientSecret);
  }

  async #requireSecret(ref: string): Promise<string> {
    const value = await this.#secrets.read(ref);
    if (value === null || value.length === 0) {
      throw new TypeError(`Secret ${ref} is not provisioned`);
    }
    return value;
  }
}

function toTokens(
  response: unknown,
  clientId: string,
  clientSecret: string | null,
): StoredTokens {
  const error = readString(response, 'error');
  if (error !== null) {
    const description = readString(response, 'error_description') ?? '';
    throw new Error(
      redact(`Token endpoint refused the grant: ${error} ${description}`.trim(), [
        clientId,
        clientSecret,
      ]),
    );
  }

  const accessToken = readString(response, 'access_token');
  if (accessToken === null) throw new TypeError('Token endpoint returned no access_token');

  const expiresIn = readNumber(response, 'expires_in') ?? 3600;
  return {
    accessToken,
    refreshToken: readString(response, 'refresh_token'),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: readString(response, 'scope') ?? '',
  };
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}
