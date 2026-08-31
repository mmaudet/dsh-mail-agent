import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MAX_TOKENS, TIERS, buildRoutes, escalate, routeKey, toTier } from './model-router.js';
import {
  OpenAiEndpointAdapter,
  assertTrusted,
  type EndpointRoute,
  type Fetcher,
  type RouteSelection,
} from './openai-endpoint.js';
import { resolveRoutes, type OpenAiPluginConfig } from './index.js';
import { serializeRequest } from './serialize.js';
import { StreamTranslator } from './translate.js';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';

const GATEWAY = 'https://inference.linagora.com/v1/';
const MODEL = 'Mistral-Small-3.2-24B-Instruct-2506-FP8';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function message(role: Message['role'], content: Message['content']): Message {
  return { id: 'm1' as Message['id'], role, content, source: { kind: 'user' } };
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'mail-llm-economy',
    model: MODEL,
    messages: [message('user', [{ type: 'text', text: 'Bonjour' }])],
    ...overrides,
  };
}

/** Frame payloads as an SSE byte stream, the way the gateway does. */
function sseStream(...payloads: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      controller.close();
    },
  });
}

function chunk(delta: unknown, finish: string | null = null): string {
  return JSON.stringify({ choices: [{ delta, finish_reason: finish }] });
}

function route(overrides: Partial<EndpointRoute> = {}): EndpointRoute {
  return { baseUrl: GATEWAY, model: MODEL, apiKey: 'bearer-value', ...overrides };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const item of stream) chunks.push(item);
  return chunks;
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

describe('tiers', () => {
  it('orders the four tiers cheapest first', () => {
    expect(TIERS).toStrictEqual(['economy', 'default', 'chat', 'draft']);
  });

  it('caps output per tier as the PRD specifies', () => {
    expect(DEFAULT_MAX_TOKENS).toStrictEqual({
      economy: 512,
      default: 1024,
      chat: 2048,
      draft: 2048,
    });
  });

  it('escalates along that order and stops at the top', () => {
    expect(escalate('economy')).toBe('default');
    expect(escalate('chat')).toBe('draft');
    expect(escalate('draft')).toBeNull();
  });

  it('narrows an untrusted string to a tier', () => {
    expect(toTier('draft')).toBe('draft');
    expect(toTier('premium')).toBeNull();
  });

  it('prefixes route keys so they cannot collide with another adapter', () => {
    expect(routeKey('economy')).toBe('mail-llm-economy');
    const routes = buildRoutes({ economy: { baseUrl: GATEWAY, model: MODEL, apiKey: 'k' } });
    expect([...routes.keys()]).toStrictEqual(['mail-llm-economy']);
  });
});

// ---------------------------------------------------------------------------
// Trusted endpoints
// ---------------------------------------------------------------------------

describe('trusted_endpoints_only', () => {
  it('accepts the configured gateway', () => {
    expect(() => {
      assertTrusted(GATEWAY, [GATEWAY], 'mail-llm-economy');
    }).not.toThrow();
  });

  it('rejects anything else, which is the sovereignty claim', () => {
    expect(() => {
      assertTrusted('https://api.openai.com/v1', [GATEWAY], 'mail-llm-economy');
    }).toThrow(/not in trusted_endpoints_only/);
  });

  it('is not fooled by a prefix that only looks like the gateway host', () => {
    expect(() => {
      assertTrusted('https://inference.linagora.com.evil.test/v1', [GATEWAY], 'x');
    }).toThrow(/not in trusted_endpoints_only/);
  });

  it('imposes no restriction when the list is empty', () => {
    expect(() => {
      assertTrusted('https://anything.test', [], 'x');
    }).not.toThrow();
  });

  it('refuses to construct an adapter pointing off the list', () => {
    expect(
      () =>
        new OpenAiEndpointAdapter({
          routes: new Map([['mail-llm-economy', route({ baseUrl: 'https://api.openai.com/v1' })]]),
          trustedEndpoints: [GATEWAY],
        }),
    ).toThrow(/not in trusted_endpoints_only/);
  });
});

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------

