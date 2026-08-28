/**
 * Translate a harness request into an OpenAI chat-completions body.
 *
 * The harness vocabulary is richer than the wire in one direction and poorer
 * in another, so both mismatches are handled explicitly rather than silently:
 * a tool result is its own wire role, and an option the endpoint cannot honour
 * raises `UNSUPPORTED_OPTION` instead of being dropped.
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';

import type { WireMessage, WireRequest, WireTool } from './wire.js';

export interface SerializeOptions {
  readonly model: string;
  /** Endpoints that reject `stop`; the caller declares what it supports. */
  readonly supportsStop?: boolean;
  readonly supportsTools?: boolean;
}

export function serializeRequest(
  options: GenerateOptions,
  serialize: SerializeOptions,
): WireRequest {
  if (options.stop !== undefined && options.stop.length > 0 && serialize.supportsStop === false) {
    throw new LlmError(
      'This endpoint does not accept stop sequences',
      'UNSUPPORTED_OPTION',
    );
  }
  if (options.tools !== undefined && options.tools.length > 0 && serialize.supportsTools === false) {
    throw new LlmError('This endpoint does not accept tools', 'UNSUPPORTED_OPTION');
  }

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
  };
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
