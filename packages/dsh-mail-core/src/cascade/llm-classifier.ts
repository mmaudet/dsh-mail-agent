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
  // Sixteen, derived from 400 real messages rather than specified in advance.
  // The ordering below is the one the derivation produced: what the owner must
  // do comes first, because that is the only band whose mistakes cost time.
  //
  // Two boundaries carry most of the error and are stated twice on purpose —
  // being written to is not being asked, and bulk the owner chose is not bulk
  // sent at them.
  'The three things that can happen to a message, in order:',
  '',
  'A. THE OWNER MUST ACT — something only they can do, and it is not done.',
  '- correspondance-commerciale-client: a client, prospect or partner writes',
  '  about an offer, a quote, a project or a collaboration, and wants a',
  '  substantive answer.',
  '- obligations-administratives-echeance: something must be done before a',
  '  date. Pay, sign, renew, update a payment method, approve leave.',
  '- demande-interne: a colleague asks the owner to decide, approve or',
  '  clarify something operational.',
  '- planification-reunion-rdv: the message is only about fixing, confirming',
  '  or moving a time. If it also decides content, it is not this.',
  '- incident-securite: a security incident or a vulnerability disclosure',
  '  touching the company. Escalated, never queued.',
  '',
  'B. WORTH READING, NOTHING TO DO — most of the mailbox.',
  '- veille-newsletter: editorial content the owner subscribed to. Press,',
  '  LinkedIn, Google alerts, technical publications.',
  '- support-technique-ticket: a provider or platform reporting the state of',
  '  a ticket, an incident or an account the owner opened.',
  '- rapport-compte-rendu-interne: a colleague shares a document, a report,',
  '  minutes or a status, and expects nothing back.',
  '- notifications-personnelles-diverses: automated mail with no professional',
  '  value. Social networks, personal purchases, out-of-office replies.',
  '- liste-diffusion: traffic from a mailing list the owner is on.',
  '- recu-transaction: money that has already moved. Receipts, payment',
  '  confirmations, paid invoices. Worth keeping, nothing to do.',
  '- rh-interne: personnel matters about someone already employed.',
  '- candidature-emploi: an external candidate applying.',
  '',
  'C. NOTHING TO READ AND NOTHING TO KEEP.',
  '- prospection-commerciale-non-sollicitee: cold commercial approach with no',
  '  existing client relationship or project. SEO, marketing tools, travel,',
  '  recruitment agencies.',
  '- spam-formulaire-contact: an automated web-form submission whose content',
  '  is filler or opportunistic.',
  '- phishing-arnaque: written to deceive or extort. Sextortion, fake breach',
  '  alerts, financial fraud, forged security notices.',
  '',
  'Apply the first that matches:',
  '1. Does it try to deceive or extort? -> phishing-arnaque.',
  '2. Is it a web-form submission with no real content? -> spam-formulaire-contact.',
  '3. Is it a cold approach from someone with no existing relationship?',
  '   -> prospection-commerciale-non-sollicitee. An unsubscribe link does NOT',
  '   settle this: the owner subscribes to newsletters too. Ask instead whether',
  '   they ever asked for it. Content that informs was chosen; content that',
  '   pitches a service to a stranger was not.',
  '4. Is there an action only the owner can take, that has not been taken?',
  '   -> the matching category in A.',
  '   NOT band A, however human the sender: a colleague sharing a document,',
  '   a report, a status update or meeting notes, or a request that is somebody',
  '   else\'s to fulfil. Being kept informed is band B, and most of a work',
  '   inbox is being kept informed. Automated mail is never band A, except an',
  '   `incident-securite`.',
  '5. Otherwise -> the matching category in B. This is the common case by a',
  '   wide margin, not the leftover.',
  '',
  'Three rules that decide most of the hard cases:',
  '- Ask who must act. A message that says what someone else has done, or is',
  '  about to do, is band B even when it addresses the owner by name.',
  '- Keep vs. owe: a receipt is recu-transaction because the money already',
  '  moved; an invoice due is obligations-administratives-echeance.',
  '- A support provider writing about an open case is support-technique-ticket,',
  '  unless a person there asks the owner a direct question, which makes it',
  '  demande-interne or correspondance-commerciale-client.',
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