describe('serializeRequest', () => {
  it('asks for a stream with usage on the final chunk', () => {
    const body = serializeRequest(options(), { model: MODEL });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toStrictEqual({ include_usage: true });
  });

  it('puts the system prompt in the system slot, first', () => {
    const body = serializeRequest(options({ system: 'Tu es un agent mail.' }), { model: MODEL });
    expect(body.messages[0]).toStrictEqual({ role: 'system', content: 'Tu es un agent mail.' });
  });

  it('sends a tool result as its own tool-role message keyed by call id', () => {
    const body = serializeRequest(
      options({
        messages: [
          message('user', [
            {
              type: 'tool-result',
              toolCallId: 'call-1' as never,
              content: [{ type: 'text', text: 'ok' }],
            },
          ]),
        ],
      }),
      { model: MODEL },
    );
    expect(body.messages).toStrictEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ]);
  });

  it('keeps tool-call arguments as the raw JSON string the model produced', () => {
    const body = serializeRequest(
      options({
        messages: [
          message('assistant', [
            { type: 'tool-call', id: 'c1' as never, name: 'classify', arguments: '{"id":"e1"}' },
          ]),
        ],
      }),
      { model: MODEL },
    );
    expect(body.messages[0]?.tool_calls?.[0]?.function.arguments).toBe('{"id":"e1"}');
  });

  it('does not replay reasoning back to the endpoint', () => {
    const body = serializeRequest(
      options({
        messages: [
          message('assistant', [
            { type: 'reasoning', text: 'hidden' },
            { type: 'text', text: 'visible' },
          ]),
        ],
      }),
      { model: MODEL },
    );
    expect(body.messages[0]?.content).toBe('visible');
  });

  it('refuses an option the endpoint cannot honour rather than dropping it', () => {
    expect(() =>
      serializeRequest(options({ stop: ['STOP'] }), { model: MODEL, supportsStop: false }),
    ).toThrow(/stop sequences/);
  });
});

// ---------------------------------------------------------------------------
// Stream protocol
// ---------------------------------------------------------------------------

describe('the adapter stream contract', () => {
  function adapterWith(...payloads: readonly string[]): OpenAiEndpointAdapter {
    return new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route()]]),
      fetcher: () =>
        Promise.resolve(new Response(sseStream(...payloads), { status: 200 })),
    });
  }

  it('emits usage before finish, and nothing after finish', async () => {
    const chunks = await collect(
      adapterWith(
        chunk({ content: 'Bon' }),
        chunk({ content: 'jour' }, 'stop'),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
        '[DONE]',
      ).stream(options()),
    );

    const types = chunks.map((c) => c.type);
    expect(types.at(-1)).toBe('finish');
    expect(types.at(-2)).toBe('usage');
    expect(types.filter((t) => t === 'finish')).toHaveLength(1);
  });

  it('keeps one block index across every delta of the same block', async () => {
    const chunks = await collect(
      adapterWith(chunk({ content: 'a' }), chunk({ content: 'b' }, 'stop'), '[DONE]').stream(
        options(),
      ),
    );
    const deltas = chunks.filter((c) => c.type === 'text-delta');

    expect(deltas.map((d) => d.index)).toStrictEqual([0, 0]);
    expect(deltas.map((d) => d.text)).toStrictEqual(['a', 'b']);
  });

  it('assembles the text block on block-end', async () => {
    const chunks = await collect(
      adapterWith(chunk({ content: 'Bon' }), chunk({ content: 'jour' }, 'stop'), '[DONE]').stream(
        options(),
      ),
    );
    const end = chunks.find((c) => c.type === 'block-end');

    expect(end?.block).toStrictEqual({ type: 'text', text: 'Bonjour' });
  });

  it('streams tool arguments as raw fragments and reassembles them verbatim', async () => {
    const chunks = await collect(
      adapterWith(
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'classify', arguments: '{"id"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':"e1"}' } }] }, 'tool_calls'),
        '[DONE]',
      ).stream(options()),
    );

    const deltas = chunks.filter((c) => c.type === 'tool-call-delta');
    expect(deltas.map((d) => d.argumentsDelta)).toStrictEqual(['{"id"', ':"e1"}']);

    const end = chunks.find((c) => c.type === 'block-end');
    expect(end?.block).toStrictEqual({
      type: 'tool-call',
      id: 'c1',
      name: 'classify',
      arguments: '{"id":"e1"}',
    });
  });

  it('maps finish reasons onto the harness vocabulary', async () => {
    const stopped = await collect(adapterWith(chunk({}, 'stop'), '[DONE]').stream(options()));
    const capped = await collect(adapterWith(chunk({}, 'length'), '[DONE]').stream(options()));
    const calling = await collect(adapterWith(chunk({}, 'tool_calls'), '[DONE]').stream(options()));

    expect(stopped.at(-1)).toStrictEqual({ type: 'finish', reason: { kind: 'stop' } });
    expect(capped.at(-1)).toStrictEqual({ type: 'finish', reason: { kind: 'max-tokens' } });
    expect(calling.at(-1)).toStrictEqual({ type: 'finish', reason: { kind: 'tool-calls' } });
  });

  it('survives an unparsable frame rather than failing the whole call', async () => {
    const chunks = await collect(
      adapterWith(chunk({ content: 'a' }), 'not json', chunk({}, 'stop'), '[DONE]').stream(
        options(),
      ),
    );
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('treats a stream ending mid-generation as truncation', async () => {
    // No finish_reason arrived: the provider stopped without saying why, so
    // what arrived cannot be told apart from a complete answer.
    await expect(
      collect(adapterWith(chunk({ content: 'a' })).stream(options())),
    ).rejects.toMatchObject({ code: 'STREAM_CLOSED' });
  });

  it('accepts a stream that ends after a finish reason but without [DONE]', async () => {
    // Some providers omit the sentinel. Once they have said why generation
    // stopped, the response is complete and discarding it loses real work.
    const chunks = await collect(
      adapterWith(chunk({ content: 'a' }), chunk({}, 'stop')).stream(options()),
    );

    expect(chunks.at(-1)).toStrictEqual({ type: 'finish', reason: { kind: 'stop' } });
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
  });

  it('still fails when tool arguments were still streaming', async () => {
    await expect(
      collect(
        adapterWith(
          chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] }),
        ).stream(options()),
      ),
    ).rejects.toMatchObject({ code: 'STREAM_CLOSED' });
  });
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

