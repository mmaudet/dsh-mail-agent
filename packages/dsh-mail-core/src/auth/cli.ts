/**
 * `mail-auth` — the one-off JMAP authorisation, from a terminal.
 *
 * Four subcommands mapping to the steps a person actually takes:
 *
 *     mail-auth begin                 print the URL to open
 *     mail-auth complete <pasted>     exchange the code that came back
 *     mail-auth adopt <refresh>       adopt a refresh token obtained elsewhere
 *     mail-auth status                what is stored, without disclosing it
 *
 * No secret is ever printed, and none is accepted as a command-line argument
 * where a process listing would expose it: `adopt` reads its token from stdin.
 */

import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  JmapBootstrap,
  createHttpClient,
  parseCallback,
  type PendingAuthorization,
} from './bootstrap.js';
import { EnvFileStore } from './env-store.js';
import type { OidcConfig } from './oidc-jmap.js';

/** Where the pending request waits while the operator is in a browser. */
const PENDING_REF = 'MAIL_SENTINEL_OIDC_PENDING';
const TOKENS_REF = 'MAIL_SENTINEL_JMAP_TOKENS';

export interface CliEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly readStdin: () => Promise<string>;
}

export function resolveConfig(env: Readonly<Record<string, string | undefined>>): OidcConfig {
  const issuer = env['MAIL_SENTINEL_OIDC_ISSUER'];
  const redirectUri = env['MAIL_SENTINEL_OIDC_REDIRECT_URI'];
  if (issuer === undefined || redirectUri === undefined) {
    throw new Error(
      'MAIL_SENTINEL_OIDC_ISSUER and MAIL_SENTINEL_OIDC_REDIRECT_URI must be set; '
        + 'the redirect must match one registered for this client',
    );
  }
  return {
    issuer,
    redirectUri,
    clientIdRef: 'MAIL_SENTINEL_OIDC_CLIENT_ID',
    clientSecretRef:
      env['MAIL_SENTINEL_OIDC_CLIENT_SECRET'] === undefined
        ? null
        : 'MAIL_SENTINEL_OIDC_CLIENT_SECRET',
    scopes: (env['MAIL_SENTINEL_OIDC_SCOPES'] ?? 'openid profile email offline_access').split(' '),
  };
}

export function envFilePath(env: Readonly<Record<string, string | undefined>>): string {
  return join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), '.env');
}

const USAGE = [
  'usage: mail-auth <command>',
  '',
  '  begin               print the URL to open in a browser',
  '  complete <pasted>   exchange the code that came back',
  '  adopt               adopt a refresh token, read from stdin',
  '  refresh             renew the access token, no browser',
  '  status              what is stored, without disclosing it',
  '',
  'Configuration comes from $DSH_HOME/.env:',
  '  MAIL_SENTINEL_OIDC_ISSUER, MAIL_SENTINEL_OIDC_REDIRECT_URI,',
  '  MAIL_SENTINEL_OIDC_CLIENT_ID, MAIL_SENTINEL_OIDC_CLIENT_SECRET (optional)',
];

export async function run(argv: readonly string[], io: CliEnvironment): Promise<number> {
  const [command, ...rest] = argv;

  // Usage must work before configuration does: an operator discovering the
  // command has not set anything up yet.
  if (command === undefined || command === '--help' || command === '-h') {
    for (const line of USAGE) io.log(line);
    return 0;
  }
  if (!['begin', 'complete', 'adopt', 'refresh', 'status'].includes(command)) {
    for (const line of USAGE) io.log(line);
    return 2;
  }

  const secrets = new EnvFileStore(envFilePath(io.env));
  const bootstrap = new JmapBootstrap({
    config: resolveConfig(io.env),
    secrets,
    http: createHttpClient(),
    tokensRef: TOKENS_REF,
  });

  switch (command) {
    case 'begin': {
      const pending = await bootstrap.begin();
      await secrets.write(PENDING_REF, JSON.stringify(pending));
      io.log('Open this URL, authenticate, then run `mail-auth complete <what came back>`:');
      io.log('');
      io.log(pending.url);
      io.log('');
      io.log('The redirect may well show an error page. That is fine: the code is in');
      io.log('the address bar, and nothing else consumes it. Paste the whole URL.');
      return 0;
    }

    case 'complete': {
      const raw = rest.join(' ').trim();
      const parsed = raw.length > 0 ? parseCallback(raw) : parseCallback(await io.readStdin());
      if (parsed === null) {
        io.log('Could not find a code in that. Paste the whole redirect URL.');
        return 2;
      }

      const stored = await secrets.read(PENDING_REF);
      if (stored === null) {
        io.log('No pending authorization. Run `mail-auth begin` first.');
        return 2;
      }
      const pending = JSON.parse(stored) as PendingAuthorization;

      const tokens = await bootstrap.complete(pending, parsed.code, parsed.state ?? pending.state);
      await secrets.delete(PENDING_REF);
      io.log(`Authorized. Access token valid until ${tokens.expiresAt.toISOString()}.`);
      io.log('A refresh token is stored; the agent renews without a browser from here.');
      return 0;
    }

    case 'adopt': {
      // Read from stdin, never argv: a command line is visible in the process
      // table to every user on the host.
      const token = (await io.readStdin()).trim();
      if (token.length === 0) {
        io.log('Provide the refresh token on stdin, for example:');
        io.log('  mail-auth adopt < token.txt');
        return 2;
      }
      const tokens = await bootstrap.adoptRefreshToken(token);
      io.log(`Adopted. Access token valid until ${tokens.expiresAt.toISOString()}.`);
      return 0;
    }

    case 'refresh': {
      // The capability existed and nothing invoked it: `status` has been
      // reporting "renews without a browser" while the only paths that renew
      // were a fresh authorization or adopting a token by hand.
      const tokens = await bootstrap.refreshIfDue();
      if (tokens === null) {
        io.log('Nothing to renew: no stored token, or no refresh token to use.');
        io.log('Run `mail-auth begin`.');
        return 1;
      }
      io.log(`Access token valid until ${tokens.expiresAt.toISOString()}.`);
      return 0;
    }

    case 'status': {
      const status = await bootstrap.status();
      if (!status.configured) {
        io.log('Not authorized. Run `mail-auth begin`.');
        return 1;
      }
      io.log(`Authorized, scope: ${status.scope || '(none reported)'}`);
      io.log(`Access token ${status.expired ? 'expired' : 'valid'} at ${status.expiresAt.toISOString()}`);
      io.log(status.canRenew ? 'Renews without a browser.' : 'No refresh token: re-authorization needed.');
      return status.expired && !status.canRenew ? 1 : 0;
    }

    default:
      // Unreachable: the command was validated above.
      return 2;
  }
}

/** Read all of stdin; empty when it is a terminal with nothing piped. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question('Paste it here: ');
    } finally {
      rl.close();
    }
  }
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts).toString('utf8');
}
