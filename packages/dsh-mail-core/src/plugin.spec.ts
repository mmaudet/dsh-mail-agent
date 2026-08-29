import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TOKENS_ENV, createJmapTransport, inject, name, type MailCoreConfig } from './plugin.js';

const CONFIG: MailCoreConfig = {
  accountIdEnv: 'MAIL_SENTINEL_JMAP_ACCOUNT_ID',
  identityIdEnv: 'MAIL_SENTINEL_JMAP_IDENTITY_ID',
  sessionUrlEnv: 'MAIL_SENTINEL_JMAP_SESSION_URL',
};

const ENV = {
  MAIL_SENTINEL_JMAP_SESSION_URL: 'https://jmap.example.com/session',
  MAIL_SENTINEL_JMAP_TOKENS: JSON.stringify({ accessToken: 'the-bearer-value' }),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers the session resource, then every POST. */
function fetcherOf(...posts: readonly Response[]): typeof fetch {
  let post = 0;
  return vi.fn((_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve(posts[post++] ?? json({ methodResponses: [] }));
    }
    return Promise.resolve(json({ apiUrl: 'https://jmap.example.com/jmap' }));
  });
}

describe('the plugin declaration', () => {
  it('waits for the tool registry', () => {
    expect(name).toBe('dsh-mail-core');
    expect(inject).toStrictEqual(['tools']);
  });
});

describe('the JMAP transport', () => {
  it('discovers apiUrl from the session and posts there', async () => {
    const fetcher = fetcherOf();
    const transport = createJmapTransport(CONFIG, ENV, fetcher);
    await transport.request({ using: [], methodCalls: [] });

    const calls = vi.mocked(fetcher).mock.calls;
    expect(calls[0]?.[0]).toBe('https://jmap.example.com/session');
    expect(calls[1]?.[0]).toBe('https://jmap.example.com/jmap');
    expect((calls[1]?.[1] as RequestInit).method).toBe('POST');
  });

  it('fetches the session once, not on every call', async () => {
    const fetcher = fetcherOf();
    const transport = createJmapTransport(CONFIG, ENV, fetcher);

    await transport.request({ using: [], methodCalls: [] });
    await transport.request({ using: [], methodCalls: [] });
    await transport.request({ using: [], methodCalls: [] });

    const sessionCalls = vi
      .mocked(fetcher)
      .mock.calls.filter(([, init]) => init?.method !== 'POST');
    expect(sessionCalls).toHaveLength(1);
  });

  it('sends the bearer on both the discovery and the call', async () => {
    const fetcher = fetcherOf();
    await createJmapTransport(CONFIG, ENV, fetcher).request({ using: [], methodCalls: [] });

    for (const [, init] of vi.mocked(fetcher).mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer the-bearer-value');
    }
  });

  it('rereads the token each call, so a refresh takes effect', async () => {
    const env: Record<string, string> = { ...ENV };
    const fetcher = fetcherOf();
    const transport = createJmapTransport(CONFIG, env, fetcher);

    await transport.request({ using: [], methodCalls: [] });
    env['MAIL_SENTINEL_JMAP_TOKENS'] = JSON.stringify({ accessToken: 'renewed' });
    await transport.request({ using: [], methodCalls: [] });

    const last = vi.mocked(fetcher).mock.calls.at(-1);
    expect(((last?.[1] as RequestInit).headers as Record<string, string>)['authorization']).toBe(
      'Bearer renewed',
    );
  });

  it('rediscovers after the endpoint reports it is gone', async () => {
    const fetcher = fetcherOf(json({}, 410), json({ methodResponses: [] }));
    const transport = createJmapTransport(CONFIG, ENV, fetcher);

    await expect(transport.request({ using: [], methodCalls: [] })).rejects.toThrow(/410/);
    await transport.request({ using: [], methodCalls: [] });

    const sessionCalls = vi
      .mocked(fetcher)
      .mock.calls.filter(([, init]) => init?.method !== 'POST');
    expect(sessionCalls).toHaveLength(2);
  });

  it('keeps the cache for an ordinary failure', async () => {
    const fetcher = fetcherOf(json({}, 500), json({ methodResponses: [] }));
    const transport = createJmapTransport(CONFIG, ENV, fetcher);

    await expect(transport.request({ using: [], methodCalls: [] })).rejects.toThrow(/500/);
    await transport.request({ using: [], methodCalls: [] });

    const sessionCalls = vi
      .mocked(fetcher)
      .mock.calls.filter(([, init]) => init?.method !== 'POST');
    expect(sessionCalls).toHaveLength(1);
  });
});

describe('credentials never reach an error message', () => {
  it('reports a malformed record by shape, not by content', async () => {
    const env = { ...ENV, MAIL_SENTINEL_JMAP_TOKENS: 'not json at all' };
    const transport = createJmapTransport(CONFIG, env, fetcherOf());

    const error = await transport.request({ using: [], methodCalls: [] }).catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('is not valid JSON');
    expect(message).not.toContain('not json at all');
  });

  it('names the variable when a record carries no token', async () => {
    const env = { ...ENV, MAIL_SENTINEL_JMAP_TOKENS: JSON.stringify({ refreshToken: 'x' }) };
    await expect(
      createJmapTransport(CONFIG, env, fetcherOf()).request({ using: [], methodCalls: [] }),
    ).rejects.toThrow(/holds no accessToken/);
  });

  it('honours a configured token variable name', async () => {
    const env = { ...ENV, OTHER_TOKENS: JSON.stringify({ accessToken: 'other' }) };
    const fetcher = fetcherOf();
    await createJmapTransport({ ...CONFIG, tokensEnv: 'OTHER_TOKENS' }, env, fetcher).request({
      using: [],
      methodCalls: [],
    });

    const headers = (vi.mocked(fetcher).mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers['authorization']).toBe('Bearer other');
  });

  it('defaults that name when configuration omits it', () => {
    expect(DEFAULT_TOKENS_ENV).toBe('MAIL_SENTINEL_JMAP_TOKENS');
  });
});

describe('missing configuration', () => {
  it('names the variable that is not set', async () => {
    const transport = createJmapTransport(CONFIG, {}, fetcherOf());
    await expect(transport.request({ using: [], methodCalls: [] })).rejects.toThrow(
      /MAIL_SENTINEL_JMAP_TOKENS is not set/,
    );
  });

  it('reports a session URL that is absent', async () => {
    const env = { MAIL_SENTINEL_JMAP_TOKENS: ENV.MAIL_SENTINEL_JMAP_TOKENS };
    const transport = createJmapTransport(CONFIG, env, fetcherOf());
    await expect(transport.request({ using: [], methodCalls: [] })).rejects.toThrow(
      /MAIL_SENTINEL_JMAP_SESSION_URL is not set/,
    );
  });

  it('reports a session that carries no apiUrl', async () => {
    const fetcher = vi.fn(() => Promise.resolve(json({ username: 'me' }))) as unknown as typeof fetch;
    const transport = createJmapTransport(CONFIG, ENV, fetcher);
    await expect(transport.request({ using: [], methodCalls: [] })).rejects.toThrow(/no apiUrl/);
  });
});
