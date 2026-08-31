/**
 * Drafts the owner rewrote, carried into the next prompt.
 *
 * Six generic rules about how this owner writes have now been measured and
 * refuted: recipient position, thread state, thread context, enumerated
 * intent, addressing, and — this morning — whether they greet somebody by name
 * (63% of first contacts, 40% of people they already write to, which is no
 * signal at all). Every one was an attempt to derive a habit from statistics
 * over their mail.
 *
 * What has never failed is a fact they stated. A rewritten draft is the
 * densest one available: the same message, their words instead of the model's,
 * with the difference between the two being exactly what the prompt is missing.
 *
 * So this carries no rules. It shows the pair and lets the model read it, the
 * way `StyleProfile.examples` carries whole replies rather than adjectives
 * about them.
 */

/** One draft and what the owner replaced it with. */
export interface Reformulation {
  /**
   * The message the correction was made on.
   *
   * Kept so a message is never shown its own correction: drafting it again
   * with the answer in the prompt is replay, and it scores perfectly while
   * proving nothing.
   */
  readonly messageId?: string | undefined;
  /** What the message was about, so the pair is legible. */
  readonly subject: string;
  /** What the agent produced. */
  readonly drafted: string;
  /** What the owner wanted instead. */
  readonly wanted: string;
}

/**
 * How many pairs a prompt carries.
 *
 * Three, like the style profile's examples: enough to show a pattern, few
 * enough that the message being answered is still most of what the model reads.
 */
export const MAX_REFORMULATIONS = 3;

/**
 * The pairs, as the prompt states them.
 *
 * Newest first, which is the caller's job: a correction the owner made today
 * describes how they write now better than one from three weeks ago.
 */
export function describeReformulations(
  reformulations: readonly Reformulation[],
  limit = MAX_REFORMULATIONS,
  drafting?: string,
): string | null {
  const kept = reformulations
    .filter((r) => r.wanted.trim() !== '')
    .filter((r) => drafting === undefined || r.messageId !== drafting)
    .slice(0, limit);
  if (kept.length === 0) return null;
  const lines = [
    'Drafts this owner rewrote. The difference between the two is what they',
    'want and the model missed — read them, do not copy their subject matter:',
  ];
  for (const r of kept) {
    lines.push(
      '',
      `--- about: ${r.subject}`,
      'the draft:',
      r.drafted.trim(),
      '',
      'what they sent instead:',
      r.wanted.trim(),
    );
  }
  return lines.join('\n');
}
