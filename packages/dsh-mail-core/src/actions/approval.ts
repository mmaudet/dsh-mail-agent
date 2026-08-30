/**
 * What the agent may do to a mailbox, and on whose say-so (PRD section 3.5).
 *
 * Deny by default. A pair the table does not name is refused, so adding an
 * action is a deliberate edit rather than an omission, and reading the table
 * tells an owner exactly what runs without them.
 *
 * The order of authority, from the measurements this project has already made:
 *
 * - The classifier splits sources it should not. Around 70% of a real mailbox
 *   is settled by the model, and the model answers a marketplace address under
 *   two categories and a colleague under five.
 * - So an action's authority follows how reversible it is, not how confident
 *   the cascade sounds. A keyword can be removed. A move can be undone by
 *   whoever finds the message. A send cannot be recalled, and Gmail purges its
 *   trash after thirty days.
 */

import type { MailCategory } from '../types.js';

/** Every category, so a blanket rule cannot silently miss one. */
const allCategories: readonly MailCategory[] = [
  'correspondance-commerciale-client',
  'obligations-administratives-echeance',
  'demande-interne',
  'planification-reunion-rdv',
  'incident-securite',
  'veille-newsletter',
  'support-technique-ticket',
  'rapport-compte-rendu-interne',
  'notifications-personnelles-diverses',
  'liste-diffusion',
  'recu-transaction',
  'rh-interne',
  'candidature-emploi',
  'prospection-commerciale-non-sollicitee',
  'spam-formulaire-contact',
  'phishing-arnaque',
  'needs-review',
];


/**
 * The things the agent can do. Ordered by how hard each is to undo, which is
 * the ordering the default policy is built on.
 */
export type MailAction =
  /** Write a `$twaky-*` classification tag. Reversible, and visible. */
  | 'keyword'
  /** Move between folders. Undoable by anyone who finds the message. */
  | 'move'
  /** Move to Trash. Undoable until the server purges it — thirty days on Gmail. */
  | 'trash'
  /** Write to Drafts. Nothing leaves. */
  | 'draft'
  /** Submit for delivery. Cannot be recalled. */
  | 'send';

export type Approval =
  /** The agent does it. */
  | 'auto'
  /** The agent proposes it and waits. */
  | 'ask'
  /** Not offered at all. */
  | 'never';

export interface ApprovalRule {
  readonly category: MailCategory;
  readonly action: MailAction;
  readonly approval: Approval;
  /**
   * Below this the rule does not apply and the pair falls through to `ask`.
   *
   * Node 7 already degrades a low-confidence answer to `needs-review`, so this
   * is a second floor for actions that deserve one: a category assigned at
   * 0.76 and one at 0.98 are the same to node 7 and are not the same thing to
   * act on.
   */
  readonly minConfidence?: number | undefined;
}

export interface ApprovalPolicy {
  readonly rules: readonly ApprovalRule[];
}

/**
 * The proposed default, to be amended rather than accepted.
 *
 * Every line traces to the PRD, and the ones that do not are marked. What an
 * owner should check when reading it: the `auto` rows, because those are the
 * ones that happen while they are asleep.
 */
