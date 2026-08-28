/**
 * Decode an SSE byte stream into event payloads.
 *
 * Framing is `eventsource-parser`'s: chunk reassembly, UTF-8 split across
 * reads, CRLF, BOM, comments and multi-`data:` joining. This module owns only
 * the protocol convention — `[DONE]` is yielded so the caller controls the
 * final flush, and end-of-stream without it is truncation.
 *
 * A truncated stream is a failure, not an empty answer: the model call cannot
 * be trusted, and silently returning what arrived would hand the loop a
 * plausible-looking partial response.
 */

import { LlmError } from '@deepseek-ai/dsh-llm';
import { EventSourceParserStream } from 'eventsource-parser/stream';

/** The terminal payload the OpenAI protocol sends after the last chunk. */
export const DONE = '[DONE]';

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  for await (const event of events) {
    yield event.data;
    if (event.data === DONE) return;
  }

  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}
