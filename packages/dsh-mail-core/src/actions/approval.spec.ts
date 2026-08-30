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
        expect(approvalFor(empty, category, action, 1)).toBe('never');
      }
    }
  });

  it('refuses a category the default policy does not cover for an action', () => {
    // `needs-review` has no draft rule: the cascade saying it does not know is
    // not a basis for writing a reply.
    expect(approvalFor(DEFAULT_POLICY, 'needs-review', 'draft', 1)).toBe('never');
  });
});

describe('what runs without asking, and only that', () => {
  it('is exactly the set an owner was asked to approve', () => {
    const auto: string[] = [];
    for (const category of CATEGORIES) {
      for (const action of ACTIONS) {
        if (approvalFor(DEFAULT_POLICY, category, action, 1) === 'auto') {
          auto.push(`${action}:${category}`);
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
    // Tagging, plus exactly one destructive grant. Every move and every draft
    // stays `ask`, on the evidence of the first dry run over a real mailbox.
    expect(auto.sort()).toStrictEqual(
      [
        ...CATEGORIES.map((c) => `keyword:${c}`),
        'trash:prospection-commerciale-non-sollicitee',
      ].sort(),
    );
  });

  it('never sends on its own, for any category', () => {
    // PRD 4.4: the owner keeps 100% of the control over what leaves.
    for (const category of CATEGORIES) {
      expect(approvalFor(DEFAULT_POLICY, category, 'send', 1)).not.toBe('auto');
    }
  });

  it('trashes on its own for exactly one category, and asks for the rest', () => {
    // Trashing is the only action whose effect becomes irreversible by the
    // passage of time — Gmail purges its trash after thirty days — so the one
    // grant is named here and every other category is asserted against it.
    //
    // The owner authorised this after being shown that cold prospecting is 16%
    // of their mailbox, ahead of their own client correspondence.
    for (const category of CATEGORIES) {
      const approval = approvalFor(DEFAULT_POLICY, category, 'trash', 1);
      if (category === 'prospection-commerciale-non-sollicitee') {
        expect(approval).toBe('auto');
      } else {
        expect(approval).not.toBe('auto');
      }
    }
  });

  it('will not trash unattended on a weak verdict', () => {
    expect(approvalFor(DEFAULT_POLICY, 'prospection-commerciale-non-sollicitee', 'trash', 0.89)).toBe('ask');
    expect(approvalFor(DEFAULT_POLICY, 'prospection-commerciale-non-sollicitee', 'trash', 0.9)).toBe('auto');
  });

  it('never moves what the owner is expected to act on', () => {
    for (const category of ['demande-interne', 'rapport-compte-rendu-interne', 'needs-review'] as const) {
      expect(approvalFor(DEFAULT_POLICY, category, 'move', 1)).not.toBe('auto');
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
    expect(approvalFor(promoted, 'phishing-arnaque', 'move', 0.95)).toBe('auto');
    expect(approvalFor(promoted, 'phishing-arnaque', 'move', 0.85)).toBe('ask');
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
    expect(approvalFor(policy, 'demande-interne', 'trash', 0.5)).toBe('never');
  });
});

describe('the table can be read', () => {
  it('lists every automatic rule with its floor', () => {
    // An owner approves this text, not the source. It has to carry the two
    // facts that matter: what happens unattended, and how sure it must be.
    const described = describePolicy(DEFAULT_POLICY);
    expect(described).toContain('keyword  demande-interne');
    expect(described).toContain('Everything else asks first');
    // The destructive grant has to be legible, with its floor: an owner who
    // reads this and misses it has not been told what they approved.
    expect(described).toContain('trash    prospection-commerciale-non-sollicitee');
    expect(described).toContain('0.9');
    // Nothing that files a message elsewhere runs unattended.
    expect(described).not.toContain('move');
    expect(described).not.toContain('send');
  });
});
