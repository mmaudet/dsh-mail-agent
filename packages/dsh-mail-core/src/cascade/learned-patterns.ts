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

  const bySender = new Map<string, Observation[]>();
  for (const observation of observations) {
    if (observation.decidedBy !== 'llm') continue;
    if (observation.confidence < minConfidence) continue;
    const sender = observation.sender.trim().toLowerCase();
    if (sender.length === 0) continue;
    const bucket = bySender.get(sender);
    if (bucket === undefined) bySender.set(sender, [observation]);
    else bucket.push(observation);
  }

  const patterns: LearnedPattern[] = [];
  for (const [sender, bucket] of bySender) {
    if (bucket.length < minObservations) continue;

    const category = bucket[0]?.category;
    if (category === undefined) continue;
    // Unanimity, not a majority. Three samples cannot support a vote, and a
    // sender who is sometimes important and sometimes bulk is exactly the one
    // a pattern must not answer for.
    if (!bucket.every((o) => o.category === category)) continue;

    const mean = bucket.reduce((sum, o) => sum + o.confidence, 0) / bucket.length;
    patterns.push({
      sender,
      subjectContains: null,
      category,
      // Never above what the decisions themselves claimed, and never above the
      // ceiling. Volume makes a pattern eligible, not more certain.
      confidence: Math.min(mean, maxConfidence),
    });
  }

  // Stable order, so a stored set does not churn between runs.
  return patterns.sort((a, b) => (a.sender ?? '').localeCompare(b.sender ?? ''));
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
  const bySender = new Map<string, LearnedPattern>();
  for (const pattern of stored) {
    if (pattern.sender !== null) bySender.set(pattern.sender.toLowerCase(), pattern);
  }
  for (const pattern of learned) {
    if (pattern.sender !== null) bySender.set(pattern.sender.toLowerCase(), pattern);
  }
  return [...bySender.values()].sort((a, b) => (a.sender ?? '').localeCompare(b.sender ?? ''));
}
