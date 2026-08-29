/**
 * Decode an SSE byte stream into event payloads.
 *
 * Framing is `eventsource-parser`'s: chunk reassembly, UTF-8 split across
 * reads, CRLF, BOM, comments and multi-`data:` joining. This module owns only
 * the protocol convention: `[DONE]` is yielded so the caller controls the
 * final flush, and the end of the stream is reported rather than hidden.
 *
 * Whether ending without `[DONE]` is a failure is not decidable here. A
 * provider that omits the sentinel after delivering a finish reason has sent a
 * complete response; one that stops mid-generation has not, and returning what
 * arrived would hand the loop a plausible-looking fragment. Only the caller,
 * which has seen the chunks, can tell those apart.
 */

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
}
