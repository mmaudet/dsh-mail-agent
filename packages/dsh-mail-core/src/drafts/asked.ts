/**
 * What a message asks of its recipient, listed before the owner answers it.
 *
 * The critique loop found the right fault fifteen times out of sixteen — a
 * question in the message that the draft never addressed — and could not fix
 * one of them, because the answer was never in the owner's instruction. Three
 * rounds of revision on five drafts changed nothing, since the reviser is
 * forbidden to invent and the material was not there to use.
 *
 * So the loop is turned around. Instead of criticising a draft after the fact,
 * the same question is put before the fact, to the only person who can answer
 * it: here is what this message asks, and your line covers one of three.
 *
 * That is also the only honest route to a longer draft. Length tracks the
 * instruction at roughly a word for a word, so a fuller reply comes from a
 * fuller sentence and from nowhere else.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { MailMessage } from '../types.js';
import { unquoted } from './language.js';

/** How many asks are worth showing. Beyond four it is a document, not a mail. */
export const MAX_ASKS = 4;

export const ASKED_SYSTEM_PROMPT = [
  'You read one email and list what it asks of the person receiving it.',
  '',
  'One short line each, in the language of the message, at most four. Name the',
  'thing asked, not the sentence it was asked in: "a 30-minute call with the',
  'elected official", "whether the July increases are retroactive".',
  '',
  'Only what is actually asked of them. A message that reports, thanks or',
  'informs asks nothing — answer with an empty list, which is the common case.',
  'Do not invent an implied request to seem useful.',
  '',
  'Answer as JSON and nothing else: {"asks": ["...", "..."]}',
].join('\n');

/** Reads the list, tolerating the prose a model wraps it in. */
export function parseAsks(raw: string, limit = MAX_ASKS): string[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { asks?: unknown }).asks;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim().slice(0, 120))
    .slice(0, limit);
}

/** What the model is shown: what the correspondent wrote, above their quote. */
export function renderAsked(message: MailMessage): string {
  const own = unquoted(message.bodyText ?? message.preview);
  const body = own === '' ? (message.bodyText ?? message.preview) : own;
  return [
    `From: ${message.from[0]?.name ?? message.from[0]?.email ?? ''}`,
    `Subject: ${message.subject}`,
    '',
    body.slice(0, 2500),
  ].join('\n');
}

export interface AskedOptions {
  readonly llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export async function whatIsAsked(
  message: MailMessage,
  options: AskedOptions,
): Promise<string[]> {
  const prompt = createUserMessage({
    content: [{ type: 'text', text: renderAsked(message) }],
    source: { kind: 'plugin', plugin: 'dsh-mail-core', contextFormed: false },
  });
  const chunks: string[] = [];
  for await (const chunk of options.llm.stream({
    provider: options.provider,
    model: options.model,
    system: ASKED_SYSTEM_PROMPT,
    messages: [prompt],
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 400,
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text);
  }
  return parseAsks(chunks.join(''));
}
