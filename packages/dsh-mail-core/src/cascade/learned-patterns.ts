/**
 * Node 3's source: patterns accumulated from what the cascade already decided
 * (PRD section 4.2, step 3).
 *
 * The point is cost. Node 6 is the only node that costs money, and a mailbox
 * is mostly the same senders over and over — so classifying a recurring sender
 * once and remembering the answer is where the cascade's efficiency is
 * supposed to come from. The first dry run measured 10% settled without a
 * model call, with this node empty.
 *
 * What it is emphatically not: a way to guess. A learned pattern is evidence
 * about *this* mailbox, and everything here exists to keep it from becoming
 * more than its evidence supports.
 */

import type { MailCategory } from '../types.js';
import type { CascadeNode, LearnedPattern } from './types.js';

/** One decision, reduced to what a pattern can be learned from. */
export interface Observation {
  /** Full sender address, lowercased by {@link learnPatterns}. */
  readonly sender: string;
  /** RFC 2919 `List-Id`, when the message carried one. */
  readonly listId?: string | null | undefined;
  readonly category: MailCategory;
  readonly confidence: number;
  readonly decidedBy: CascadeNode;
}

/**
 * How much of a source's evidence must agree before it becomes a pattern.
 *
 * This was unanimity, and unanimity assumes a consistent labeller. Measured,
 * the labeller is not: the economy model agrees with a larger one on 65% of
 * this mailbox, so one stray verdict in eighteen destroyed a pattern. The
 * `license-review` list is exactly that — sixteen of eighteen messages agree
 * and the pattern was lost, taking 4.5% of the mailbox with it.
 *
 * 0.8 recovers it. What unanimity was actually protecting against — a
 * colleague's varied mail becoming a rule — survives with a wide margin: on
 * the same data the most consistent human sender reached 42%.
 */
export const DOMINANCE = 0.8;

export interface LearnOptions {
  /**
   * How many agreeing decisions before a sender becomes a pattern.
   *
   * Two is a coincidence. Three is the smallest number that distinguishes a
   * recurring sender from someone who wrote twice.
   */
  readonly minObservations?: number | undefined;
  /** See {@link DOMINANCE}. 1 restores strict unanimity. */
  readonly dominance?: number | undefined;
  /**
   * How sure a decision must be to count as evidence.
   *
   * A pattern learned from an uncertain answer makes that answer permanent and
   * free, which is the worst of both.
   */
  readonly minConfidence?: number | undefined;
  /** Ceiling on what a pattern may claim. See {@link MAX_PATTERN_CONFIDENCE}. */
  readonly maxConfidence?: number | undefined;
}

export const MIN_OBSERVATIONS = 3;
export const MIN_CONFIDENCE = 0.85;

/**
 * The most a learned pattern may ever claim.
 *
 * Deliberately below 1, and below the default threshold's neighbourhood is not
 * the point — the point is that a pattern is an inference from a handful of
 * past decisions, and a node that settles at 1 cannot be degraded by node 7 or
 * reviewed by anyone. Three separate defects in this cascade have been rules
 * claiming certainty they had not earned; this one is not going to be a
 * fourth.
 */
export const MAX_PATTERN_CONFIDENCE = 0.95;

/**
 * Derives sender patterns from past decisions.
 *
 * Only decisions the model made are evidence. A message a static rule settled
 * needs no pattern — it is already free — and learning from one would let a
 * rule's mistake harden into a pattern that outlives the rule.
 *
 * A sender whose decisions disagree yields nothing. Disagreement is the signal
 * that the sender is not a category, and a majority vote over three samples is
 * not a finding.
 */
