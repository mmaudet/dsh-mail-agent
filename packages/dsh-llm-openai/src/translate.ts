/**
 * Turn OpenAI streaming chunks into the harness `StreamChunk` protocol.
 *
 * Three obligations from the adapter contract drive the shape here:
 * `usage` is emitted before `finish` and nothing follows `finish`; tool-call
 * arguments stay raw JSON strings and stream as `argumentsDelta`; and block
 * indexes are allocated in first-seen order and reused for every delta of the
 * same block. The translator therefore buffers the terminal chunks and flushes
 * them once, rather than emitting as they arrive.
 */

import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from '@deepseek-ai/dsh-llm';

import type { WireFinishReason } from './wire.js';

/** The branded call id, taken from the block rather than imported directly. */
type ToolCallId = ToolCallBlock['id'];

interface OpenBlock {
  readonly index: number;
  readonly kind: 'text' | 'reasoning' | 'tool-call';
  text: string;
  toolId?: string;
  toolName?: string;
}

/**
 * Accumulates wire deltas and yields harness chunks.
 *
 * Stateful by necessity: the wire reports a tool call's name once and its
 * arguments across many chunks, so the assembled block can only be produced
 * at the end.
 */
export class StreamTranslator {
  readonly #blocks = new Map<string, OpenBlock>();
  #nextIndex = 0;
  #finish: FinishReason | null = null;
  #usage: TokenUsage | null = null;

  /** Whether the provider said why generation stopped. */
  get sawFinishReason(): boolean {
    return this.#finish !== null;
  }

  /** Consume one parsed wire chunk, yielding whatever it completes. */
  *accept(payload: unknown): Generator<StreamChunk> {
    const usage = readUsage(readProp(payload, 'usage'));
    if (usage !== null) this.#usage = usage;

    const choice = asArray(readProp(payload, 'choices'))[0];
    if (choice === undefined) return;

    const delta = readProp(choice, 'delta');
    const text = asString(readProp(delta, 'content'));
    if (text !== null && text.length > 0) yield* this.#appendText('text', 'content', text);

    const reasoning =
      asString(readProp(delta, 'reasoning_content')) ?? asString(readProp(delta, 'reasoning'));
    if (reasoning !== null && reasoning.length > 0) {
      yield* this.#appendText('reasoning', 'reasoning', reasoning);
    }

    for (const call of asArray(readProp(delta, 'tool_calls'))) {
      yield* this.#appendToolCall(call);
    }

    const reason = asString(readProp(choice, 'finish_reason'));
    if (reason !== null) this.#finish = toFinishReason(reason);
  }

  /**
   * Close every open block, then emit usage and the terminal finish.
   *
   * Called once, on the wire's end-of-stream marker. Buffering to here is what
   * keeps the contract when a gateway sends a trailing usage-only chunk after
   * the chunk carrying `finish_reason`.
   */
  *flush(): Generator<StreamChunk> {
    for (const block of [...this.#blocks.values()].sort((a, b) => a.index - b.index)) {
      yield { type: 'block-end', index: block.index, block: toContentBlock(block) };
    }
    this.#blocks.clear();

    if (this.#usage !== null) yield { type: 'usage', usage: this.#usage };
    yield { type: 'finish', reason: this.#finish ?? { kind: 'stop' } };
  }

  *#appendText(
    kind: 'text' | 'reasoning',
    key: string,
    text: string,
  ): Generator<StreamChunk> {
    let block = this.#blocks.get(key);
    if (block === undefined) {
      block = { index: this.#nextIndex++, kind, text: '' };
      this.#blocks.set(key, block);
      yield { type: 'block-start', index: block.index, blockType: kind };
    }
    block.text += text;
    yield kind === 'text'
      ? { type: 'text-delta', index: block.index, text }
      : { type: 'reasoning-delta', index: block.index, text };
  }

  *#appendToolCall(call: unknown): Generator<StreamChunk> {
    // The wire correlates fragments by position, and only the first fragment
    // carries the id, so position is the stable key.
    const position = asNumber(readProp(call, 'index')) ?? 0;
    const key = `tool:${String(position)}`;
    const fn = readProp(call, 'function');
    const id = asString(readProp(call, 'id'));
    const name = asString(readProp(fn, 'name'));
    const args = asString(readProp(fn, 'arguments')) ?? '';

    let block = this.#blocks.get(key);
    if (block === undefined) {
      block = { index: this.#nextIndex++, kind: 'tool-call', text: '' };
      this.#blocks.set(key, block);
      yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
    }
    if (id !== null) block.toolId = id;
    if (name !== null) block.toolName = name;
    block.text += args;

    yield {
      type: 'tool-call-delta',
      index: block.index,
      id: (block.toolId ?? '') as ToolCallId,
      ...(name === null ? {} : { name }),
      argumentsDelta: args,
    };
  }
}

function toContentBlock(block: OpenBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text };
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text };
  return {
    type: 'tool-call',
    id: (block.toolId ?? '') as ToolCallId,
    name: block.toolName ?? '',
    // Raw JSON string end to end, exactly as the model produced it.
    arguments: block.text,
  };
}

function toFinishReason(reason: string): FinishReason {
  const wire = reason as WireFinishReason;
  switch (wire) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return {
        kind: 'error',
        failure: { message: 'The provider filtered the response', code: 'CONTENT_FILTER' },
      };
    default:
      return { kind: 'stop' };
  }
}

/**
 * Read token usage.
 *
 * The harness counts are disjoint: `inputTokens` is uncached input only, so a
 * provider total that folds cache hits into `prompt_tokens` has them
 * subtracted back out rather than double-counted.
 */
function readUsage(value: unknown): TokenUsage | null {
  const prompt = asNumber(readProp(value, 'prompt_tokens'));
  const completion = asNumber(readProp(value, 'completion_tokens'));
  if (prompt === null && completion === null) return null;

  const details = readProp(value, 'prompt_tokens_details');
  const cached = asNumber(readProp(details, 'cached_tokens')) ?? 0;
  const total = asNumber(readProp(value, 'total_tokens'));
  const reasoning = asNumber(
    readProp(readProp(value, 'completion_tokens_details'), 'reasoning_tokens'),
  );

  return {
    inputTokens: Math.max((prompt ?? 0) - cached, 0),
    outputTokens: completion ?? 0,
    ...(total === null ? {} : { totalTokens: total }),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }),
  };
}

function readProp(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
