/**
 * An OpenAI-compatible endpoint as a harness LLM adapter.
 *
 * One adapter instance serves several provider routes, which is what lets the
 * four tiers of the PRD point at the same gateway with different call
 * defaults. Nothing about the gateway is hard-coded: base URL, model and
 * credential all arrive through configuration.
 */

import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';

import { serializeRequest, type ReasoningSettings } from './serialize.js';
import { DONE, parseSse } from './sse.js';
import { StreamTranslator } from './translate.js';

/** One tier: an endpoint, a model, and the call defaults that tier implies. */
export interface EndpointRoute {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly supportsStop?: boolean | undefined;
  readonly supportsTools?: boolean | undefined;
  /**
   * Selectable reasoning levels, when the route's model has any.
   *
   * Absent for an ordinary instruct model, which is every model the sovereign
   * gateway currently serves. Declaring it is what turns a reasoning model
   * into a configuration change rather than an adapter change.
   */
  readonly reasoning?: ReasoningSettings | undefined;
  /**
   * Other route keys to try, in order, when this one cannot answer.
   *
   * Empty today: the sovereign gateway serves one model that can drive a
   * loop, so there is nowhere to fall over to. The chain exists so that
   * gaining a second route is a configuration edit.
   */
  readonly fallback?: readonly string[] | undefined;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAiAdapterOptions {
  /** Provider route key to its endpoint configuration. */
  readonly routes: ReadonlyMap<string, EndpointRoute>;
  /**
   * Hosts the adapter is permitted to reach. An empty list means no
   * restriction; a non-empty one is enforced before any request leaves.
   */
  readonly trustedEndpoints?: readonly string[] | undefined;
  readonly fetcher?: Fetcher | undefined;
  /**
   * Observability hook: which route actually answered, and after how many
   * failed attempts. An operator needs to know a fallback served a call.
   */
  readonly onRouteSelected?: ((event: RouteSelection) => void) | undefined;
}

export interface RouteSelection {
  readonly requested: string;
  readonly served: string;
  /** Routes that failed before this one answered, in order. */
  readonly attempted: readonly string[];
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAiEndpointAdapter extends LlmAdapter {
  readonly #routes: ReadonlyMap<string, EndpointRoute>;
  readonly #trusted: readonly string[];
  readonly #fetch: Fetcher;
  readonly #onRouteSelected: ((event: RouteSelection) => void) | undefined;

  constructor(options: OpenAiAdapterOptions) {
    super();
    this.#routes = options.routes;
    this.#trusted = options.trustedEndpoints ?? [];
    this.#fetch = options.fetcher ?? ((url, init) => fetch(url, init));
    this.#onRouteSelected = options.onRouteSelected;

    for (const [provider, route] of this.#routes) {
      assertTrusted(route.baseUrl, this.#trusted, provider);
    }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.#routes.get(provider);
    if (route === undefined) return Promise.resolve([]);
    return Promise.resolve([{ provider, id: route.model, name: route.model }]);
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = this.#routes.get(provider);
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(route?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: route.contextWindow } }),
      ...(route?.maxTokens === undefined ? {} : { defaultMaxTokens: route.maxTokens }),
      ...(route?.reasoning === undefined
        ? {}
        : {
            reasoning: {
              efforts: route.reasoning.efforts,
              ...(route.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: route.reasoning.defaultEffort }),
            },
          }),
    });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chain = this.#chain(options.provider);
    const attempted: string[] = [];

    for (const [position, key] of chain.entries()) {
      const route = this.#routes.get(key);
      if (route === undefined) {
        throw new LlmError(`No endpoint configured for ${key}`, 'UNKNOWN_PROVIDER');
      }
      const isLast = position === chain.length - 1;

      const body = serializeRequest(
        { ...options, maxTokens: options.maxTokens ?? route.maxTokens },
        {
          model: route.model,
          ...(route.supportsStop === undefined ? {} : { supportsStop: route.supportsStop }),
          ...(route.supportsTools === undefined ? {} : { supportsTools: route.supportsTools }),
          ...(route.reasoning === undefined ? {} : { reasoning: route.reasoning }),
        },
      );

      // Once a chunk reaches the caller this route owns the answer: a later
      // route would repeat content the loop has already consumed. Falling
      // over is therefore only legal before the first emission.
      let emitted = false;
      try {
        for await (const chunk of this.#attempt(route, body, options.signal)) {
          if (!emitted) {
            emitted = true;
            this.#announce(options.provider, key, attempted);
          }
          yield chunk;
        }
        if (!emitted) this.#announce(options.provider, key, attempted);
        return;
      } catch (error: unknown) {
        if (emitted) throw error;
        if (options.signal?.aborted === true) throw error;
        if (isLast || !fallsOver(error)) throw error;
        attempted.push(key);
      }
    }
  }

  /** The requested route followed by its declared fallbacks, deduplicated. */
  #chain(provider: string): string[] {
    const route = this.#routes.get(provider);
    const chain = [provider, ...(route?.fallback ?? [])];
    return [...new Set(chain)];
  }

  #announce(requested: string, served: string, attempted: readonly string[]): void {
    if (attempted.length === 0 && requested === served) return;
    this.#onRouteSelected?.({ requested, served, attempted: [...attempted] });
  }

  /** One route attempt, with its own deadline. */
  async *#attempt(
    route: EndpointRoute,
    body: unknown,
    callerSignal: AbortSignal | undefined,
  ): AsyncGenerator<StreamChunk> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => {
      deadline.abort(new LlmError('Endpoint timed out', 'TIMEOUT'));
    }, route.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => {
      deadline.abort(callerSignal?.reason);
    };
    callerSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#send(route, body, deadline.signal);
      yield* readStream(response);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }

  async #send(route: EndpointRoute, body: unknown, signal: AbortSignal): Promise<Response> {
    const url = `${route.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        signal,
        headers: {
          // Attribution is required of every provider request by the seam.
          ...attributionHeaders(),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${route.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      if (error instanceof LlmError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new LlmError(`Endpoint unreachable: ${message}`, 'NETWORK', { cause: error });
    }

    if (!response.ok) {
      // An upstream that echoes the request would put the bearer in its own
      // error body, so the excerpt is redacted before it becomes a message
      // that a log or a session transcript will keep.
      const body = (await response.text().catch(() => '')).slice(0, 200);
      const detail = redactSecret(body, route.apiKey);
      // The status is carried by the code, not by a field: the seam routes on
      // `code` alone, and a 5xx is a different failure class from a 4xx.
      throw new LlmError(
        `Endpoint returned ${String(response.status)}: ${detail}`,
        statusCode(response.status),
      );
    }
    if (response.body === null) {
      throw new LlmError('Endpoint returned no body', 'STREAM_CLOSED');
    }
    return response;
  }
}

async function* readStream(response: Response): AsyncGenerator<StreamChunk> {
  const translator = new StreamTranslator();
  const body = response.body;
  if (body === null) throw new LlmError('Endpoint returned no body', 'STREAM_CLOSED');

  let sawDone = false;
  for await (const payload of parseSse(body)) {
    if (payload === DONE) {
      sawDone = true;
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // One unparsable frame is not worth failing a call the rest of which
      // arrived intact.
      continue;
    }
    yield* translator.accept(parsed);
  }

  // A provider may end the stream without the sentinel. That is complete when
  // it already told us why generation stopped, and truncation when it did not:
  // acting on half a classification is worse than reporting a failed call.
  if (!sawDone && !translator.sawFinishReason) {
    throw new LlmError(
      'SSE stream ended mid-generation, with no finish reason',
      'STREAM_CLOSED',
    );
  }
  yield* translator.flush();
}

/**
 * Whether a failure is worth trying another route for.
 *
 * A transport failure or an overloaded endpoint may well be answered by a
 * different one. A rejected request, an unsupported option or a configuration
 * error would fail identically everywhere, so retrying only wastes a call and
 * delays the real error reaching the caller.
 */
export function fallsOver(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false;

  switch (error.code) {
    case 'NETWORK':
    case 'TIMEOUT':
    case 'STREAM_CLOSED':
    case 'RATE_LIMIT':
      return true;
    case 'PROVIDER_UNAVAILABLE':
      return true;
    // PROVIDER_ERROR is a 4xx: the request itself is wrong, and another
    // endpoint would reject it the same way.
    default:
      return false;
  }
}

/**
 * The failure class for an HTTP status.
 *
 * A 5xx is the endpoint failing and worth another route; a 4xx is the request
 * being wrong and worth none.
 */
export function statusCode(status: number): string {
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

/**
 * Remove a credential from text that is about to become an error message.
 *
 * Short values are left alone: a two-character key is not plausibly a
 * credential, and blanking every occurrence of it would mangle the message
 * without protecting anything.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 8) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * Refuse an endpoint outside the allow-list.
 *
 * The PRD makes a sovereignty claim about where mail content goes. A typo in
 * a base URL would quietly break it, so the check runs at construction and
 * fails the plugin rather than the first request.
 */
export function assertTrusted(
  baseUrl: string,
  trusted: readonly string[],
  provider: string,
): void {
  if (trusted.length === 0) return;

  const allowed = trusted.some((prefix) => {
    const normalized = prefix.replace(/\/+$/, '');
    return baseUrl === normalized || baseUrl.startsWith(`${normalized}/`);
  });
  if (!allowed) {
    throw new LlmError(
      `Endpoint for ${provider} is not in trusted_endpoints_only: ${baseUrl}`,
      'UNTRUSTED_ENDPOINT',
    );
  }
}
