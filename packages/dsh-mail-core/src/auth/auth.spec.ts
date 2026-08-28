import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { assertNoInlineSecret, readAppPassword } from './app-password-imap.js';
import {
  OidcClient,
  createPkcePair,
  createState,
  type HttpClient,
  type OidcConfig,
} from './oidc-jmap.js';
import { EXPIRY_SKEW_MS, TokenStore, isExpired, redact, type SecretStore } from './token-store.js';
import { buildXoauth2Token, readXoauth2Credentials } from './xoauth2-imap.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const CLIENT_ID = 'mmaudet-twaky-mail-sentinel';
const CLIENT_SECRET = 'sh-super-secret-value-9f2a';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  constructor(entries: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
  }

  read(ref: string): Promise<string | null> {
    return Promise.resolve(this.values.get(ref) ?? null);
  }

  write(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
    return Promise.resolve();
  }

  delete(ref: string): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }
}

const DISCOVERY = {
  authorization_endpoint: 'https://sso.example.com/auth',
  token_endpoint: 'https://sso.example.com/token',
};

const CONFIG: OidcConfig = {
  issuer: 'https://sso.example.com/',
  clientIdRef: 'dsh:secret:jmap-oidc-client-id',
  clientSecretRef: 'dsh:secret:jmap-oidc-client-secret',
  redirectUri: 'https://example.org/oauth/jmap/callback',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
};

function secretsWithClient(): MemorySecrets {
  return new MemorySecrets({
    'dsh:secret:jmap-oidc-client-id': CLIENT_ID,
    'dsh:secret:jmap-oidc-client-secret': CLIENT_SECRET,
  });
}

