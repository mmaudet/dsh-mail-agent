/**
 * Drafting a reply the owner might have written (PRD section 5).
 *
 * A draft is a proposal, never a send. PRD section 4.4 keeps sending entirely
 * with the owner, the approval policy has no `auto` for it under any
 * provenance, and nothing here can reach the network.
 *
 * The prompt is built from facts rather than adjectives. A model told to write
 * "warmly and concisely" writes what it was going to write; a model told the
 * reply should be about a hundred words, open with "Bonjour," and end with
 * "Michel-Marie" produces something the owner recognises. The examples carry
 * the rest, because a paraphrase of a voice is not that voice.
 */

import type { MailMessage } from '../types.js';
import type { MailCategory } from '../types.js';
import { describeStyle, type StyleProfile } from './style-profile.js';

/**
 * The categories a draft is offered for.
 *
 * The `acts` band minus `incident-securite`, which is escalated to a person
 * rather than answered, and minus everything that asks nothing — drafting a
 * reply to a newsletter is a way of wasting the owner's attention rather than
 * saving it.
 */
export const DRAFTABLE: ReadonlySet<MailCategory> = new Set([
  'correspondance-commerciale-client',
  'obligations-administratives-echeance',
  'demande-interne',
  'planification-reunion-rdv',
]);

export interface DraftRequest {
  readonly message: MailMessage;
  readonly category: MailCategory;
  readonly style: StyleProfile;
  readonly owner: string;
}

export interface Draft {
  readonly bodyText: string;
  /** Why the agent thinks a reply is owed, in one line, for the owner. */
  readonly because: string;
}

/** Whether a draft is worth offering at all. */
export function draftable(category: MailCategory): boolean {
  return DRAFTABLE.has(category);
}

export const DRAFT_SYSTEM_PROMPT = [
  'You draft a reply for the owner of a mailbox to review. You never send it.',
  '',
  'Write only the reply body: no subject line, no headers, no quoted thread,',
  'and no commentary about what you wrote or why.',
  '',
  'Rules, in order of how badly breaking them shows:',
  '',
  '1. Answer in the language the message you are replying to is written in.',
  '2. Never invent a fact. Not a date, a price, a name, a commitment, or an',
  '   attachment. If answering properly needs something only the owner knows,',
  '   leave a bracketed gap — [date] — rather than filling it. A draft with a',
  '   gap is edited in five seconds; an invented date is sent and is wrong.',
  '3. Never agree to anything on the owner\'s behalf. You may acknowledge, ask,',
  '   confirm receipt, and propose that the owner will do something. You may',
  '   not accept, commit, quote a price, or promise a deadline.',
  '4. Match the length below. These replies are short. A long draft is not more',
  '   helpful; it is more to delete.',
  '5. Write as the owner, in the first person, never about them.',
  '',
  'How the owner writes:',
].join('\n');

/** The user-side message: the style, then the mail being answered. */
export function renderDraftRequest(request: DraftRequest): string {
  const { message } = request;
  const from = message.from[0];
  const sender = from === undefined ? '(unknown)' : `${from.name ?? ''} <${from.email}>`.trim();
  // The body is not truncated as hard as the classifier's. A classifier needs
  // enough to recognise a kind; a reply has to answer what was actually asked,
  // and the ask is often at the bottom.
  const body = (message.bodyText ?? message.preview).slice(0, 4000);

  return [
    describeStyle(request.style),
    '',
    '---',
    '',
    `This message has been classified ${request.category}, meaning the owner is`,
    'expected to act on it. Draft their reply.',
    '',
    `From: ${sender}`,
    `Subject: ${message.subject}`,
    '',
    body,
  ].join('\n');
}

/** Removes what a model adds around a reply it was asked to write bare. */
export function cleanDraft(raw: string): string {
  let text = raw.trim();
  // Models fence prose about as often as code, and a fence in a mail body is
  // the most visible possible sign that nobody read the draft before sending.
  const fenced = /^```(?:\w+)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  // A subject line, which was asked for and not wanted.
  text = text.replace(/^(Subject|Objet)\s*:.*\n+/i, '');
  return text.trim();
}

export interface DraftModel {
  draft(request: DraftRequest): Promise<string>;
}

/**
 * Builds the draft, or `null` when the category does not warrant one.
 *
 * `null` rather than an empty draft: a caller that gets a draft object with
 * nothing in it will render it, and an empty proposal in the Drafts folder is
 * worse than no proposal.
 */
export async function draftReply(
  request: DraftRequest,
  model: DraftModel,
): Promise<Draft | null> {
  if (!draftable(request.category)) return null;
  const raw = await model.draft(request);
  const bodyText = cleanDraft(raw);
  if (bodyText.length === 0) return null;
  return {
    bodyText,
    because: `${request.category}: the owner is expected to answer this`,
  };
}