describe('failures', () => {
  it('reports an HTTP error with its status, without echoing the bearer', async () => {
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route({ apiKey: 'super-secret-bearer' })]]),
      fetcher: () =>
        Promise.resolve(new Response('upstream said no for super-secret-bearer', { status: 500 })),
    });

    const error = await collect(adapter.stream(options())).catch((e: unknown) => e);
    const text = error instanceof Error ? error.message : String(error);

    expect(text).toContain('500');
    expect(text).not.toContain('super-secret-bearer');
  });

  it('classifies a rate limit distinctly from other provider errors', async () => {
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route()]]),
      fetcher: () => Promise.resolve(new Response('slow down', { status: 429 })),
    });

    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('degrades cleanly when the endpoint is unreachable', async () => {
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route()]]),
      fetcher: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('refuses a provider route it does not serve', async () => {
    const adapter = new OpenAiEndpointAdapter({ routes: new Map() });
    await expect(
      collect(adapter.stream(options({ provider: 'somebody-else' }))),
    ).rejects.toThrow(/No endpoint configured/);
  });

  it('sends the bearer and the required attribution header', async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(sseStream(chunk({}, 'stop'), '[DONE]'), { status: 200 })),
    );
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route()]]),
      fetcher,
    });
    await collect(adapter.stream(options()));

    const headers = fetcher.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer bearer-value');
    expect(headers['user-agent']).toBeTruthy();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://inference.linagora.com/v1/chat/completions',
    );
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('resolveRoutes', () => {
  const config: OpenAiPluginConfig = {
    baseUrl: GATEWAY,
    model: MODEL,
    apiKeyEnv: 'MAIL_SENTINEL_API_KEY',
    trustedEndpoints: [GATEWAY],
  };

  it('builds all four tiers from one credential', () => {
    const routes = resolveRoutes(config, { MAIL_SENTINEL_API_KEY: 'k' });
    expect([...routes.keys()]).toStrictEqual([
      'mail-llm-economy',
      'mail-llm-default',
      'mail-llm-chat',
      'mail-llm-draft',
    ]);
    expect(routes.get('mail-llm-economy')?.maxTokens).toBe(512);
    expect(routes.get('mail-llm-draft')?.maxTokens).toBe(2048);
  });

  it('fails the boot when the credential is not provisioned', () => {
    expect(() => resolveRoutes(config, {})).toThrow(/MAIL_SENTINEL_API_KEY is not set/);
  });

  it('fails the boot when a tier points off the trusted list', () => {
    expect(() =>
      resolveRoutes(
        { ...config, tiers: { draft: { baseUrl: 'https://api.openai.com/v1' } } },
        { MAIL_SENTINEL_API_KEY: 'k' },
      ),
    ).toThrow(/not in trusted_endpoints_only/);
  });

  it('never puts the credential in the configuration object', () => {
    expect(JSON.stringify(config)).not.toContain('k');
    expect(config).not.toHaveProperty('apiKey');
  });
});

// ---------------------------------------------------------------------------
// Translator, directly
// ---------------------------------------------------------------------------

