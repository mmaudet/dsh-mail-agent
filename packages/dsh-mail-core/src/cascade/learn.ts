/**
 * The pass that turns stored decisions into patterns node 3 can use.
 *
 * `learnPatterns` and `mergePatterns` have existed since Phase 2 and nothing
 * called them, so node 3 read an empty list on every message no matter how long
 * the agent had been running. This is the missing half: the read side was wired
 * with the store, and this is the write side.
 *
 * It is deliberately not a tool. What it produces is `learned`, never `stated`,
 * and the approval policy grants nothing automatic to a learned pattern — an
 * agent that could promote its own inferences to assertions would be granting
 * itself the authority the provenance rule exists to withhold.
 */

import type { MailStore } from '../store/mail-store.js';
import { learnPatterns, mergePatterns, type LearnOptions } from './learned-patterns.js';
import type { LearnedPattern } from './types.js';

export interface LearnResult {
  /** How many model decisions the pass had to reason from. */
  readonly observations: number;
  /** What it holds now. */
  readonly patterns: readonly LearnedPattern[];
  /** Patterns that are new since the last pass. */
  readonly added: number;
  /** Patterns that were held before and are no longer supported. */
  readonly dropped: number;
}

/**
 * Runs one learning pass and stores the result.
 *
 * Whole-set rather than incremental, because `mergePatterns` already decides
 * what survives, and two places deciding that is how a pattern nobody can
 * explain ends up in the table.
 */
export function learn(store: MailStore, options: LearnOptions = {}): LearnResult {
  const observations = store.observations();
  const before = store.loadPatterns();
  const merged = mergePatterns(before, learnPatterns(observations, options));

  const key = (p: LearnedPattern): string =>
    p.listId !== null && p.listId !== undefined
      ? `list:${p.listId.toLowerCase()}`
      : `from:${(p.sender ?? '').toLowerCase()}`;
  const had = new Set(before.map(key));
  const has = new Set(merged.map(key));

  store.savePatterns(merged);
  return {
    observations: observations.length,
    patterns: merged,
    added: merged.filter((p) => !had.has(key(p))).length,
    dropped: before.filter((p) => !has.has(key(p))).length,
  };
}

/** One line for an operator, naming what changed rather than what is held. */
export function describeLearn(result: LearnResult): string {
  return (
    `${String(result.patterns.length)} patterns from ${String(result.observations)} model decisions` +
    ` (+${String(result.added)}, -${String(result.dropped)})`
  );
}
