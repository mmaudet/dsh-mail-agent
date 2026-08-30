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

import type { CascadeNode } from '../cascade/types.js';
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
  /**
   * Only applies when this node settled the message.
   *
   * Confidence cannot express the distinction that matters here. A model may
   * return 1.0, and a stated route always does, so a floor of 1 would grant
   * both. What separates them is provenance: `stated-route` is the owner
   * asserting a fact about their own mail, and it is the same answer whichever
   * model is deployed.
   *
   * Measured, not assumed: over 400 messages the automatic trash rule took 89
   * under Mistral and 11 under Qwen, so 78 messages — 20% of the mailbox —
   * were deleted or kept by nothing but which model was running. A rule whose
   * scope is a property of the model has no business being irreversible.
   *
   * Absent means the rule applies whichever node decided.
   */
  readonly decidedBy?: CascadeNode | undefined;
}

/** What the cascade concluded, which is all the policy needs to see. */
export interface Decision {
  readonly category: MailCategory;
  readonly confidence: number;
  readonly decidedBy: CascadeNode;
}

export interface ApprovalPolicy {
  readonly rules: readonly ApprovalRule[];
}

/**
 * What an owner can actually route something to.
 *
 * `needs-review` is the cascade saying it does not know, and node 2b never
 * answers it — so granting a stated route anything for it is a rule that can
 * never fire, and listing one invites a reader to think it can.
 */
const statableCategories: readonly MailCategory[] = allCategories.filter(
  (category) => category !== 'needs-review',
);

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

    // --- trash: never on a model's word, whatever its confidence -----------
    // Not in the PRD at all: its vocabulary stops at Junk.
    //
    // This was `auto` for cold prospecting, granted on a measured fact — 16% of
    // the target mailbox, ahead of the owner's own client correspondence — and
    // withdrawn on a second one. Over the same 400 messages the rule took 89
    // under Mistral and 11 under Qwen: 78 messages, 20% of the mailbox,
    // deleted or kept by nothing but which model was deployed.
    //
    // That is not a calibration problem, and the 0.9 floor it carried could not
    // have caught it. Both models were confident; they disagreed about what
    // cold prospecting is. A rule whose scope is a property of the model has no
    // business being the one action that becomes irreversible by the passage of
    // time.
    ...allCategories.map(
      (category): ApprovalRule => ({ category, action: 'trash', approval: 'ask' }),
    ),

    // The one path to an automatic deletion, and it does not run on a verdict.
    // A stated route is the owner naming a sender or a list; it answers the
    // same whichever model is loaded, and it is the only place in this policy
    // where an owner can arm something irreversible deliberately.
    ...statableCategories.map(
      (category): ApprovalRule => ({
        category,
        action: 'trash',
        approval: 'auto',
        decidedBy: 'stated-route',
      }),
    ),

    // Filing follows the same rule, for the same reason at lower stakes: what
    // the owner routed, the agent files; what it worked out for itself, it
    // proposes.
    ...statableCategories.map(
      (category): ApprovalRule => ({
        category,
        action: 'move',
        approval: 'auto',
        decidedBy: 'stated-route',
      }),
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
  decision: Decision,
  action: MailAction,
): Approval {
  const applies = (r: ApprovalRule): boolean => r.category === decision.category && r.action === action;
  // A rule naming the deciding node wins over one that names none, whatever
  // order they were written in: the specific grant is the point of having it.
  const rule =
    policy.rules.find((r) => applies(r) && r.decidedBy === decision.decidedBy) ??
    policy.rules.find((r) => applies(r) && r.decidedBy === undefined);
  if (rule === undefined) return 'never';
  // Below its floor a rule does not apply, and the fallback is to ask rather
  // than to refuse: the agent still has something to propose.
  if (rule.minConfidence !== undefined && decision.confidence < rule.minConfidence) {
    return rule.approval === 'never' ? 'never' : 'ask';
  }
  return rule.approval;
}

/** Renders the policy as a table, for an owner deciding whether to accept it. */
export function describePolicy(policy: ApprovalPolicy): string {
  const auto = policy.rules.filter((r) => r.approval === 'auto');
  // Collapsed by what has to be true, not listed per category. Seventeen rows
  // saying the same thing about seventeen categories is a table nobody reads,
  // and this table exists to be read: it is what an owner approves.
  const groups = new Map<string, { rule: ApprovalRule; categories: string[] }>();
  for (const rule of auto) {
    const key = `${rule.action}|${String(rule.decidedBy)}|${String(rule.minConfidence)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { rule, categories: [rule.category] });
    else group.categories.push(rule.category);
  }

  const total = new Set(policy.rules.map((r) => r.category)).size;
  const render = (entry: { rule: ApprovalRule; categories: string[] }): string => {
    const { rule, categories } = entry;
    const what =
      categories.length === total
        ? 'any category'
        : categories.length > 4
          ? `${String(categories.length)} categories`
          : categories.join(', ');
    const floor = rule.minConfidence === undefined ? '' : ` (confidence ≥ ${String(rule.minConfidence)})`;
    return `  ${rule.action.padEnd(8)} ${what}${floor}`;
  };

  const lines: string[] = [];
  const unqualified = [...groups.values()].filter((g) => g.rule.decidedBy === undefined);
  if (unqualified.length > 0) {
    lines.push('Runs without asking:');
    for (const g of unqualified) lines.push(render(g));
  }
  const qualified = [...groups.values()].filter((g) => g.rule.decidedBy !== undefined);
  if (qualified.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Runs without asking, but only on a source you named:');
    for (const g of qualified) lines.push(render(g));
  }
  lines.push('', `Everything else asks first, or is not offered. ${String(policy.rules.length)} rules.`);
  return lines.join('\n');
}
