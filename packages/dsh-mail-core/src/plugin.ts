/**
 * The Cordis plugin that makes this package a mountable bundle.
 *
 * It builds a JMAP adapter, exposes it as `ctx.mailbox`, and registers the
 * `mail_ping` tool. The row that mounts it must name the `./plugin` subpath
 * export: the package root resolves to `index.js`, which exports no `apply`.
 */

import type { Context } from '@deepseek-ai/cordis';

import { JmapAdapter, type JmapTransport } from './adapters/jmap-adapter.js';
import { MailboxService } from './mail-service.js';
import * as mailPing from './tools/mail-ping.js';

/**
 * Configuration carries environment-variable *names*, never values: the
 * harness credential seam addresses secrets by name and resolves them.
 */
export interface MailCoreConfig {
  readonly accountIdEnv: string;
  readonly identityIdEnv: string;
  readonly sessionUrlEnv: string;
  /** Holds the stored token record; `accessToken` is the bearer. */
  readonly tokensEnv?: string | undefined;
}

export const DEFAULT_TOKENS_ENV = 'MAIL_SENTINEL_JMAP_TOKENS';

export const name = 'dsh-mail-core';

export const inject = ['tools'];

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A transport over the JMAP session resource.
 *
 * The session is fetched once and its `apiUrl` cached. RFC 8620 section 2
 * makes the session a discovery document, not a per-call endpoint; fetching it
 * on every method call would double the round trips of every operation the
 * agent performs.
 *
 * The bearer is read at call time rather than captured, so a refreshed token
 * takes effect without rebuilding the transport.
 */
export function createJmapTransport(
  config: MailCoreConfig,
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): JmapTransport {
  const tokensEnv = config.tokensEnv ?? DEFAULT_TOKENS_ENV;
  let apiUrl: string | null = null;

  const bearer = (): string => {
    const raw = env[tokensEnv];
    if (raw === undefined || raw.length === 0) throw new Error(`${tokensEnv} is not set`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The value is a credential record: report the shape, never the content.
      throw new Error(`${tokensEnv} is not valid JSON`);
    }
    const token =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['accessToken']
        : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`${tokensEnv} holds no accessToken`);
    }
    return token;
  };

  const resolveApiUrl = async (token: string): Promise<string> => {
    if (apiUrl !== null) return apiUrl;

    const sessionUrl = env[config.sessionUrlEnv];
    if (sessionUrl === undefined || sessionUrl.length === 0) {
      throw new Error(`${config.sessionUrlEnv} is not set`);
    }

    const response = await fetcher(sessionUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`JMAP session fetch returned ${String(response.status)}`);
    }

    const session: unknown = await response.json();
    const found =
      typeof session === 'object' && session !== null
        ? (session as Record<string, unknown>)['apiUrl']
        : undefined;
    if (typeof found !== 'string' || found.length === 0) {
      throw new Error('JMAP session carried no apiUrl');
    }

    apiUrl = found;
    return found;
  };

  return {
    async request(body): Promise<unknown> {
      const token = bearer();
      const url = await resolveApiUrl(token);

      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // A stale session can outlive its apiUrl; drop the cache so the next
        // call rediscovers rather than repeating a dead endpoint forever.
        if (response.status === 404 || response.status === 410) apiUrl = null;
        throw new Error(`JMAP request returned ${String(response.status)}`);
      }
      return response.json();
    },
  };
}

export function apply(ctx: Context, config: MailCoreConfig): void {
  const accountId = process.env[config.accountIdEnv];
  const identityId = process.env[config.identityIdEnv];
  if (accountId === undefined || accountId.length === 0) {
    throw new Error(`${config.accountIdEnv} is not set`);
  }
  if (identityId === undefined || identityId.length === 0) {
    throw new Error(`${config.identityIdEnv} is not set`);
  }

  const adapter = new JmapAdapter({
    transport: createJmapTransport(config),
    accountId,
    identityId,
  });

  ctx.plugin(MailboxService, adapter);
  // Mounted, not called: the tool declares `inject: ['tools', 'mailbox']`, and
  // a plain call runs it against this plugin's context, which injects neither.
  // The handler then fails at first use with `cannot get property "mailbox"
  // without inject` — at call time, long after a clean boot.
  ctx.plugin(mailPing);
}
