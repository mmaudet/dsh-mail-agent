/**
 * The OpenAI chat-completions wire vocabulary this adapter speaks.
 *
 * Only the fields the adapter reads or writes are declared. A response is
 * remote input, so every reader in `translate.ts` narrows from `unknown`
 * rather than trusting these shapes at runtime; they exist to keep the
 * request side honest and to document what the gateway is expected to return.
 */

export interface WireTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface WireImageContent {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string };
}

export type WireContentPart = WireTextContent | WireImageContent;

export interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface WireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly WireContentPart[] | null;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

export interface WireTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface WireRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly stream: true;
  /** Asks the gateway for a usage block on the final chunk. */
  readonly stream_options: { readonly include_usage: true };
  readonly tools?: readonly WireTool[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stop?: readonly string[];
}

/** The finish reasons the OpenAI protocol defines. */
export type WireFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call';
