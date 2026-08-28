/**
 * The `mail_ping` debug tool.
 *
 * It answers the first question asked of any deployment: is an adapter
 * mounted, does it reach its server, and what can it do? The capability set it
 * returns is the same one the service branches on, so an operator reading this
 * output sees exactly what the tools will see.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type { Capabilities } from '../types.js';

export const name = 'mail-ping';
export const inject = ['tools', 'mailbox'];

/** Which adapter is mounted, derived from how it delivers push. */
export type AdapterKind = 'jmap' | 'imap';

export function adapterKind(capabilities: Capabilities): AdapterKind {
  return capabilities.push === 'jmap-push-subscription' ? 'jmap' : 'imap';
}

export interface MailPingResult {
  readonly adapter: AdapterKind;
  readonly capabilities: Capabilities;
  readonly latencyMs: number;
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'mail_ping',
      description:
        'Check that the mounted mail adapter answers its server, and report which ' +
        'adapter it is, what it is capable of, and how long the round trip took.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            adapter: { type: 'string', required: true },
            capabilities: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                push: { type: 'string', required: true },
                customKeywords: { type: 'boolean', required: true },
                threadNative: { type: 'boolean', required: true },
                spamHeaders: { type: 'boolean', required: true },
              },
            },
            latencyMs: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: describe(value) }],
      },
      async execute(_args, exec) {
        const started = performance.now();
        // listFolders is the cheapest call that proves the server answered
        // rather than that an object exists.
        await ctx.mailbox.listFolders();
        exec.signal.throwIfAborted();

        return {
          adapter: adapterKind(ctx.mailbox.capabilities),
          capabilities: ctx.mailbox.capabilities,
          latencyMs: Math.round(performance.now() - started),
        } satisfies MailPingResult;
      },
    }),
  );
}

/**
 * What the renderer actually receives.
 *
 * `output.schema` declares `adapter` as a string, so the value handed to
 * `render` is wider than {@link MailPingResult}. Typing the renderer against
 * the schema rather than the domain keeps the two honest about each other.
 */
interface MailPingWire {
  readonly adapter: string;
  readonly capabilities: {
    readonly push: string;
    readonly customKeywords: boolean;
    readonly threadNative: boolean;
    readonly spamHeaders: boolean;
  };
  readonly latencyMs: number;
}

function describe(result: MailPingWire): string {
  const { capabilities: caps } = result;
  const supports = [
    caps.customKeywords ? 'custom keywords' : 'no custom keywords',
    caps.threadNative ? 'native threads' : 'reconstructed threads',
    caps.spamHeaders ? 'spam headers' : 'no spam headers',
  ].join(', ');

  return `${result.adapter} adapter answered in ${String(result.latencyMs)} ms (push: ${caps.push}; ${supports})`;
}
