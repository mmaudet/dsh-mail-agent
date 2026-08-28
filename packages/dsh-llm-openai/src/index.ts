/**
 * OpenAI-compatible LLM adapter for the DSH mail agent.
 *
 * Mounted as an ordinary Cordis plugin: it registers one adapter instance on
 * `ctx.llm` serving the four call tiers. Registration is effect-based, so
 * unloading the plugin releases every route.
 *
 * Credentials arrive as environment-variable references resolved at boot, the
 * convention the harness credential seam uses. No value is ever written into
 * configuration.
 */

import type { Context } from '@deepseek-ai/cordis';

import type { ReasoningSettings } from './serialize.js';
import {
  DEFAULT_MAX_TOKENS,
  TIERS,
  buildRoutes,
  escalate,
  routeKey,
  toTier,
  type Tier,
  type TierConfig,
} from './model-router.js';
import {
  DEFAULT_TIMEOUT_MS,
  OpenAiEndpointAdapter,
  assertTrusted,
  type EndpointRoute,
  type Fetcher,
  type OpenAiAdapterOptions,
} from './openai-endpoint.js';

export const BUNDLE_ID = '@dsh-mail-agent/llm-openai' as const;

export type BundleId = typeof BUNDLE_ID;

export interface TierSettings {
  readonly baseUrl?: string;
  readonly model?: string;
  /**
   * Reasoning levels this tier's model offers, when it offers any.
   *
   * No model on the sovereign gateway does today, so this stays absent; it is
   * the seam through which one arrives without touching the adapter.
   */
  readonly reasoning?: ReasoningSettings;
  /** Name of the environment variable holding the bearer token. */
  readonly apiKeyEnv?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly contextWindow?: number;
}

export interface OpenAiPluginConfig {
  /** Defaults every tier inherits unless it overrides them. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly timeoutMs?: number;
  readonly providerPrefix?: string;
  /** Endpoints the adapter may reach; empty disables the check. */
  readonly trustedEndpoints?: readonly string[];
  readonly tiers?: Partial<Record<Tier, TierSettings>>;
}

export const name = 'dsh-mail-llm-openai';
export const inject = ['llm'];

/**
 * Resolve configuration into the routes the adapter will serve.
 *
 * Separated from `apply` so it can be exercised without a live context: this
 * is where a missing credential or an untrusted endpoint is caught, and both
 * should fail the boot loudly rather than the first model call quietly.
 */
export function resolveRoutes(
  config: OpenAiPluginConfig,
  env: Readonly<Record<string, string | undefined>>,
): Map<string, EndpointRoute> {
  const tiers: Partial<Record<Tier, TierConfig>> = {};

  for (const tier of TIERS) {
    const settings = config.tiers?.[tier] ?? {};
    const apiKeyEnv = settings.apiKeyEnv ?? config.apiKeyEnv;
    const apiKey = env[apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`${apiKeyEnv} is not set; tier ${tier} has no credential`);
    }
    tiers[tier] = {
      baseUrl: settings.baseUrl ?? config.baseUrl,
      model: settings.model ?? config.model,
      apiKey,
      maxTokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS[tier],
      timeoutMs: settings.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      contextWindow: settings.contextWindow,
      reasoning: settings.reasoning,
    };
  }

  const routes = buildRoutes(tiers, config.providerPrefix);
  const trusted = config.trustedEndpoints ?? [];
  for (const [provider, route] of routes) assertTrusted(route.baseUrl, trusted, provider);
  return routes;
}

export function apply(ctx: Context, config: OpenAiPluginConfig): void {
  const routes = resolveRoutes(config, process.env);
  const adapter = new OpenAiEndpointAdapter({
    routes,
    trustedEndpoints: config.trustedEndpoints,
  });

  ctx.llm.registerAdapter([...routes.keys()], adapter);
}

export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  OpenAiEndpointAdapter,
  TIERS,
  assertTrusted,
  buildRoutes,
  escalate,
  routeKey,
  toTier,
  type EndpointRoute,
  type Fetcher,
  type OpenAiAdapterOptions,
  type Tier,
  type TierConfig,
};
export { StreamTranslator } from './translate.js';
export {
  serializeRequest,
  type ReasoningSettings,
  type SerializeOptions,
  type SerializedRequest,
} from './serialize.js';
export { DONE, parseSse } from './sse.js';
export type * from './wire.js';
