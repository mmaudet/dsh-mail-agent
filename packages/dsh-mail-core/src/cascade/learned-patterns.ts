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

export interface LearnOptions {
  /**
   * How many agreeing decisions before a sender becomes a pattern.
   *
   * Two is a coincidence. Three is the smallest number that distinguishes a
   * recurring sender from someone who wrote twice.
   */
  readonly minObservations?: number | undefined;
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
    if (sender.length > 0 && looksAutomated(sender)) push(bySender, sender, observation);
  }

  const patterns: LearnedPattern[] = [];
  for (const [listId, bucket] of byList) {
    const pattern = agree(bucket, minObservations, maxConfidence);
    if (pattern !== null) patterns.push({ listId, sender: null, subjectContains: null, ...pattern });
  }
  for (const [sender, bucket] of bySender) {
    const pattern = agree(bucket, minObservations, maxConfidence);
    if (pattern !== null) patterns.push({ listId: null, sender, subjectContains: null, ...pattern });
  }

  // Stable order, so a stored set does not churn between runs.
  return patterns.sort((a, b) =>
    `${a.listId ?? ''}${a.sender ?? ''}`.localeCompare(`${b.listId ?? ''}${b.sender ?? ''}`),
  );
}

/**
 * Whether an address looks like a service rather than a person.
 *
 * A heuristic, and deliberately a conservative one: it decides what may be
 * *learned*, so a false negative costs a model call and a false positive
 * teaches a rule about somebody's colleague. Erring towards the model is the
 * cheaper mistake.
 *
 * Mailing lists do not come through here at all — they group by `List-Id`,
 * which is a better signal than any address shape.
 */
export function looksAutomated(sender: string): boolean {
  const local = sender.split('@')[0] ?? '';
  return AUTOMATED_LOCAL.test(local);
}

const AUTOMATED_LOCAL =
  /^(?:no[-._]?reply|donotreply|ne[-.]?pas[-.]?repondre|nepasrepondre|notifications?|alerts?|news(?:letter)?s?|mailer|bounce|postmaster|support|contact|info|hello|team|billing|invoices?|accounts?|service|admin|noc|automated?|robot|bot|system|daemon)(?:[-._+].*)?$/i;

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
): { category: MailCategory; confidence: number } | null {
  if (bucket.length < minObservations) return null;
  const category = bucket[0]?.category;
  if (category === undefined) return null;
  if (!bucket.every((o) => o.category === category)) return null;

  const mean = bucket.reduce((sum, o) => sum + o.confidence, 0) / bucket.length;
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
