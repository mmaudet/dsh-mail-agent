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

import { serializeRequest } from './serialize.js';
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
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAiEndpointAdapter extends LlmAdapter {
  readonly #routes: ReadonlyMap<string, EndpointRoute>;
  readonly #trusted: readonly string[];
  readonly #fetch: Fetcher;

  constructor(options: OpenAiAdapterOptions) {
    super();
    this.#routes = options.routes;
    this.#trusted = options.trustedEndpoints ?? [];
    this.#fetch = options.fetcher ?? ((url, init) => fetch(url, init));

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
    });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.#routes.get(options.provider);
    if (route === undefined) {
      throw new LlmError(`No endpoint configured for ${options.provider}`, 'UNKNOWN_PROVIDER');
    }

    const body = serializeRequest(
      { ...options, maxTokens: options.maxTokens ?? route.maxTokens },
      {
        model: route.model,
        ...(route.supportsStop === undefined ? {} : { supportsStop: route.supportsStop }),
        ...(route.supportsTools === undefined ? {} : { supportsTools: route.supportsTools }),
      },
    );

    // The caller's cancellation and the route deadline both end the request;
    // whichever fires first wins, and the caller's own reason is preserved.
    const deadline = new AbortController();
    const timeout = setTimeout(() => {
      deadline.abort(new LlmError('Endpoint timed out', 'TIMEOUT'));
    }, route.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => {
      deadline.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#send(route, body, deadline.signal);
      yield* readStream(response);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
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
      throw new LlmError(
        `Endpoint returned ${String(response.status)}: ${detail}`,
        response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR',
        { status: response.status },
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

  for await (const payload of parseSse(body)) {
    if (payload === DONE) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A single unparsable frame is not worth failing the call; the stream
      // still ends on [DONE], and a truncated stream is caught there.
      continue;
    }
    yield* translator.accept(parsed);
  }
  yield* translator.flush();
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