function httpOf(token: unknown, discovery: unknown = DISCOVERY): HttpClient & {
  readonly forms: Record<string, string>[];
} {
  const forms: Record<string, string>[] = [];
  return {
    forms,
    getJson: () => Promise.resolve(discovery),
    postForm: (_url, form) => {
      forms.push({ ...form });
      return Promise.resolve(token);
    },
  };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('PKCE', () => {
  it('derives the challenge as the S256 hash of the verifier (RFC 7636)', () => {
    const pkce = createPkcePair();
    const expected = createHash('sha256').update(pkce.verifier).digest('base64url');

    expect(pkce.method).toBe('S256');
    expect(pkce.challenge).toBe(expected);
  });

  it('produces a verifier inside the length the spec allows', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('never repeats a verifier or a state', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier));
    const states = new Set(Array.from({ length: 50 }, () => createState()));

    expect(verifiers.size).toBe(50);
    expect(states.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

describe('createAuthorizationRequest', () => {
  it('carries the challenge, never the verifier', async () => {
    const client = new OidcClient(CONFIG, secretsWithClient(), httpOf({}));
    const request = await client.createAuthorizationRequest();
    const url = new URL(request.url);

    expect(url.searchParams.get('code_challenge')).toBe(request.pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(request.url).not.toContain(request.pkce.verifier);
  });

  it('sends the configured redirect_uri and scopes', async () => {
    const client = new OidcClient(CONFIG, secretsWithClient(), httpOf({}));
    const url = new URL((await client.createAuthorizationRequest()).url);

    expect(url.searchParams.get('redirect_uri')).toBe('https://example.org/oauth/jmap/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('never puts the client secret in a browser-visible URL', async () => {
    const client = new OidcClient(CONFIG, secretsWithClient(), httpOf({}));
    const request = await client.createAuthorizationRequest();

    expect(request.url).not.toContain(CLIENT_SECRET);
  });

  it('builds discovery from the issuer, trailing slash or not', async () => {
    const http = httpOf({});
    const spy = vi.spyOn(http, 'getJson');
    await new OidcClient(CONFIG, secretsWithClient(), http).createAuthorizationRequest();

    expect(spy).toHaveBeenCalledWith('https://sso.example.com/.well-known/openid-configuration');
  });

  it('refuses to build a request when the client id is not provisioned', async () => {
    const client = new OidcClient(CONFIG, new MemorySecrets(), httpOf({}));
    await expect(client.createAuthorizationRequest()).rejects.toThrow(/not provisioned/);
  });
});

describe('verifyState', () => {
  it('rejects a callback whose state does not match', () => {
    expect(() => OidcClient.verifyState('abc', 'def')).toThrow(/state mismatch/);
    expect(() => OidcClient.verifyState('abc', null)).toThrow(/state mismatch/);
  });

  it('accepts the state it issued', () => {
    expect(() => OidcClient.verifyState('abc', 'abc')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe('exchangeCode', () => {
  it('sends the verifier and the confidential client credentials', async () => {
    const http = httpOf({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    const client = new OidcClient(CONFIG, secretsWithClient(), http);
    await client.exchangeCode('the-code', 'the-verifier');

    expect(http.forms[0]).toStrictEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://example.org/oauth/jmap/callback',
      code_verifier: 'the-verifier',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  it('omits the secret entirely for a public client', async () => {
    const http = httpOf({ access_token: 'at' });
    const client = new OidcClient(
      { ...CONFIG, clientSecretRef: null },
      secretsWithClient(),
      http,
    );
    await client.exchangeCode('c', 'v');

    expect(http.forms[0]).not.toHaveProperty('client_secret');
  });

  it('turns expires_in into an absolute instant', async () => {
    const http = httpOf({ access_token: 'at', expires_in: 120 });
    const before = Date.now();
    const tokens = await new OidcClient(CONFIG, secretsWithClient(), http).exchangeCode('c', 'v');

    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(tokens.accessToken).toBe('at');
  });

  it('reports a grant the endpoint refused', async () => {
    const http = httpOf({ error: 'invalid_grant', error_description: 'code expired' });
    const client = new OidcClient(CONFIG, secretsWithClient(), http);

    await expect(client.exchangeCode('c', 'v')).rejects.toThrow(/invalid_grant.*code expired/);
  });
});

describe('refresh', () => {
  it('sends a refresh grant, which route 3 reuses as-is', async () => {
    const http = httpOf({ access_token: 'new', refresh_token: 'rotated', expires_in: 60 });
    const client = new OidcClient(CONFIG, secretsWithClient(), http);
    const tokens = await client.refresh('imported-from-another-app');

    expect(http.forms[0]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'imported-from-another-app',
      client_id: CLIENT_ID,
    });
    expect(tokens.refreshToken).toBe('rotated');
  });
});

// ---------------------------------------------------------------------------
// Secrets must not leak
// ---------------------------------------------------------------------------

describe('secrets never reach an error message', () => {
  it('redacts credentials when the transport throws', async () => {
    const http: HttpClient = {
      getJson: () => Promise.resolve(DISCOVERY),
      postForm: (_url, form) =>
        Promise.reject(new Error(`upstream rejected body: ${new URLSearchParams(form).toString()}`)),
    };
    const client = new OidcClient(CONFIG, secretsWithClient(), http);

    const error = await client.exchangeCode('the-code', 'the-verifier').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).not.toContain(CLIENT_SECRET);
    expect(message).not.toContain('the-code');
    expect(message).not.toContain('the-verifier');
    expect(message).toContain('[redacted]');
  });

  it('redacts credentials when the endpoint returns an error body', async () => {
    const http = httpOf({ error: 'invalid_client', error_description: `bad ${CLIENT_SECRET}` });
    const client = new OidcClient(CONFIG, secretsWithClient(), http);

    const error = await client.exchangeCode('c', 'v').catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).not.toContain(CLIENT_SECRET);
  });

  it('leaves a value too short to be a credential alone', () => {
    expect(redact('port 993 is open', ['993'])).toBe('port 993 is open');
  });

  it('replaces every occurrence, not only the first', () => {
    expect(redact(`${CLIENT_SECRET} and ${CLIENT_SECRET}`, [CLIENT_SECRET])).toBe(
      '[redacted] and [redacted]',
    );
  });
});

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

describe('TokenStore', () => {
  const TOKENS = {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date('2026-08-28T12:00:00Z'),
    scope: 'openid offline_access',
  };

  it('round-trips through the secret service', async () => {
    const secrets = new MemorySecrets();
    const store = new TokenStore(secrets, 'dsh:secret:jmap-tokens');

    await store.save(TOKENS);
    expect(await store.load()).toStrictEqual(TOKENS);
  });

  it('writes only through the secret service, never to a path of its own', async () => {
    const secrets = new MemorySecrets();
    await new TokenStore(secrets, 'dsh:secret:jmap-tokens').save(TOKENS);

    expect([...secrets.values.keys()]).toStrictEqual(['dsh:secret:jmap-tokens']);
  });

  it('treats a corrupt record as absent rather than reporting its content', async () => {
    const secrets = new MemorySecrets({ 'dsh:secret:jmap-tokens': 'not json' });
    expect(await new TokenStore(secrets, 'dsh:secret:jmap-tokens').load()).toBeNull();
  });

  it('rejects a record missing an access token', async () => {
    const secrets = new MemorySecrets({ 'dsh:secret:jmap-tokens': '{"refreshToken":"rt"}' });
    expect(await new TokenStore(secrets, 'dsh:secret:jmap-tokens').load()).toBeNull();
  });

  it('clears the entry', async () => {
    const secrets = new MemorySecrets();
    const store = new TokenStore(secrets, 'dsh:secret:jmap-tokens');
    await store.save(TOKENS);
    await store.clear();

    expect(await store.load()).toBeNull();
  });
});

describe('isExpired', () => {
  const at = (iso: string): Date => new Date(iso);
  const tokens = {
    accessToken: 'at',
    refreshToken: null,
    expiresAt: at('2026-08-28T12:00:00Z'),
    scope: '',
  };

  it('is false well before expiry', () => {
    expect(isExpired(tokens, at('2026-08-28T11:00:00Z'))).toBe(false);
  });

  it('refreshes early rather than racing the clock', () => {
    const justInsideSkew = new Date(tokens.expiresAt.getTime() - EXPIRY_SKEW_MS + 1);
    expect(isExpired(tokens, justInsideSkew)).toBe(true);
  });

  it('is true after expiry', () => {
    expect(isExpired(tokens, at('2026-08-28T12:30:00Z'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IMAP credentials
// ---------------------------------------------------------------------------

describe('buildXoauth2Token', () => {
  it('encodes the SASL frame with its 0x01 separators', () => {
    const encoded = buildXoauth2Token('me@example.org', 'tok');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(
      'user=me@example.org\x01auth=Bearer tok\x01\x01',
    );
  });

  it('refuses to build a frame without a token', () => {
    expect(() => buildXoauth2Token('me@example.org', '')).toThrow(/access token/);
    expect(() => buildXoauth2Token('', 'tok')).toThrow(/user/);
  });
});

describe('readXoauth2Credentials', () => {
  it('reads the access token out of the stored record', async () => {
    const secrets = new MemorySecrets({
      'dsh:secret:jmap-tokens': JSON.stringify({ accessToken: 'at' }),
    });
    const credentials = await readXoauth2Credentials(
      { user: 'me@example.org', tokensRef: 'dsh:secret:jmap-tokens' },
      secrets,
    );

    expect(credentials).toStrictEqual({ user: 'me@example.org', accessToken: 'at' });
  });

  it('returns nothing when no token has been stored', async () => {
    const credentials = await readXoauth2Credentials(
      { user: 'me@example.org', tokensRef: 'dsh:secret:jmap-tokens' },
      new MemorySecrets(),
    );
    expect(credentials).toBeNull();
  });
});

describe('readAppPassword', () => {
  it('resolves the password through the secret service', async () => {
    const secrets = new MemorySecrets({ 'dsh:secret:imap-app-password': 'abcd-efgh' });
    const credentials = await readAppPassword(
      { user: 'me@icloud.com', passwordRef: 'dsh:secret:imap-app-password' },
      secrets,
    );

    expect(credentials).toStrictEqual({ user: 'me@icloud.com', password: 'abcd-efgh' });
  });

  it('fails loudly when the secret is missing', async () => {
    await expect(
      readAppPassword(
        { user: 'me@icloud.com', passwordRef: 'dsh:secret:imap-app-password' },
        new MemorySecrets(),
      ),
    ).rejects.toThrow(/not provisioned/);
  });
});

describe('assertNoInlineSecret', () => {
  it('rejects a password written straight into configuration', () => {
    expect(() => {
      assertNoInlineSecret({ user: 'me', password: 'hunter2' });
    }).toThrow(/must be a dsh:secret: reference/);
  });

  it('accepts a reference', () => {
    expect(() => {
      assertNoInlineSecret({ user: 'me', password: 'dsh:secret:imap-app-password' });
    }).not.toThrow();
  });

  it('accepts a field already named as a reference', () => {
    expect(() => {
      assertNoInlineSecret({ passwordRef: 'dsh:secret:imap-app-password' });
    }).not.toThrow();
  });
});
