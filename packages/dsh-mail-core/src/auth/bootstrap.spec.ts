import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JmapBootstrap, parseCallback } from './bootstrap.js';
import { run, resolveConfig, envFilePath, type CliEnvironment } from './cli.js';
import { EnvFileStore } from './env-store.js';
import type { HttpClient, OidcConfig } from './oidc-jmap.js';
import type { SecretStore } from './token-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: OidcConfig = {
  issuer: 'https://sso.example.com',
  clientIdRef: 'MAIL_SENTINEL_OIDC_CLIENT_ID',
  clientSecretRef: 'MAIL_SENTINEL_OIDC_CLIENT_SECRET',
  redirectUri: 'https://app.example.org/oauth/jmap/callback',
  scopes: ['openid', 'offline_access'],
};

class Memory implements SecretStore {
  readonly values = new Map<string, string>([
    ['MAIL_SENTINEL_OIDC_CLIENT_ID', 'client-abc'],
    ['MAIL_SENTINEL_OIDC_CLIENT_SECRET', 'secret-value-long-enough'],
  ]);

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

function http(token: unknown): HttpClient {
  return {
    getJson: () =>
      Promise.resolve({
        authorization_endpoint: 'https://sso.example.com/auth',
        token_endpoint: 'https://sso.example.com/token',
      }),
    postForm: () => Promise.resolve(token),
  };
}

function bootstrapWith(token: unknown, secrets = new Memory()): {
  bootstrap: JmapBootstrap;
  secrets: Memory;
} {
  return {
    bootstrap: new JmapBootstrap({
      config: CONFIG,
      secrets,
      http: http(token),
      tokensRef: 'MAIL_SENTINEL_JMAP_TOKENS',
    }),
    secrets,
  };
}

// ---------------------------------------------------------------------------
// parseCallback
// ---------------------------------------------------------------------------

describe('parseCallback', () => {
  it('reads a whole redirect URL, which is what an address bar holds', () => {
    expect(
      parseCallback('https://app.example.org/oauth/jmap/callback?code=abc&state=xyz'),
    ).toStrictEqual({ code: 'abc', state: 'xyz' });
  });

  it('reads a bare query string', () => {
    expect(parseCallback('code=abc&state=xyz')).toStrictEqual({ code: 'abc', state: 'xyz' });
  });

  it('accepts the code alone', () => {
    expect(parseCallback('  abc123  ')).toStrictEqual({ code: 'abc123', state: null });
  });

  it('reports a refusal from the identity provider rather than looking for a code', () => {
    expect(() =>
      parseCallback('https://app/cb?error=access_denied&error_description=User+said+no'),
    ).toThrow(/access_denied/);
  });

  it('returns nothing for input carrying no code at all', () => {
    expect(parseCallback('')).toBeNull();
    expect(parseCallback('https://app/cb?state=xyz')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The interactive gap
// ---------------------------------------------------------------------------

describe('begin and complete', () => {
  const TOKEN = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid' };

  it('carries the verifier across the gap without putting it in the URL', async () => {
    const { bootstrap } = bootstrapWith(TOKEN);
    const pending = await bootstrap.begin();

    expect(pending.url).toContain('code_challenge=');
    expect(pending.url).not.toContain(pending.verifier);
    expect(pending.state.length).toBeGreaterThan(10);
  });

  it('stores the tokens once the code is exchanged', async () => {
    const { bootstrap, secrets } = bootstrapWith(TOKEN);
    const pending = await bootstrap.begin();

    const tokens = await bootstrap.complete(pending, 'the-code', pending.state);
    expect(tokens.refreshToken).toBe('rt');

    const stored = secrets.values.get('MAIL_SENTINEL_JMAP_TOKENS');
    expect(stored).toContain('"refreshToken":"rt"');
  });

  it('refuses a callback whose state does not match the request', async () => {
    const { bootstrap } = bootstrapWith(TOKEN);
    const pending = await bootstrap.begin();

    await expect(bootstrap.complete(pending, 'the-code', 'someone-elses-state')).rejects.toThrow(
      /state mismatch/,
    );
  });

  it('refuses a grant with no refresh token, which cannot run unattended', async () => {
    const { bootstrap } = bootstrapWith({ access_token: 'at', expires_in: 3600 });
    const pending = await bootstrap.begin();

    await expect(bootstrap.complete(pending, 'c', pending.state)).rejects.toThrow(
      /offline_access/,
    );
  });
});

describe('adopting a refresh token obtained elsewhere', () => {
  it('redeems it immediately rather than trusting it blindly', async () => {
    const { bootstrap, secrets } = bootstrapWith({
      access_token: 'fresh',
      expires_in: 3600,
    });
    const tokens = await bootstrap.adoptRefreshToken('borrowed-token');

    expect(tokens.accessToken).toBe('fresh');
    // The provider returned no new refresh token, so the adopted one is kept.
    expect(secrets.values.get('MAIL_SENTINEL_JMAP_TOKENS')).toContain('borrowed-token');
  });

  it('surfaces a token the provider rejects, instead of storing it', async () => {
    const { bootstrap, secrets } = bootstrapWith({ error: 'invalid_grant' });
    await expect(bootstrap.adoptRefreshToken('stale')).rejects.toThrow(/invalid_grant/);
    expect(secrets.values.has('MAIL_SENTINEL_JMAP_TOKENS')).toBe(false);
  });
});

describe('refreshIfDue', () => {
  const expiring = {
    accessToken: 'old',
    refreshToken: 'rt',
    expiresAt: new Date('2026-08-28T12:00:00Z'),
    scope: 'openid',
  };

  it('leaves a valid token alone', async () => {
    const secrets = new Memory();
    secrets.values.set('MAIL_SENTINEL_JMAP_TOKENS', JSON.stringify(expiring));
    const { bootstrap } = bootstrapWith({ access_token: 'new', expires_in: 3600 }, secrets);

    const tokens = await bootstrap.refreshIfDue(new Date('2026-08-28T10:00:00Z'));
    expect(tokens?.accessToken).toBe('old');
  });

  it('renews when due and keeps the old refresh token if none was rotated', async () => {
    const secrets = new Memory();
    secrets.values.set('MAIL_SENTINEL_JMAP_TOKENS', JSON.stringify(expiring));
    const { bootstrap } = bootstrapWith({ access_token: 'new', expires_in: 3600 }, secrets);

    const tokens = await bootstrap.refreshIfDue(new Date('2026-08-28T12:30:00Z'));
    expect(tokens?.accessToken).toBe('new');
    expect(tokens?.refreshToken).toBe('rt');
  });

  it('reports nothing when no authorization exists', async () => {
    const { bootstrap } = bootstrapWith({});
    expect(await bootstrap.refreshIfDue()).toBeNull();
  });
});

describe('status', () => {
  it('describes the stored grant without disclosing any of it', async () => {
    const secrets = new Memory();
    secrets.values.set(
      'MAIL_SENTINEL_JMAP_TOKENS',
      JSON.stringify({
        accessToken: 'super-secret-access',
        refreshToken: 'super-secret-refresh',
        expiresAt: '2026-08-28T12:00:00Z',
        scope: 'openid offline_access',
      }),
    );
    const { bootstrap } = bootstrapWith({}, secrets);
    const status = await bootstrap.status(new Date('2026-08-28T10:00:00Z'));

    expect(JSON.stringify(status)).not.toContain('super-secret');
    expect(status).toMatchObject({ configured: true, expired: false, canRenew: true });
  });
});

// ---------------------------------------------------------------------------
// The .env store
// ---------------------------------------------------------------------------

describe('EnvFileStore', () => {
  async function store(): Promise<{ store: EnvFileStore; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-env-'));
    const path = join(dir, '.env');
    return { store: new EnvFileStore(path), path };
  }

  it('round-trips a value', async () => {
    const { store: s } = await store();
    await s.write('MAIL_SENTINEL_API_KEY', 'the-value');
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBe('the-value');
  });

  it('creates the file readable only by its owner', async () => {
    const { store: s, path } = await store();
    await s.write('MAIL_SENTINEL_API_KEY', 'v');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('replaces rather than appends, so a rotated secret has one definition', async () => {
    const { store: s, path } = await store();
    await s.write('MAIL_SENTINEL_API_KEY', 'first');
    await s.write('MAIL_SENTINEL_API_KEY', 'second');

    const text = await readFile(path, 'utf8');
    expect(text.match(/^MAIL_SENTINEL_API_KEY=/gm)).toHaveLength(1);
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBe('second');
  });

  it('leaves other entries and comments untouched', async () => {
    const { store: s, path } = await store();
    await writeFile(path, '# a comment\nOTHER=keep\nMAIL_SENTINEL_API_KEY=old\n', { mode: 0o600 });
    await s.write('MAIL_SENTINEL_API_KEY', 'new');

    const text = await readFile(path, 'utf8');
    expect(text).toContain('# a comment');
    expect(text).toContain('OTHER=keep');
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBe('new');
  });

  it('reads a quoted value without its quotes', async () => {
    const { store: s, path } = await store();
    await writeFile(path, 'MAIL_SENTINEL_API_KEY="quoted value"\n', { mode: 0o600 });
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBe('quoted value');
  });

  it('ignores a commented-out definition', async () => {
    const { store: s, path } = await store();
    await writeFile(path, '#MAIL_SENTINEL_API_KEY=commented\n', { mode: 0o600 });
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBeNull();
  });

  it('treats an empty value as absent, as the credential seam requires', async () => {
    const { store: s, path } = await store();
    await writeFile(path, 'MAIL_SENTINEL_API_KEY=\n', { mode: 0o600 });
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBeNull();
  });

  it('reports a missing file as no value rather than failing', async () => {
    const { store: s } = await store();
    expect(await s.read('MAIL_SENTINEL_API_KEY')).toBeNull();
  });

  it('refuses a name that decides how a process starts', async () => {
    const { store: s } = await store();
    await expect(s.write('PATH', '/tmp')).rejects.toThrow(/decides how a process starts/);
    await expect(s.write('DSH_HOME', '/tmp')).rejects.toThrow(/decides how a process starts/);
  });

  it('refuses anything that is not an environment-variable name', async () => {
    const { store: s } = await store();
    await expect(s.write('dsh:secret:jmap-oidc-client-id', 'v')).rejects.toThrow(
      /environment-variable name/,
    );
  });

  it('refuses a value that would forge a second entry', async () => {
    const { store: s } = await store();
    await expect(s.write('MAIL_SENTINEL_API_KEY', 'a\nOTHER=injected')).rejects.toThrow(
      /newline/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('the command line', () => {
  function io(env: Record<string, string | undefined> = {}): CliEnvironment & {
    lines: string[];
  } {
    const lines: string[] = [];
    return {
      lines,
      env: {
        MAIL_SENTINEL_OIDC_ISSUER: 'https://sso.example.com',
        MAIL_SENTINEL_OIDC_REDIRECT_URI: 'https://app.example.org/oauth/jmap/callback',
        ...env,
      },
      log: (line) => lines.push(line),
      readStdin: () => Promise.resolve(''),
    };
  }

  it('resolves the client secret reference only when one is configured', () => {
    expect(resolveConfig(io().env).clientSecretRef).toBeNull();
    expect(
      resolveConfig(io({ MAIL_SENTINEL_OIDC_CLIENT_SECRET: 'x' }).env).clientSecretRef,
    ).toBe('MAIL_SENTINEL_OIDC_CLIENT_SECRET');
  });

  it('refuses to run without a redirect that matches a registered one', () => {
    expect(() => resolveConfig({ MAIL_SENTINEL_OIDC_ISSUER: 'https://sso' })).toThrow(
      /REDIRECT_URI/,
    );
  });

  it('puts the env file under the harness home', () => {
    expect(envFilePath({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh/.env');
  });

  it('prints usage for an unknown command and fails', async () => {
    const context = io();
    const code = await run(['nonsense'], context);

    expect(code).toBe(2);
    expect(context.lines.join('\n')).toContain('usage: mail-auth');
  });

  it('explains itself before anything is configured', async () => {
    // An operator meeting the command has not set up a .env yet, so help
    // must not depend on one.
    const context: CliEnvironment & { lines: string[] } = {
      lines: [],
      env: {},
      log(line) {
        this.lines.push(line);
      },
      readStdin: () => Promise.resolve(''),
    };

    expect(await run(['--help'], context)).toBe(0);
    expect(context.lines.join('\n')).toContain('MAIL_SENTINEL_OIDC_ISSUER');
  });

  it('says what to do first when nothing is pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'));
    const context = io({ DSH_HOME: dir });
    const code = await run(['complete', 'code=abc'], context);

    expect(code).toBe(2);
    expect(context.lines.join('\n')).toContain('mail-auth begin');
  });

  it('reports an unauthorized status without failing hard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'));
    const context = io({ DSH_HOME: dir });

    expect(await run(['status'], context)).toBe(1);
    expect(context.lines.join('\n')).toContain('Not authorized');
  });

  it('refuses to adopt an empty token and explains the stdin form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'));
    const context = io({ DSH_HOME: dir });

    expect(await run(['adopt'], context)).toBe(2);
    expect(context.lines.join('\n')).toContain('stdin');
  });
});