export function learnPatterns(
  observations: readonly Observation[],
  options: LearnOptions = {},
): LearnedPattern[] {
  const minObservations = options.minObservations ?? MIN_OBSERVATIONS;
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const maxConfidence = options.maxConfidence ?? MAX_PATTERN_CONFIDENCE;
  const dominance = options.dominance ?? DOMINANCE;

  // Two groupings, and the list one matters more: a mailing list's messages
  // come from many senders, so grouping them by sender scatters the evidence
  // across people who each appear once. Measured on the target inbox, the
  // largest recurring source is a list that sender patterns could not see at
  // all.
  const byList = new Map<string, Observation[]>();
  const bySender = new Map<string, Observation[]>();

  for (const observation of observations) {
    if (observation.decidedBy !== 'llm') continue;
    if (observation.confidence < minConfidence) continue;

    const listId = observation.listId?.trim().toLowerCase();
    if (listId !== undefined && listId.length > 0) {
      push(byList, listId, observation);
      // A message that belongs to a list teaches about the list, not about
      // whoever happened to post it.
      continue;
    }
    const sender = observation.sender.trim().toLowerCase();
    // A person is not a category, and learning one is how a colleague
    // classified `important` three times becomes a rule answering `important`
    // for everything they ever send. A warm simulation put 61% of a mailbox
    // under that label, and this is half of the reason.
    //
    // The `List-Id` grouping was the right instinct applied to the other half:
    // services and lists emit one kind of message and can be learned; an
    // individual cannot.
    // Every sender, not only the ones whose address looks automated.
    //
    // That gate was a regex on the local part — `noreply`, `newsletter`,
    // `support` — and it is the same kind of universal heuristic that has
    // failed three times on this mailbox. Measured on 396 real verdicts it
    // halved what could be learned: it excluded `customer-service@ovh.com`,
    // unanimous over twenty messages, along with a tax-office correspondent, a
    // security vendor and three cold-outreach senders. Coverage 8% with it, 16%
    // without, for four points of agreement.
    //
    // What it was protecting against is a colleague getting a pattern, and
    // unanimity already does that with a wide margin: on the same data the most
    // consistent human sender reached 42%.
    if (sender.length > 0) push(bySender, sender, observation);
  }

  const patterns: LearnedPattern[] = [];
  for (const [listId, bucket] of byList) {
    const pattern = agree(bucket, minObservations, maxConfidence, dominance);
    if (pattern !== null) patterns.push({ listId, sender: null, subjectContains: null, ...pattern });
  }
  for (const [sender, bucket] of bySender) {
    const pattern = agree(bucket, minObservations, maxConfidence, dominance);
    if (pattern !== null) patterns.push({ listId: null, sender, subjectContains: null, ...pattern });
  }

  // Stable order, so a stored set does not churn between runs.
  return patterns.sort((a, b) =>
    `${a.listId ?? ''}${a.sender ?? ''}`.localeCompare(`${b.listId ?? ''}${b.sender ?? ''}`),
  );
}


function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/**
 * The category a bucket unanimously supports, or `null`.
 *
 * Unanimity, not a majority. Three samples cannot support a vote, and a source
 * that is sometimes important and sometimes bulk is exactly the one a pattern
 * must not answer for.
 */
function agree(
  bucket: readonly Observation[],
  minObservations: number,
  maxConfidence: number,
  dominance: number,
): { category: MailCategory; confidence: number } | null {
  if (bucket.length < minObservations) return null;

  const tally = new Map<MailCategory, number>();
  for (const o of bucket) tally.set(o.category, (tally.get(o.category) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (top === undefined) return null;
  const [category, count] = top;
  if (count / bucket.length < dominance) return null;
  // The cascade's own non-answer is not a category to learn: a pattern saying
  // "this sender is always unclassifiable" settles nothing and would stop the
  // model ever being asked again.
  if (category === 'needs-review') return null;

  const agreeing = bucket.filter((o) => o.category === category);
  const mean = agreeing.reduce((sum, o) => sum + o.confidence, 0) / agreeing.length;
  // Never above what the decisions themselves claimed, and never above the
  // ceiling. Volume makes a pattern eligible, not more certain.
  return { category, confidence: Math.min(mean, maxConfidence) };
}

/**
 * Merges freshly learned patterns over the stored ones.
 *
 * A sender the cascade has just re-decided replaces its own older pattern:
 * the mailbox is what changed, and the newer evidence is about the mailbox as
 * it is now.
 */
export function mergePatterns(
  stored: readonly LearnedPattern[],
  learned: readonly LearnedPattern[],
): LearnedPattern[] {
  const byKey = new Map<string, LearnedPattern>();
  const keyOf = (p: LearnedPattern): string | null =>
    p.listId !== null && p.listId !== undefined
      ? `list:${p.listId.toLowerCase()}`
      : p.sender !== null
        ? `from:${p.sender.toLowerCase()}`
        : null;

  for (const pattern of [...stored, ...learned]) {
    const key = keyOf(pattern);
    if (key !== null) byKey.set(key, pattern);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.listId ?? ''}${a.sender ?? ''}`.localeCompare(`${b.listId ?? ''}${b.sender ?? ''}`),
  );
}
