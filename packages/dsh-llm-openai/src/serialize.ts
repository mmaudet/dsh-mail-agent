/**
 * Translate a harness request into an OpenAI chat-completions body.
 *
 * The harness vocabulary is richer than the wire in one direction and poorer
 * in another, so both mismatches are handled explicitly rather than silently:
 * a tool result is its own wire role, and an option the endpoint cannot honour
 * raises `UNSUPPORTED_OPTION` instead of being dropped.
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  GenerateOptions,
  LlmReasoningEffortInfo,
  Message,
} from '@deepseek-ai/dsh-llm';

import type { WireMessage, WireRequest, WireTool } from './wire.js';

/** The branded effort id, taken from the seam rather than imported directly. */
type ReasoningEffortId = LlmReasoningEffortInfo['id'];

/**
 * Selectable reasoning levels for one model, and how each reaches the wire.
 *
 * The wire spelling is configuration, not a constant: OpenAI expresses effort
 * as `reasoning_effort`, vLLM as `chat_template_kwargs`, and others again
 * differently. Hard-coding one vendor's convention would make this adapter
 * wrong for the endpoints it exists to be generic over, so the mapping is
 * declared alongside the model that needs it.
 */
export interface ReasoningSettings {
  /** Adapter-owned selectable levels, in display order. */
  readonly efforts: readonly LlmReasoningEffortInfo[];
  /** Materialized when the caller names no effort; absent keeps the provider default. */
  readonly defaultEffort?: ReasoningEffortId | undefined;
  /** Effort id to the request fields it adds. An id need not equal its wire spelling. */
  readonly wire: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface SerializeOptions {
  readonly model: string;
  /** Endpoints that reject `stop`; the caller declares what it supports. */
  readonly supportsStop?: boolean;
  readonly supportsTools?: boolean;
  readonly reasoning?: ReasoningSettings | undefined;
}

/**
 * The body sent on the wire: the known fields, plus whatever a configured
 * reasoning level adds. The intersection is deliberate — the extra keys are
 * real at runtime and the return type should not pretend otherwise.
 */
export type SerializedRequest = WireRequest & Readonly<Record<string, unknown>>;

export function serializeRequest(
  options: GenerateOptions,
  serialize: SerializeOptions,
): SerializedRequest {
  if (options.stop !== undefined && options.stop.length > 0 && serialize.supportsStop === false) {
    throw new LlmError(
      'This endpoint does not accept stop sequences',
      'UNSUPPORTED_OPTION',
    );
  }
  if (options.tools !== undefined && options.tools.length > 0 && serialize.supportsTools === false) {
    throw new LlmError('This endpoint does not accept tools', 'UNSUPPORTED_OPTION');
  }

  const reasoningFields = resolveReasoning(options.reasoningEffort, serialize.reasoning);

  const messages: WireMessage[] = [];
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system });
  }
  for (const message of options.messages) messages.push(...toWireMessages(message));

  const tools: WireTool[] | undefined =
    options.tools === undefined || options.tools.length === 0
      ? undefined
      : options.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

  return {
    model: serialize.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
    ...reasoningFields,
  };
}

/**
 * Turn a requested effort into the wire fields that carry it.
 *
 * Three refusals rather than three silent fallbacks: a caller asking for
 * reasoning from a model that has none, or for a level this model does not
 * offer, gets `UNSUPPORTED_OPTION`. The contract forbids clamping an
 * unsupported value onto a neighbouring one, because a caller that asked for
 * deep reasoning and silently received none cannot tell.
 */
function resolveReasoning(
  requested: ReasoningEffortId | undefined,
  settings: ReasoningSettings | undefined,
): Readonly<Record<string, unknown>> {
  if (settings === undefined) {
    if (requested === undefined) return {};
    throw new LlmError(
      'This model offers no reasoning levels',
      'UNSUPPORTED_OPTION',
    );
  }

  const effort = requested ?? settings.defaultEffort;
  if (effort === undefined) return {};

  if (!settings.efforts.some((known) => known.id === effort)) {
    throw new LlmError(
      `Unknown reasoning level: ${String(effort)}`,
      'UNSUPPORTED_OPTION',
    );
  }
  return settings.wire[effort] ?? {};
}

/**
 * One harness message can become several wire messages.
 *
 * A tool result travels as its own `tool`-role message keyed by call id, so a
 * user turn carrying results is split rather than flattened into prose the
 * model would have to parse back.
 */
function toWireMessages(message: Message): WireMessage[] {
  const wire: WireMessage[] = [];
  const parts: string[] = [];
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] =
    [];

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'reasoning':
        // Reasoning is not replayed to the endpoint: the protocol has no slot
        // for it, and echoing it back as text would change the prompt.
        break;
      case 'tool-call':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        });
        break;
      case 'tool-result':
        wire.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: flattenResult(block.content),
        });
        break;
      case 'image':
        // Declared text-only: images would need a durable URL the adapter
        // cannot mint here. Dropping is deliberate and visible in this switch.
        break;
      default:
        break;
    }
  }

  const text = parts.join('\n');
  if (text.length > 0 || toolCalls.length > 0) {
    wire.push({
      role: message.role === 'system' ? 'system' : message.role,
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return wire;
}

function flattenResult(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}
