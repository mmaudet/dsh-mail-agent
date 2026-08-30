/**
 * Does this message ask the owner for something?
 *
 * A different question from the sixteen categories, and the one the queue
 * actually needs. `pending()` removes what the owner has finished with and
 * orders the rest; this decides what is offered at all.
 *
 * The prompt is the finding rather than a detail of it. Holding the messages
 * fixed and changing only the wording moved precision from 50% to 70% at
 * identical recall on the owner's own annotations
 * (`docs/reviews/asking-the-right-question.md`), which is more than any signal
 * measured on this mailbox has ever been worth. Two things do the work: the
 * question is about the owner's obligation rather than the sender's state, and
 * the base rate is stated instead of left to be inferred one message at a time.
 *
 * Nothing here is wired into the agent loop. It adds a model call per message
 * on top of classification, and turning that on is a decision about cost that
 * belongs to the owner.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { MailMessage } from '../types.js';
import type { Addressing } from './pending.js';

/** How much of a message the judgement is shown, as node 6 uses. */
export const MAX_BODY_CHARS = 1200;

export const ASKS_SYSTEM_PROMPT = [
  'You read one email that reached the owner of a mailbox.',
  '',
  'Answer YES only if it asks for something that the owner personally has to',
  'do: write a reply that has not been written, sign, validate, approve,',
  'renew, or answer a question put to them.',
  '',
  'Answer NO if it only keeps them informed. That includes: an exchange',
  'between other people that they are copied on, a status report, a delivery',
  'or platform notification about something already in motion, a meeting',
  'confirmation, and anything addressed to a team they belong to where a',
  'colleague is the one being asked.',
  '',
  // Measured, not rhetorical: nine of twenty-nine. Without it the model reads
  // each message alone and finds something plausible to do in most of them.
  'Most mail in this inbox is NO. Reply with one word: YES or NO.',
].join('\n');

export interface AsksOptions {
  readonly llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  /**
   * Room to answer. A reasoning model spends three hundred tokens thinking
   * and returns nothing at all under a tight cap, which this project has now
   * measured as a model failure twice before finding it was the harness.
   */
  readonly maxTokens?: number | undefined;
}

/**
 * What the model is shown.
 *
 * `Addressed` is included because it is a fact the message does not carry:
 * whether the named recipient is the owner or a team they belong to depends on
 * which addresses the owner says are theirs.
 */
export function renderForAsk(message: MailMessage, addressing: Addressing): string {
  const from = message.from[0];
  const sender = from === undefined ? '(none)' : `${from.name ?? ''} <${from.email}>`.trim();
  const cc = message.cc.map((address) => address.email).join(', ');
  return [
    `From: ${sender}`,
    `To: ${message.to.map((address) => address.email).join(', ')}`,
    cc === '' ? null : `Cc: ${cc}`,
    `Addressed: ${addressing === 'personal' ? 'to the owner' : 'to a list the owner is on'}`,
    `Subject: ${message.subject.slice(0, 200)}`,
    '',
    (message.bodyText ?? message.preview).slice(0, MAX_BODY_CHARS),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * The last YES or NO anywhere in the answer, or `null` for neither.
 *
 * The last rather than the first, because a model that reasons aloud opens
 * with anything and closes with the verdict — reading the first character
 * scored one model at 0% and that was this function's fault.
 */
export function readVerdict(raw: string): boolean | null {
  const found = raw.toUpperCase().match(/\b(YES|NO)\b/g);
  if (found === null) return null;
  return found[found.length - 1] === 'YES';
}

/**
 * Whether to offer the message.
 *
 * An answer that cannot be read is offered. The queue's tolerable failure is
 * showing the owner something they did not need; dropping a message they had
 * to answer, silently, is not one.
 */
export async function asksOfOwner(
  message: MailMessage,
  addressing: Addressing,
  options: AsksOptions,
): Promise<boolean> {
  const prompt = createUserMessage({
    content: [{ type: 'text', text: renderForAsk(message, addressing) }],
    source: { kind: 'plugin', plugin: 'dsh-mail-core', contextFormed: false },
  });

  const chunks: string[] = [];
  for await (const chunk of options.llm.stream({
    provider: options.provider,
    model: options.model,
    system: ASKS_SYSTEM_PROMPT,
    messages: [prompt],
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 600,
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text);
  }
  return readVerdict(chunks.join('')) ?? true;
}
