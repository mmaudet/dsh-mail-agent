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
import { detectLanguage, languageName } from './language.js';
import { describeRegister } from './register.js';
import { describeReformulations, type Reformulation } from './reformulations.js';

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
  /**
   * Drafts the owner rewrote, newest first. Six statistical rules about how
   * they write have been refuted; a draft they corrected has not been.
   */
  readonly reformulations?: readonly Reformulation[] | undefined;
  /**
   * The owner's own names, so a greeting can be told from one addressed to
   * somebody else. `Identity/get` supplies them.
   */
  readonly ownNames?: readonly string[] | undefined;
  /**
   * Whether the draft signs off.
   *
   * True by default, and that default is measured rather than assumed: of 49
   * replies this owner sent, 40 carry the `-- ` separator that means their
   * account appended a signature block, and 27 end with their own name *above*
   * it. They sign, and then the block follows. Set false only for an owner
   * whose Sent folder says otherwise.
   */
  readonly signs?: boolean | undefined;
  readonly message: MailMessage;
  readonly category: MailCategory;
  readonly style: StyleProfile;
  readonly owner: string;
  /**
   * One line from the owner saying what to answer.
   *
   * The measurement that produced this: drafts written from the message alone
   * were right in style and empty in substance, because what to say is not in
   * the message. The owner supplies it in a sentence — spoken or typed — and
   * the model supplies the words.
   *
   * It also carries the owner's authority, which nothing else in a draft does.
   * Absent, the draft may acknowledge and propose but never commit; present,
   * it may commit exactly what the instruction says, because the owner just
   * said it.
   */
  readonly instruction?: string | undefined;
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
  '1. Answer in the language of the message you are replying to. The owner',
  '   writes their instruction in their own language whatever the',
  '   correspondent\'s: follow what it says, never the language it says it in.',
  '   When a language is named below, that one is the answer, not this rule.',
  '2. Never invent a fact. Not a date, a price, a name, a commitment, or an',
  '   attachment. If answering properly needs something only the owner knows,',
  '   leave a bracketed gap — [date] — rather than filling it. A draft with a',
  '   gap is edited in five seconds; an invented date is sent and is wrong.',
  '3. If the owner gave an instruction below, it is what to say, and it is the',
  '   only thing you may commit to on their behalf. Connect it to what they',
  '   were actually asked: if the message asks for a meeting and the',
  '   instruction says a colleague is taking over, say the colleague will come',
  '   back to them about the meeting. Answering beside the question reads as',
  '   not having read it. But add nothing the instruction does not contain -',
  '   no date, no availability, no offer, no next step of your own. With no',
  '   instruction, you may acknowledge, ask and confirm receipt, and you may',
  '   not accept, commit, quote a price, or promise a deadline.',
  '4. A draft is material to edit, not a message to send. The owner deletes',
  '   faster than they write, so cover everything the message raises and let',
  '   them cut. Take every question it asks in turn — if it asks three things,',
  '   answer three things, one short paragraph each. Use what is quoted below',
  '   the message: it is the conversation this reply joins. The length above',
  '   describes what they send, after editing; a draft may be longer.',
  '5. Write as the owner, in the first person, never about them.',
  '6. Sign off the way they do, with the short form above. Their full',
  '   signature block is appended afterwards from their mail account; it does',
  '   not replace the closing line, it follows it.',
  '',
  'How the owner writes:',
].join('\n');

/** The user-side message: the style, then the mail being answered. */
export function renderDraftRequest(request: DraftRequest): string {
  const { message, instruction } = request;
  const from = message.from[0];
  const sender = from === undefined ? '(unknown)' : `${from.name ?? ''} <${from.email}>`.trim();
  // The body is not truncated as hard as the classifier's. A classifier needs
  // enough to recognise a kind; a reply has to answer what was actually asked,
  // and the ask is often at the bottom.
  const body = (message.bodyText ?? message.preview).slice(0, 4000);

  // The instruction comes last, immediately before the answer is written,
  // because a model asked to hold a rule across four thousand characters of
  // somebody else's prose holds it less well than one reminded of it at the end.
  const told = instruction !== undefined && instruction.trim() !== '';
  // A fact rather than a rule. The rule was already there and lost, twice out
  // of thirteen, to a French instruction sitting immediately above the answer.
  const language = detectLanguage(message.bodyText ?? message.preview);
  // How they were addressed, read off this message rather than averaged over
  // the owner's habits: 71 of their 148 greetings carry a name, which is
  // neither a habit nor its absence. What decides it is whether the
  // correspondent named them first.
  const register = describeRegister(message, request.ownNames ?? []);
  // Never the correction made on this very message: that is replay.
  const rewritten = describeReformulations(
    request.reformulations ?? [],
    undefined,
    message.id,
  );

  return [
    describeStyle(request.style, { signs: request.signs ?? true }),
    rewritten === null ? null : '',
    rewritten,
    '',
    '---',
    '',
    language === null ? null : `Write the reply in ${languageName(language)}.`,
    language === null ? null : '',
    told
      ? 'Draft the owner\'s reply to the message below. What to say is at the end.'
      : `This message has been classified ${request.category}, meaning the owner is\nexpected to act on it. Draft their reply.`,
    '',
    `From: ${sender}`,
    `Subject: ${message.subject}`,
    register === null ? null : '',
    register,
    '',
    body,
    ...(told
      ? [
          '',
          '---',
          '',
          language === null
            ? 'The owner says to answer this, in their words:'
            : 'The owner says to answer this. Their words below are not necessarily in ' +
              `${languageName(language)}; the reply must be.`,
          '',
          instruction.trim(),
        ]
      : []),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
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
  const told = request.instruction !== undefined && request.instruction.trim() !== '';
  // The category decides what to offer unprompted. It does not get to veto a
  // reply the owner has asked for: they have seen the message and said write.
  if (!told && !draftable(request.category)) return null;
  const raw = await model.draft(request);
  const bodyText = cleanDraft(raw);
  if (bodyText.length === 0) return null;
  return {
    bodyText,
    because: told
      ? `the owner asked for this reply: ${request.instruction?.trim() ?? ''}`
      : `${request.category}: the owner is expected to answer this`,
  };
}
