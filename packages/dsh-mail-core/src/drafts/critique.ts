/**
 * A second pass over a draft, and a deliberately narrow one.
 *
 * The owner proposed looping two models until they agree the draft is good.
 * The loop is worth having; the stopping rule is not. Two models agreeing is
 * not evidence — they share their blind spots, and a loop that optimises for
 * agreement converges on something fluent and confident, which is exactly the
 * shape of a draft carrying a commitment the owner never made.
 *
 * So the critic judges form and nothing else. It may say a question went
 * unanswered, that the register does not match, or that a sentence asserts
 * something the instruction does not contain. It may not propose content: the
 * draft's length is bounded by what the owner dictated, measured at roughly
 * one word of draft per word of instruction, and everything past that boundary
 * is invention.
 *
 * The loop stops when the critic has no findings left, not when two models
 * congratulate each other.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { MailMessage } from '../types.js';

/** What a critic is allowed to object to. */
export type FindingKind =
  /** A question in the message that the draft does not address. */
  | 'unanswered'
  /** Greeting, tu/vous or formality that does not match the message. */
  | 'register'
  /** A claim that is in neither the instruction nor the message. */
  | 'unsupported';

export interface Finding {
  readonly kind: FindingKind;
  /** One line, quoting what is wrong. */
  readonly detail: string;
}

export const CRITIQUE_SYSTEM_PROMPT = [
  'You review a draft reply against the message it answers and the one-line',
  'instruction its author gave. You do not rewrite it and you do not suggest',
  'anything to add.',
  '',
  'Report only these three faults:',
  '',
  'unanswered  — the message asks something the draft does not address.',
  'register    — the greeting, the tu/vous, or the level of formality does not',
  '              match the message being answered.',
  'unsupported — the draft asserts something that is in neither the',
  '              instruction nor the message. A date, a name, a commitment, a',
  '              capability. This one matters most: the author signs and sends',
  '              this.',
  '',
  'A draft that is short is not a fault. The instruction bounds what can be',
  'said, and saying less than it is better than saying more than it.',
  '',
  'Answer as JSON and nothing else:',
  '{"findings": [{"kind": "unanswered", "detail": "..."}]}',
  'An empty list means the draft is sound. Say so rather than inventing a',
  'reservation to look thorough.',
].join('\n');

const KINDS: readonly string[] = ['unanswered', 'register', 'unsupported'];

/**
 * Reads the critic's answer.
 *
 * An unreadable reply is no findings, not a failed round: the loop's job is to
 * improve a draft, and a broken critic must not be able to hold one hostage.
 */
export function parseFindings(raw: string): Finding[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  const findings: Finding[] = [];
  for (const entry of list) {
    const kind = (entry as { kind?: unknown }).kind;
    const detail = (entry as { detail?: unknown }).detail;
    if (typeof kind !== 'string' || !KINDS.includes(kind)) continue;
    if (typeof detail !== 'string' || detail.trim() === '') continue;
    findings.push({ kind: kind as FindingKind, detail: detail.slice(0, 200) });
  }
  return findings;
}

/** What the critic is shown. */
export function renderCritique(
  message: MailMessage,
  instruction: string,
  draft: string,
): string {
  return [
    'The message being answered:',
    '',
    (message.bodyText ?? message.preview).slice(0, 2500),
    '',
    '---',
    '',
    'What the author said to reply:',
    instruction.trim() === '' ? '(nothing — they only asked for a reply)' : instruction.trim(),
    '',
    '---',
    '',
    'The draft:',
    draft,
  ].join('\n');
}

/** What a reviser is told, on top of the drafting prompt. */
export function renderRevision(draft: string, findings: readonly Finding[]): string {
  return [
    'Here is your draft:',
    '',
    draft,
    '',
    'A reviewer found these faults. Fix them and change nothing else. Do not',
    'add facts, dates, names or commitments to satisfy a fault — if a question',
    'cannot be answered from the instruction, say only that it will be',
    'answered, or leave it out.',
    '',
    ...findings.map((f) => `- ${f.kind}: ${f.detail}`),
  ].join('\n');
}

export interface CritiqueOptions {
  readonly llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

/** One review pass. */
export async function critique(
  message: MailMessage,
  instruction: string,
  draft: string,
  options: CritiqueOptions,
): Promise<Finding[]> {
  const prompt = createUserMessage({
    content: [{ type: 'text', text: renderCritique(message, instruction, draft) }],
    source: { kind: 'plugin', plugin: 'dsh-mail-core', contextFormed: false },
  });
  const chunks: string[] = [];
  for await (const chunk of options.llm.stream({
    provider: options.provider,
    model: options.model,
    system: CRITIQUE_SYSTEM_PROMPT,
    messages: [prompt],
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 600,
  })) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text);
  }
  return parseFindings(chunks.join(''));
}

/** How many times a draft is revised before the loop gives up. */
export const MAX_ROUNDS = 3;

export interface RefineResult {
  readonly draft: string;
  /** How many revisions actually ran. */
  readonly rounds: number;
  /** What the last review still objected to, if anything. */
  readonly remaining: readonly Finding[];
  /** Every round's findings, oldest first, so the loop can be inspected. */
  readonly history: readonly (readonly Finding[])[];
}
