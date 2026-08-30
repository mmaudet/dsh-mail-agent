/**
 * The cascade's vocabulary (PRD section 4.2 and 4.6).
 *
 * Seven nodes in a fixed order, each cheaper than the one after it. The point
 * of the ordering is cost: a message a static rule can settle must never reach
 * the model, and the decision trace records which node settled it so that
 * property is measurable rather than assumed.
 */

import type { MailCategory, MailMessage } from '../types.js';

/**
 * The cascade nodes, in evaluation order (PRD section 4.2).
 *
 * `below-threshold` is not a node that decides: it is what node 7 degrades a
 * low-confidence answer to.
 */
export type CascadeNode =
  | 'thread-continuity'
  | 'spam-prefilter'
  | 'stated-route'
  | 'learned-pattern'
  | 'static-rule'
  | 'brand-spoofing'
  | 'llm'
  | 'below-threshold';

export const CASCADE_NODES = [
  'thread-continuity',
  'spam-prefilter',
  'stated-route',
  'learned-pattern',
  'static-rule',
  'brand-spoofing',
  'llm',
  'below-threshold',
] as const satisfies readonly CascadeNode[];

/**
 * What one node answers when asked about a message.
 *
 * `null` means "not mine, keep going". A node that decides returns a category
 * and says how sure it is, so node 7 can apply one threshold to all of them
 * rather than each node inventing its own.
 */
export interface NodeVerdict {
  readonly category: MailCategory;
  /** 0 to 1. A deterministic node that is certain returns 1. */
  readonly confidence: number;
  /** One line, for whoever reads the trace. Never a credential or a body. */
  readonly rationale: string;
}

/** One node of the cascade. Pure with respect to the message it is given. */
export interface CascadeStage {
  readonly node: CascadeNode;
  decide(message: MailMessage, context: CascadeContext): Promise<NodeVerdict | null>;
}

/**
 * What a node may know beyond the message itself.
 *
 * Deliberately small and explicit: a node that needs more has to have it added
 * here, which is where the cost of that knowledge becomes visible.
 */
export interface CascadeContext {
  /** The mailbox owner, for "is this addressed to me" reasoning. */
  readonly owner: string;
  /** Addresses whose mail is always `important` (PRD section 4.2, node 4). */
  readonly vipSenders: readonly string[];
  /** Domains treated as corporate, matched on the sender's domain. */
  readonly corporateDomains: readonly string[];
  /**
   * Category already assigned to this message's thread, when the owner has
   * acted in it before (PRD section 4.2, node 1).
   */
  readonly threadCategory: MailCategory | null;
  /** Patterns learned per owner (PRD section 4.2, node 3). */
  readonly learnedPatterns: readonly LearnedPattern[];
  /**
   * Routes the owner stated, checked before anything is inferred.
   *
   * Measured on the target mailbox: a table keyed on `List-Id`, falling back to
   * the sender address, covers 33% of the mail with 36 rules — against the 3%
   * the inferring nodes settle cold. Every generic rule tried on this mailbox
   * failed (`List-Unsubscribe` and `List-Id` both claimed to hold everywhere
   * and did not); what holds is facts about one owner.
   *
   * Separate from `learnedPatterns` on purpose. They have the same shape and
   * the same use, but `savePatterns` replaces its whole set on every learning
   * pass, and a stated route sharing that table would be deleted by a routine
   * nobody would think to check.
   */
  readonly statedRoutes: readonly RoutingRule[];
}

/**
 * A route the owner asserted, rather than one observed.
 *
 * No confidence field: a stated route is the owner telling the agent a fact
 * about their own mail, and there is nothing to be unsure about. That is also
 * why it is never pruned — the weekly review prunes what it inferred, not what
 * it was told.
 */
export interface RoutingRule {
  /** Matched against the message's RFC 2919 `List-Id`, case-insensitively. */
  readonly listId?: string | null | undefined;
  /** Matched against the sender's full address, case-insensitively. */
  readonly sender: string | null;
  readonly category: MailCategory;
  /**
   * Why the owner stated it, for the day they no longer remember.
   *
   * Measured need: on the target mailbox the company's own `vente@` alias
   * routes to `phishing-arnaque`, because contact-form spam transits through
   * it. A rule that surprising has to carry its reason or it gets deleted by
   * the next person who reads the table.
   */
  readonly note?: string | undefined;
}

/**
 * A statistical pattern accumulated for one owner.
 *
 * Phase 2 consumes these; the weekly LLM review that produces and prunes them
 * is a later phase, so nothing here writes them.
 */
export interface LearnedPattern {
  /**
   * Matched against the message's RFC 2919 `List-Id`, case-insensitively.
   *
   * Checked before the sender, because a list is the thing that has a
   * category: its messages come from many people, and on a real inbox the
   * largest recurring source is a list no sender pattern could ever catch.
   */
  readonly listId?: string | null | undefined;
  /** Matched against the sender's full address, case-insensitively. */
  readonly sender: string | null;
  /** Matched as a case-insensitive substring of the subject. */
  readonly subjectContains: string | null;
  readonly category: MailCategory;
  /** How much evidence stands behind it, 0 to 1. */
  readonly confidence: number;
}

/**
 * The record of one classification (PRD section 4.6).
 *
 * Every field exists so a decision can be argued with afterwards: which node
 * settled it, what the earlier nodes said, what it cost. `steps` holds every
 * node that ran, in order, including those that declined.
 */
export interface DecisionTrace {
  readonly messageId: string;
  readonly decidedBy: CascadeNode;
  readonly category: MailCategory;
  readonly confidence: number;
  readonly rationale: string;
  readonly steps: readonly TraceStep[];
  /** True when node 6 ran. The efficiency KPI counts these. */
  readonly usedModel: boolean;
  readonly startedAt: Date;
  readonly durationMs: number;
}

export interface TraceStep {
  readonly node: CascadeNode;
  /** `null` when the node declined and the cascade moved on. */
  readonly verdict: NodeVerdict | null;
  readonly durationMs: number;
}

/**
 * The model-backed node, behind a port.
 *
 * Node 6 is the only one that leaves the process. Keeping it an interface is
 * what lets the other six be tested without a network, and what lets the
 * cascade degrade to static-only when the gateway is down (PRD section 3.6).
 */
export interface ClassifierModel {
  classify(message: MailMessage, context: CascadeContext): Promise<NodeVerdict>;
}

/** Below this, node 7 degrades the answer to `needs-review` (PRD section 4.2). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

/**
 * What `runCascade` needs beyond the message.
 *
 * `model` is nullable rather than optional: a caller whose gateway health
 * check has failed passes `null` deliberately, and the cascade running
 * static-only is a documented outcome (PRD section 3.6), not a mistake.
 */
export interface CascadeOptions {
  readonly context: CascadeContext;
  readonly model: ClassifierModel | null;
  /** Defaults to {@link DEFAULT_CONFIDENCE_THRESHOLD}. */
  readonly confidenceThreshold?: number | undefined;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}
