/**
 * Cordis plugin that turns the mail-core package into a mountable bundle.
 *
 * It builds a JMAP adapter, wraps it in the MailboxService, and registers the
 * mail_ping tool. Consumers reach the service as ctx.mailbox.
 */

import type { Context } from '@deepseek-ai/cordis';

import { MailboxService } from './mail-service.js';
import { JmapAdapter } from './adapters/jmap-adapter.js';
import { apply as registerMailPing } from './tools/mail-ping.js';

/** Plugin name used in the harness. */
export const name = 'dsh-mail-core';

/** Services this plugin injects. */
export const inject = ['tools'];

/** Plugin entry point. */
export function apply(ctx: Context, config: { accountIdEnv: string; identityIdEnv: string; sessionUrlEnv: string }): void {
  // Resolve environment variable names from config
  const accountIdEnv = config.accountIdEnv;
  const identityIdEnv = config.identityIdEnv;
  const sessionUrlEnv = config.sessionUrlEnv;

  // Build the JMAP transport that fetches session to get apiUrl, then POSTs with a bearer token
  const transport = {
    async request(body: unknown) {
      // Fetch the JMAP session to get the apiUrl
      const sessionUrl = process.env[sessionUrlEnv];
      if (!sessionUrl) {
        throw new Error(`${sessionUrlEnv} is not set`);
      }

      const tokensEnv = process.env.MAIL_SENTINEL_JMAP_TOKENS;
      if (!tokensEnv) {
        throw new Error('MAIL_SENTINEL_JMAP_TOKENS is not set');
      }

      let tokens: { accessToken: string };
      try {
        tokens = JSON.parse(tokensEnv) as { accessToken: string };
      } catch {
        throw new Error('MAIL_SENTINEL_JMAP_TOKENS is not valid JSON');
      }

      // Fetch session to get apiUrl
      const sessionResponse = await fetch(sessionUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });

      if (!sessionResponse.ok) {
        throw new Error(`JMAP session fetch failed: ${sessionResponse.status} ${sessionResponse.statusText}`);
      }

      const session = await sessionResponse.json() as { apiUrl: string };
      const apiUrl = session.apiUrl;

      // POST method calls to the apiUrl
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`JMAP request failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
  };

  // Build the JMAP adapter with account and identity from env using config variable names
  const accountId = process.env[accountIdEnv];
  const identityId = process.env[identityIdEnv];

  if (!accountId) {
    throw new Error(`${accountIdEnv} is not set`);
  }

  if (!identityId) {
    throw new Error(`${identityIdEnv} is not set`);
  }

  const adapter = new JmapAdapter({
    transport,
    accountId,
    identityId,
  });

  // Mount MailboxService so consumers reach it as ctx.mailbox
  ctx.plugin(MailboxService, adapter);

  // Register the mail_ping tool
  registerMailPing(ctx);
}