describe('StreamTranslator', () => {
  it('subtracts cached tokens so the counts stay disjoint', () => {
    const translator = new StreamTranslator();
    const chunks = [
      ...translator.accept({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      ...translator.flush(),
    ];

    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage?.usage).toStrictEqual({
      inputTokens: 60,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
    });
  });

  it('gives reasoning its own block, distinct from visible text', () => {
    const translator = new StreamTranslator();
    const chunks = [
      ...translator.accept({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      ...translator.accept({ choices: [{ delta: { content: 'say' } }] }),
      ...translator.flush(),
    ];

    const starts = chunks.filter((c) => c.type === 'block-start');
    expect(starts.map((s) => s.blockType)).toStrictEqual(['reasoning', 'text']);
    expect(starts.map((s) => s.index)).toStrictEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Reasoning levels
// ---------------------------------------------------------------------------

describe('reasoning levels', () => {
  const settings = {
    efforts: [
      { id: 'off' as never, name: 'Off' },
      { id: 'deep' as never, name: 'Deep' },
    ],
    defaultEffort: 'off' as never,
    // Wire spelling is configuration: this endpoint happens to use vLLM's
    // template kwargs, another would use reasoning_effort.
    wire: {
      off: { chat_template_kwargs: { enable_thinking: false } },
      deep: { chat_template_kwargs: { enable_thinking: true } },
    },
  };

  it('adds nothing for a model that declares no levels', () => {
    const body = serializeRequest(options(), { model: MODEL });
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('refuses a reasoning request the model cannot honour', () => {
    expect(() =>
      serializeRequest(options({ reasoningEffort: 'deep' as never }), { model: MODEL }),
    ).toThrow(/no reasoning levels/);
  });

  it('materialises the configured default when the caller names none', () => {
    const body = serializeRequest(options(), { model: MODEL, reasoning: settings });
    expect(body['chat_template_kwargs']).toStrictEqual({ enable_thinking: false });
  });

  it('maps the requested level to that endpoint wire spelling', () => {
    const body = serializeRequest(options({ reasoningEffort: 'deep' as never }), {
      model: MODEL,
      reasoning: settings,
    });
    expect(body['chat_template_kwargs']).toStrictEqual({ enable_thinking: true });
  });

  it('rejects an unknown level rather than clamping onto a neighbour', () => {
    expect(() =>
      serializeRequest(options({ reasoningEffort: 'medium' as never }), {
        model: MODEL,
        reasoning: settings,
      }),
    ).toThrow(/Unknown reasoning level/);
  });

  it('advertises the levels through resolveModel, as the seam expects', async () => {
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-draft', route({ reasoning: settings })]]),
    });
    const info = await adapter.resolveModel('mail-llm-draft', MODEL);

    expect(info.reasoning?.efforts.map((e) => e.id)).toStrictEqual(['off', 'deep']);
    expect(info.reasoning?.defaultEffort).toBe('off');
  });

  it('advertises none for the gateway models of today', async () => {
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([['mail-llm-economy', route()]]),
    });
    const info = await adapter.resolveModel('mail-llm-economy', MODEL);

    expect(info.reasoning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

describe('the fallback chain', () => {
  const PRIMARY = 'mail-llm-economy';
  const BACKUP = 'mail-llm-economy-backup';

  function chained(
    handlers: readonly ((url: string) => Response | Error)[],
  ): { adapter: OpenAiEndpointAdapter; selections: RouteSelection[]; urls: string[] } {
    const selections: RouteSelection[] = [];
    const urls: string[] = [];
    let call = 0;
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([
        [PRIMARY, route({ baseUrl: 'https://primary.test/v1', fallback: [BACKUP] })],
        [BACKUP, route({ baseUrl: 'https://backup.test/v1' })],
      ]),
      onRouteSelected: (event) => selections.push(event),
      fetcher: (url) => {
        urls.push(url);
        const outcome = handlers[call++] ?? handlers.at(-1);
        const result = outcome?.(url);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result as Response);
      },
    });
    return { adapter, selections, urls };
  }

  const ok = (): Response =>
    new Response(sseStream(chunk({ content: 'ok' }, 'stop'), '[DONE]'), { status: 200 });

  it('does not touch the backup when the primary answers', async () => {
    const { adapter, selections, urls } = chained([ok]);
    await collect(adapter.stream(options({ provider: PRIMARY })));

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('primary.test');
    expect(selections).toStrictEqual([]);
  });

  it('falls over when the primary is unreachable', async () => {
    const { adapter, selections, urls } = chained([() => new Error('ECONNREFUSED'), ok]);
    const chunks = await collect(adapter.stream(options({ provider: PRIMARY })));

    expect(urls[1]).toContain('backup.test');
    expect(chunks.at(-1)?.type).toBe('finish');
    expect(selections).toStrictEqual([
      { requested: PRIMARY, served: BACKUP, attempted: [PRIMARY] },
    ]);
  });

  it('falls over on a 5xx, which is the endpoint failing', async () => {
    const { adapter, urls } = chained([() => new Response('boom', { status: 503 }), ok]);
    await collect(adapter.stream(options({ provider: PRIMARY })));
    expect(urls[1]).toContain('backup.test');
  });

  it('falls over on a rate limit', async () => {
    const { adapter, urls } = chained([() => new Response('slow', { status: 429 }), ok]);
    await collect(adapter.stream(options({ provider: PRIMARY })));
    expect(urls[1]).toContain('backup.test');
  });

  it('does not fall over on a 4xx, which every route would reject alike', async () => {
    const { adapter, urls } = chained([() => new Response('bad request', { status: 400 })]);
    await expect(collect(adapter.stream(options({ provider: PRIMARY })))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(urls).toHaveLength(1);
  });

  it('does not fall over once a chunk has reached the caller', async () => {
    // A stream that starts, then truncates: replaying on the backup would
    // hand the loop the opening text twice.
    const truncated = (): Response =>
      new Response(sseStream(chunk({ content: 'partial' })), { status: 200 });
    const { adapter, urls } = chained([truncated, ok]);

    const seen: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const c of adapter.stream(options({ provider: PRIMARY }))) seen.push(c);
      })(),
    ).rejects.toMatchObject({ code: 'STREAM_CLOSED' });

    expect(seen.some((c) => c.type === 'text-delta')).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('does not fall over when the caller cancelled', async () => {
    const controller = new AbortController();
    const { adapter, urls } = chained([
      () => {
        controller.abort();
        return new Error('aborted');
      },
      ok,
    ]);

    await expect(
      collect(adapter.stream(options({ provider: PRIMARY, signal: controller.signal }))),
    ).rejects.toBeDefined();
    expect(urls).toHaveLength(1);
  });

  it('reports the last failure when the whole chain is down', async () => {
    const { adapter, urls } = chained([() => new Error('down'), () => new Error('also down')]);
    await expect(collect(adapter.stream(options({ provider: PRIMARY })))).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(urls).toHaveLength(2);
  });

  it('has an empty chain today, which is the sovereign posture', () => {
    const single = new OpenAiEndpointAdapter({ routes: new Map([[PRIMARY, route()]]) });
    expect(single).toBeDefined();
    expect(route().fallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gateway provider routing
// ---------------------------------------------------------------------------

describe('provider routing', () => {
  it('sends nothing when the route expresses no preference', () => {
    const body = serializeRequest(options(), { model: MODEL });
    expect(body).not.toHaveProperty('provider');
  });

  it('passes the preference through verbatim', () => {
    const routing = { order: ['BaseTen'], allow_fallbacks: false };
    const body = serializeRequest(options(), { model: MODEL, providerRouting: routing });
    expect(body['provider']).toStrictEqual(routing);
  });

  it('pins the upstream on the wire, which is what makes a run reproducible', async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(new Response(sseStream(chunk({}, 'stop'), '[DONE]'), { status: 200 })),
    );
    const adapter = new OpenAiEndpointAdapter({
      routes: new Map([
        ['mail-llm-economy', route({ providerRouting: { order: ['BaseTen'], allow_fallbacks: false } })],
      ]),
      fetcher,
    });
    await collect(adapter.stream(options()));

    const sent: unknown = JSON.parse(fetcher.mock.calls[0]?.[1].body as string);
    expect((sent as Record<string, unknown>)['provider']).toStrictEqual({
      order: ['BaseTen'],
      allow_fallbacks: false,
    });
  });

  it('lets a tier override the plugin-wide preference', () => {
    const routes = resolveRoutes(
      {
        baseUrl: GATEWAY,
        model: MODEL,
        apiKeyEnv: 'MAIL_SENTINEL_API_KEY',
        providerRouting: { order: ['DeepInfra'] },
        tiers: { draft: { providerRouting: { order: ['BaseTen'] } } },
      },
      { MAIL_SENTINEL_API_KEY: 'k' },
    );

    expect(routes.get('mail-llm-economy')?.providerRouting).toStrictEqual({ order: ['DeepInfra'] });
    expect(routes.get('mail-llm-draft')?.providerRouting).toStrictEqual({ order: ['BaseTen'] });
  });
});