export const DEFAULT_POLICY: ApprovalPolicy = {
  rules: [
    // --- tagging: reversible, visible, and the whole point of classifying ---
    // Every category gets its keyword written automatically. A tag asserts
    // nothing about the message beyond what the trace already records, and an
    // owner who disagrees removes it like any other flag.
    ...allCategories.map(
      (category): ApprovalRule => ({ category, action: 'keyword', approval: 'auto' }),
    ),

    // --- moving: proposed, not performed, until the traces earn it ---------
    // PRD section 4.5 files newsletters automatically, and the first dry run
    // over the real mailbox is why that is not the default here. Of twelve
    // messages it would have moved six, and among the six a bounce and a sales
    // enquiry, both filed out of the inbox. Two messages of one mailing-list
    // thread were classified differently from each other in the same run.
    //
    // A tag is reversible and visible; a move takes mail out of the place the
    // owner looks. The path back to `auto` is not an opinion:
    // `MailStore.efficiency` and the stored traces make a per-category error
    // rate measurable, and a category whose moves have been right over a
    // review window gets promoted on that evidence.
    //
    // Junk is the strictest floor because it is the move whose mistake an
    // owner is least likely to notice.
    { category: 'phishing-arnaque', action: 'move', approval: 'ask', minConfidence: 0.9 },
    { category: 'spam-formulaire-contact', action: 'move', approval: 'ask', minConfidence: 0.9 },
    ...(
      [
        'veille-newsletter',
        'support-technique-ticket',
        'rapport-compte-rendu-interne',
        'notifications-personnelles-diverses',
        'liste-diffusion',
        'recu-transaction',
        'candidature-emploi',
      ] as const
    ).map((category): ApprovalRule => ({ category, action: 'move', approval: 'ask', minConfidence: 0.8 })),

    // Nothing in the `acts` band moves on its own, and `rh-interne` has no
    // destination to move to. `needs-review` is by definition the cascade
    // saying it does not know, which is not a reason to move anything.
    ...(
      [
        'correspondance-commerciale-client',
        'obligations-administratives-echeance',
        'demande-interne',
        'planification-reunion-rdv',
        'incident-securite',
        'rh-interne',
        'prospection-commerciale-non-sollicitee',
      ] as const
    ).map((category): ApprovalRule => ({ category, action: 'move', approval: 'ask' })),
    { category: 'needs-review', action: 'move', approval: 'never' },

    // --- trash: never automatic, whatever the category ----------------------
    // Not in the PRD at all: its vocabulary stops at Junk. Offered as `ask`
    // because an owner asked for it, and never as `auto`, because it is the
    // only action whose effect becomes irreversible by the passage of time.
    ...allCategories.map(
      (category): ApprovalRule => ({ category, action: 'trash', approval: 'ask' }),
    ),

    // --- drafting: writing is free, sending is not --------------------------
    // A draft in Drafts is a proposal the owner reads before anything leaves.
    // `ask` for now on the same evidence as the moves: a reply drafted from a
    // misclassification is a reply to the wrong message.
    // The `acts` band only: a draft is a proposed answer, and the categories
    // that ask nothing have nothing to answer. `incident-securite` is out
    // because it is escalated to a person, not replied to.
    ...(
      [
        'correspondance-commerciale-client',
        'obligations-administratives-echeance',
        'demande-interne',
        'planification-reunion-rdv',
      ] as const
    ).map((category): ApprovalRule => ({ category, action: 'draft', approval: 'ask' })),

    // PRD 4.4: never sent automatically, the owner keeps 100% of the control.
    // Listed explicitly rather than left to the default, because this is the
    // line the whole design is arranged around and it should be readable.
    ...allCategories.map(
      (category): ApprovalRule => ({ category, action: 'send', approval: 'ask' }),
    ),
  ],
};

/**
 * What the policy says about one action on one classified message.
 *
 * A pair no rule names is `never`: the table is the whole permission, and a
 * category added later must be granted deliberately rather than inherit
 * anything.
 */
export function approvalFor(
  policy: ApprovalPolicy,
  category: MailCategory,
  action: MailAction,
  confidence: number,
): Approval {
  const rule = policy.rules.find((r) => r.category === category && r.action === action);
  if (rule === undefined) return 'never';
  // Below its floor a rule does not apply, and the fallback is to ask rather
  // than to refuse: the agent still has something to propose.
  if (rule.minConfidence !== undefined && confidence < rule.minConfidence) {
    return rule.approval === 'never' ? 'never' : 'ask';
  }
  return rule.approval;
}

/** Renders the policy as a table, for an owner deciding whether to accept it. */
export function describePolicy(policy: ApprovalPolicy): string {
  const auto = policy.rules.filter((r) => r.approval === 'auto');
  const lines = ['Runs without asking:'];
  for (const r of auto) {
    const floor = r.minConfidence === undefined ? '' : ` (confidence ≥ ${String(r.minConfidence)})`;
    lines.push(`  ${r.action.padEnd(8)} ${r.category}${floor}`);
  }
  lines.push('', `Everything else asks first, or is not offered. ${String(policy.rules.length)} rules.`);
  return lines.join('\n');
}
