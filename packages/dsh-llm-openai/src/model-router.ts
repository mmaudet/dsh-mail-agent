/**
 * The four call tiers.
 *
 * A tier is a provider route with its own call defaults, not a separate
 * endpoint or a separate model: the V1 gateway serves one model, and the tiers
 * differ only in how much they are allowed to spend on a call. Keeping them as
 * distinct routes means a later phase can repoint one tier at another model by
 * editing configuration, with no consumer change.
 */

import type { ReasoningSettings } from './serialize.js';
import type { EndpointRoute } from './openai-endpoint.js';

/** Ordered cheapest to most expensive; the cascade escalates along this order. */
export const TIERS = ['economy', 'default', 'chat', 'draft'] as const;

export type Tier = (typeof TIERS)[number];

export function toTier(raw: string): Tier | null {
  return (TIERS as readonly string[]).includes(raw)
    ? (raw as Tier) // SAFETY: membership confirmed above
    : null;
}

/** Output caps per tier when configuration does not state one (PRD section 3.6). */
export const DEFAULT_MAX_TOKENS: Readonly<Record<Tier, number>> = {
  economy: 512,
  default: 1024,
  chat: 2048,
  draft: 2048,
};

export interface TierConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly reasoning?: ReasoningSettings | undefined;
  readonly providerRouting?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Build the provider-route table an adapter instance serves.
 *
 * Route keys are prefixed so they cannot collide with a provider another
 * adapter owns: the harness registry rejects duplicate routes outright, and a
 * bare `chat` would be an obvious candidate for a clash.
 */
export function buildRoutes(
  tiers: Partial<Record<Tier, TierConfig>>,
  prefix = 'mail-llm',
): Map<string, EndpointRoute> {
  const routes = new Map<string, EndpointRoute>();

  for (const tier of TIERS) {
    const config = tiers[tier];
    if (config === undefined) continue;
    routes.set(routeKey(tier, prefix), {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS[tier],
      timeoutMs: config.timeoutMs,
      contextWindow: config.contextWindow,
      reasoning: config.reasoning,
      providerRouting: config.providerRouting,
    });
  }
  return routes;
}

export function routeKey(tier: Tier, prefix = 'mail-llm'): string {
  return `${prefix}-${tier}`;
}

/**
 * The next tier up, or `null` at the top.
 *
 * The cascade escalates only on a decision it cannot make cheaply; the KPI is
 * how rarely this is called at all.
 */
export function escalate(tier: Tier): Tier | null {
  const index = TIERS.indexOf(tier);
  return TIERS[index + 1] ?? null;
}
