/**
 * Node 6: the model-backed classifier (PRD section 4.2, step 6).
 *
 * The only node that leaves the process, and the only one that sees message
 * content. Everything about it is shaped by that: it runs on the `economy`
 * tier because it runs on every message the cheap nodes could not settle, it
 * is given a bounded excerpt rather than a whole body, and it answers a fixed
 * vocabulary or it does not answer at all.
 *
 * The harness stream is reached through a port rather than `ctx.llm` directly,
 * so the prompt and the parsing can be exercised without a gateway.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { MailMessage } from '../types.js';
import { toMailCategory } from '../types.js';
import type { CascadeContext, ClassifierModel, NodeVerdict } from './types.js';

/** The tier this node calls on, per PRD section 3.6's model router. */
export const CLASSIFY_TIER = 'economy';

/**
 * How much of a message the model is shown.
 *
 * A classification does not need the whole thread: the first screenful carries
 * the signal, and every extra token is paid on every message of every day. It
 * also bounds what leaves the perimeter to something a reviewer can reason
 * about.
 */
export const MAX_BODY_CHARS = 1200;

/** Bounded so a pathological subject cannot push the body out of the prompt. */
const MAX_SUBJECT_CHARS = 200;

/**
 * The slice of the harness LLM service this node uses.
 *
 * Typed against the harness's own contract rather than a convenient shape of
 * our own: `ctx.llm` has to satisfy it structurally, and a port that only the
 * test double fits would prove nothing.
 */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

export interface LlmClassifierOptions {
  readonly llm: LlmStreamer;
  /** Registered route, for example `mail-llm-economy`. */
  readonly provider: string;
  readonly model: string;
  /** Deterministic by default: the same message must classify the same way. */
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export const SYSTEM_PROMPT = [
  'You classify one email into exactly one category and say how sure you are.',
  '',
  'Answer with a single JSON object and nothing else:',
  '{"category": "<category>", "confidence": <0..1>, "rationale": "<one short sentence>"}',
  '',
  'Categories, and what each is for:',
  '- important: the owner is expected to act or reply',
  '- standard: informative, worth reading, no action expected',
  '- newsletter-tech: a subscribed technical publication',
  '- newsletter-promo: commercial or promotional bulk',
  '- newsletter-notification: an automated platform notification',
  '- transactional: a receipt, a confirmation, a one-time code',
  '- spam-probable: unsolicited and suspicious, but not certainly so',
  '- spam-certain: unmistakably unsolicited or malicious',
  '',
  'The rationale is one sentence about *why*, in English, under 120 characters.',
  'Never quote the message body or a header value in it: the rationale is',
  'exported to audit logs and to external observability.',
  '',
  'If the message carries too little signal to place, answer the closest',
  'category with a low confidence rather than inventing certainty.',
].join('\n');

/**
 * Renders the part of a message the model is shown.
 *
 * Exported because what leaves the perimeter is worth being able to inspect
 * and test directly, rather than reading it back out of a prompt string.
 */
export function renderMessage(message: MailMessage, context: CascadeContext): string {
  const from = message.from[0];
  const sender = from === undefined ? '(none)' : `${from.name ?? ''} <${from.email}>`.trim();
  const body = (message.bodyText ?? message.preview).slice(0, MAX_BODY_CHARS);

  return [
    `Owner: ${context.owner}`,
    `From: ${sender}`,
    `Subject: ${message.subject.slice(0, MAX_SUBJECT_CHARS)}`,
    `Has unsubscribe link: ${message.listUnsubscribe.length > 0 ? 'yes' : 'no'}`,
    `Has attachments: ${message.hasAttachments ? 'yes' : 'no'}`,
    '',
    body,
  ].join('\n');
}

/**
 * Reads the model's answer.
 *
 * Strict on purpose. A model that returns prose, a category outside the
 * vocabulary, or a confidence that is not a number has not classified
 * anything, and treating a malformed answer as a low-confidence one would let
 * a broken prompt look like an uncertain mailbox.
 */
export function parseVerdict(raw: string): NodeVerdict {
  // Models wrap JSON in prose or fences often enough that finding the object
  // is worth doing, and it is not the same as accepting anything.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new TypeError('the model returned no JSON object');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new TypeError('the model returned malformed JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('the model returned no JSON object');
  }

  const { category, confidence, rationale } = parsed as Record<string, unknown>;
  const parsedCategory = typeof category === 'string' ? toMailCategory(category) : null;
  if (parsedCategory === null) {
    throw new TypeError(`the model answered an unknown category: ${String(category)}`);
  }
  // `needs-review` is node 7's to assign, never node 6's: a model that says it
  // is unsure has said so through its confidence.
  if (parsedCategory === 'needs-review') {
    throw new TypeError('the model may not answer needs-review; it reports confidence instead');
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new TypeError('the model returned no numeric confidence');
  }

  return {
    category: parsedCategory,
    confidence: Math.min(1, Math.max(0, confidence)),
    rationale: typeof rationale === 'string' ? rationale.slice(0, 160) : '',
  };
}

/** Builds the node 6 implementation over a harness LLM route. */
export function createLlmClassifier(options: LlmClassifierOptions): ClassifierModel {
  return {
    async classify(message: MailMessage, context: CascadeContext): Promise<NodeVerdict> {
      const prompt = createUserMessage({
        content: [{ type: 'text', text: renderMessage(message, context) }],
        source: { kind: 'plugin', plugin: 'dsh-mail-core', contextFormed: false },
      });

      const chunks: string[] = [];
      for await (const chunk of options.llm.stream({
        provider: options.provider,
        model: options.model,
        system: SYSTEM_PROMPT,
        messages: [prompt],
        // Zero, not the provider default: the same message must classify the
        // same way twice, or a calibration measures nothing.
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 256,
      })) {
        // Only visible text. A reasoning delta is the model thinking, not its
        // answer, and folding it in would read thinking as a verdict.
        if (chunk.type === 'text-delta') chunks.push(chunk.text);
      }
      return parseVerdict(chunks.join(''));
    },
  };
}
