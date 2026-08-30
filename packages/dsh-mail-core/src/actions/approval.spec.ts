/**
 * The permission table is the only thing between a classifier that has been
 * observed calling a colleague's mail spam and that colleague's mail.
 *
 * Most of these assert a refusal, and the ones that assert a permission are
 * there so the table cannot quietly grow one.
 */

import { describe, expect, it } from 'vitest';

import type { MailCategory } from '../types.js';
import {
  DEFAULT_POLICY,
  approvalFor,
  describePolicy,
  type ApprovalPolicy,
  type MailAction,
} from './approval.js';

const CATEGORIES: readonly MailCategory[] = [
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

const ACTIONS: readonly MailAction[] = ['keyword', 'move', 'trash', 'draft', 'send'];

describe('what the table does not say', () => {
  it('refuses a pair no rule names', () => {
    // The table is the whole permission. A category added to the vocabulary
    // later must be granted deliberately rather than inherit anything.
    const empty: ApprovalPolicy = { rules: [] };
    for (const category of CATEGORIES) {
      for (const action of ACTIONS) {
        expect(approvalFor(empty, { category, confidence: 1, decidedBy: 'llm' }, action)).toBe('never');
      }
    }
  });

  it('refuses a category the default policy does not cover for an action', () => {
    // `needs-review` has no draft rule: the cascade saying it does not know is
    // not a basis for writing a reply.
    expect(approvalFor(DEFAULT_POLICY, { category: 'needs-review', confidence: 1, decidedBy: 'llm' }, 'draft')).toBe('never');
  });
});

describe('what runs without asking, and only that', () => {
  it('is exactly the set an owner was asked to approve', () => {
    // Enumerated over both provenances, because the policy now distinguishes
    // them and a list that only asked about one would miss half the grants —
    // including the only ones that delete anything.
    const auto: string[] = [];
    for (const category of CATEGORIES) {
      for (const action of ACTIONS) {
        for (const decidedBy of ['llm', 'stated-route'] as const) {
          if (approvalFor(DEFAULT_POLICY, { category, confidence: 1, decidedBy }, action) === 'auto') {
            auto.push(`${action}:${category}:${decidedBy}`);
          }
        }
      }
    }

    // Written out rather than counted, so widening the policy fails this test
    // by name instead of by an off-by-one nobody reads.
    // Only tagging. Every move and every draft was demoted to `ask` after the
    // first dry run over a real mailbox filed a bounce and a sales enquiry out
    // of the inbox.
    // Written out rather than counted, so widening the policy fails this test
    // by name instead of by an off-by-one nobody reads.
    //
    // Tagging on anything; filing and deleting only on a source the owner
    // named. No model verdict reaches `auto` for either, whatever its
    // confidence.
    expect(auto.sort()).toStrictEqual(
      [
        // Tagging, on anything, however it was decided.
        ...CATEGORIES.flatMap((c) => [`keyword:${c}:llm`, `keyword:${c}:stated-route`]),
        // Filing and deleting, only on a source the owner named — and never
        // for `needs-review`, which a stated route cannot produce.
        ...CATEGORIES.filter((c) => c !== 'needs-review').flatMap((c) => [
          `move:${c}:stated-route`,
          `trash:${c}:stated-route`,
        ]),
      ].sort(),
    );
  });

  it('never sends on its own, for any category', () => {
    // PRD 4.4: the owner keeps 100% of the control over what leaves.
    for (const category of CATEGORIES) {
      expect(approvalFor(DEFAULT_POLICY, { category: category, confidence: 1, decidedBy: 'llm' }, 'send')).not.toBe('auto');
    }
  });

  it('never trashes on a model verdict, at any confidence, for any category', () => {
    // This was `auto` for cold prospecting, on a measured fact, and withdrawn
    // on a second one: over 400 messages the rule took 89 under Mistral and 11
    // under Qwen. 78 messages were deleted or kept by nothing but which model
    // was deployed, and both models were confident.
    for (const category of CATEGORIES) {
      for (const decidedBy of ['llm', 'static-rule', 'learned-pattern', 'spam-prefilter'] as const) {
        expect(approvalFor(DEFAULT_POLICY, { category, confidence: 1, decidedBy }, 'trash')).toBe('ask');
      }
    }
  });

  it('trashes without asking only on a route the owner stated', () => {
    // The one place an owner can arm something irreversible, and it does not
    // run on a verdict: a stated route answers the same whichever model is
    // loaded.
    expect(
      approvalFor(
        DEFAULT_POLICY,
        { category: 'prospection-commerciale-non-sollicitee', confidence: 1, decidedBy: 'stated-route' },
        'trash',
      ),
    ).toBe('auto');
  });

  it('files without asking on a stated route, and proposes otherwise', () => {
    const stated = { category: 'veille-newsletter', confidence: 1, decidedBy: 'stated-route' } as const;
    const guessed = { category: 'veille-newsletter', confidence: 1, decidedBy: 'llm' } as const;
    expect(approvalFor(DEFAULT_POLICY, stated, 'move')).toBe('auto');
    expect(approvalFor(DEFAULT_POLICY, guessed, 'move')).toBe('ask');
  });

  it('never moves what the owner is expected to act on', () => {
    for (const category of ['demande-interne', 'rapport-compte-rendu-interne', 'needs-review'] as const) {
      expect(approvalFor(DEFAULT_POLICY, { category: category, confidence: 1, decidedBy: 'llm' }, 'move')).not.toBe('auto');
    }
  });
});

describe('the confidence floor', () => {
  it('holds a rule back to a proposal below its floor', () => {
    // Node 7 treats 0.76 and 0.98 the same. Acting on them the same is what
    // this floor exists to prevent — and it still applies when a category is
    // promoted back to `auto` on the evidence of its own traces.
    const promoted: ApprovalPolicy = {
      rules: [{ category: 'phishing-arnaque', action: 'move', approval: 'auto', minConfidence: 0.9 }],
    };
    expect(approvalFor(promoted, { category: 'phishing-arnaque', confidence: 0.95, decidedBy: 'llm' }, 'move')).toBe('auto');
    expect(approvalFor(promoted, { category: 'phishing-arnaque', confidence: 0.85, decidedBy: 'llm' }, 'move')).toBe('ask');
  });

  it('is strictest where the mistake hides mail', () => {
    // Junking is the only automatic move that hides something the owner might
    // have wanted, and the classifier has been observed calling a colleague's
    // mail spam.
    const floorOf = (c: MailCategory): number =>
      DEFAULT_POLICY.rules.find((r) => r.category === c && r.action === 'move')?.minConfidence ?? 0;

    expect(floorOf('phishing-arnaque')).toBeGreaterThan(floorOf('veille-newsletter'));
  });

  it('does not turn a refusal into a proposal', () => {
    const policy: ApprovalPolicy = {
      rules: [{ category: 'demande-interne', action: 'trash', approval: 'never', minConfidence: 0.9 }],
    };
    expect(approvalFor(policy, { category: 'demande-interne', confidence: 0.5, decidedBy: 'llm' }, 'trash')).toBe('never');
  });
});

describe('the table can be read', () => {
  it('lists every automatic rule with its floor', () => {
    // An owner approves this text, not the source. It has to carry the two
    // facts that matter: what happens unattended, and how sure it must be.
    const described = describePolicy(DEFAULT_POLICY);
    expect(described).toContain('keyword  any category');
    expect(described).toContain('Everything else asks first');
    // The automatic rows that only fire on a named source are separated out,
    // because an owner reading this needs to see that deletion never happens
    // on the agent's own judgement.
    expect(described).toContain('Runs without asking, but only on a source you named:');
    expect(described).toContain('trash    16 categories');
    expect(described).toContain('move     16 categories');
    // Nothing is sent unattended, whatever decided it (PRD section 4.4).
    expect(described).not.toContain('send');
  });
});

describe('the table stays short enough to be read', () => {
  it('says the guarantee in a handful of lines, not one per category', () => {
    // The policy holds 104 rules. An owner approves the description, not the
    // source, and a description that lists every rule is one nobody reads —
    // which is how a destructive grant gets approved without being seen.
    const lines = describePolicy(DEFAULT_POLICY).split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('never claims a stated route can settle the cascade’s own non-answer', () => {
    // Node 2b always names a real category, so a grant for `needs-review`
    // could never fire, and listing one invites the reader to think it can.
    expect(
      approvalFor(DEFAULT_POLICY, { category: 'needs-review', confidence: 1, decidedBy: 'stated-route' }, 'trash'),
    ).toBe('ask');
    expect(
      approvalFor(DEFAULT_POLICY, { category: 'needs-review', confidence: 1, decidedBy: 'stated-route' }, 'move'),
    ).toBe('never');
  });
});
