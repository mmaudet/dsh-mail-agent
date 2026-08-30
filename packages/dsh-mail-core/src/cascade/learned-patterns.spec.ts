/**
 * What node 3 is allowed to learn.
 *
 * Most of these assert a refusal. Three defects in this cascade have been
 * rules claiming more than their evidence supported, and a learned pattern is
 * the easiest place for a fourth: it is free, it is permanent until relearned,
 * and it fires before the static rules.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PATTERN_CONFIDENCE,
  learnPatterns,
  mergePatterns,
  type Observation,
} from './learned-patterns.js';

function seen(
  sender: string,
  category: Observation['category'],
  times: number,
  overrides: Partial<Observation> = {},
): Observation[] {
  return Array.from({ length: times }, () => ({
    sender,
    category,
    confidence: 0.9,
    decidedBy: 'llm' as const,
    ...overrides,
  }));
}

describe('what becomes a pattern', () => {
  it('learns a service the model settled the same way three times', () => {
    const patterns = learnPatterns(seen('news@digest.example', 'veille-newsletter', 3));

    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.sender).toBe('news@digest.example');
    expect(patterns[0]?.category).toBe('veille-newsletter');
  });

  it('lowercases the sender, since addresses are matched case-insensitively', () => {
    const patterns = learnPatterns(seen('News@Digest.Example', 'veille-newsletter', 3));
    expect(patterns[0]?.sender).toBe('news@digest.example');
  });
});

describe('what does not', () => {
  it('refuses two observations: that is a coincidence, not a habit', () => {
    expect(learnPatterns(seen('support@example.org', 'rapport-compte-rendu-interne', 2))).toEqual([]);
  });

  it('refuses a source whose decisions disagree', () => {
    // A sender who is sometimes important and sometimes bulk is exactly the
    // one a pattern must not answer for. Unanimity, not a majority: three
    // samples cannot support a vote.
    const mixed = [
      ...seen('support@mixed.example', 'rapport-compte-rendu-interne', 2),
      ...seen('support@mixed.example', 'demande-interne', 1),
    ];
    expect(learnPatterns(mixed)).toEqual([]);
  });

  it('refuses evidence the model was unsure about', () => {
    // Learning from an uncertain answer makes it permanent and free, which is
    // the worst of both.
    const unsure = seen('support@example.org', 'rapport-compte-rendu-interne', 5, { confidence: 0.6 });
    expect(learnPatterns(unsure)).toEqual([]);
  });

  it('refuses decisions a cheaper node made', () => {
    // A message a static rule settles is already free, and learning from one
    // would let that rule's mistake harden into a pattern outliving it.
    const cheap = seen('news@example.org', 'veille-newsletter', 5, { decidedBy: 'static-rule' });
    expect(learnPatterns(cheap)).toEqual([]);
  });

  it('refuses an empty sender', () => {
    expect(learnPatterns(seen('   ', 'rapport-compte-rendu-interne', 5))).toEqual([]);
  });
});

describe('how much a pattern may claim', () => {
  it('never claims more than the decisions it came from', () => {
    const patterns = learnPatterns(seen('support@example.org', 'rapport-compte-rendu-interne', 4, { confidence: 0.86 }));
    expect(patterns[0]?.confidence).toBeCloseTo(0.86);
  });

  it('never reaches certainty, however many times it was seen', () => {
    // Volume makes a pattern eligible, not more certain. A node settling at 1
    // cannot be degraded by node 7 or reviewed by anyone.
    const patterns = learnPatterns(seen('support@example.org', 'rapport-compte-rendu-interne', 50, { confidence: 1 }));
    expect(patterns[0]?.confidence).toBe(MAX_PATTERN_CONFIDENCE);
    expect(patterns[0]?.confidence).toBeLessThan(1);
  });
});

describe('merging with what is already stored', () => {
  it('lets newer evidence replace a sender it is about', () => {
    const stored = learnPatterns(seen('news@example.org', 'veille-newsletter', 3));
    const learned = learnPatterns(seen('news@example.org', 'veille-newsletter', 3));

    const merged = mergePatterns(stored, learned);
    expect(merged).toHaveLength(1);
    // The mailbox is what changed; the newer evidence describes it as it is.
    expect(merged[0]?.category).toBe('veille-newsletter');
  });

  it('keeps a stored sender the new run said nothing about', () => {
    const stored = learnPatterns(seen('alerts@old.example', 'rapport-compte-rendu-interne', 3));
    const learned = learnPatterns(seen('alerts@new.example', 'demande-interne', 3));

    expect(mergePatterns(stored, learned).map((p) => p.sender)).toStrictEqual([
      'alerts@new.example',
      'alerts@old.example',
    ]);
  });
});

describe('mailing lists, which senders cannot represent', () => {
  function onList(
    listId: string,
    category: Observation['category'],
    senders: readonly string[],
  ): Observation[] {
    return senders.map((sender) => ({
      sender,
      listId,
      category,
      confidence: 0.9,
      decidedBy: 'llm' as const,
    }));
  }

  it('learns a list from messages by different people', () => {
    // The case sender patterns structurally cannot reach: each person posts
    // once, so grouping by sender scatters the evidence and learns nothing.
    const observations = onList('license-review.lists.example', 'rapport-compte-rendu-interne', [
      'a@example.org',
      'b@example.org',
      'c@example.org',
    ]);

    expect(learnPatterns(observations.map((o) => ({ ...o, listId: null })))).toEqual([]);

    const patterns = learnPatterns(observations);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.listId).toBe('license-review.lists.example');
    expect(patterns[0]?.sender).toBeNull();
  });

  it('does not also learn the people who posted to it', () => {
    // A message on a list teaches about the list. Learning the poster too
    // would answer for their direct mail on the strength of a list posting.
    const observations = onList('l.example', 'rapport-compte-rendu-interne', ['a@x.org', 'a@x.org', 'a@x.org']);
    const patterns = learnPatterns(observations);

    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.listId).toBe('l.example');
  });

  it('refuses a list the model classified inconsistently', () => {
    // Measured on the target inbox: the model answered `standard` on one
    // message of a list and `newsletter-tech` on another.
    const mixed = [
      ...onList('l.example', 'rapport-compte-rendu-interne', ['a@x.org', 'b@x.org']),
      ...onList('l.example', 'veille-newsletter', ['c@x.org']),
    ];
    expect(learnPatterns(mixed)).toEqual([]);
  });

  it('keeps list and sender patterns apart when merging', () => {
    const stored = learnPatterns(onList('l.example', 'rapport-compte-rendu-interne', ['a@x.org', 'b@x.org', 'c@x.org']));
    const learned = learnPatterns(seen('billing@x.org', 'demande-interne', 3));

    const merged = mergePatterns(stored, learned);
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.listId ?? p.sender).sort()).toStrictEqual(['billing@x.org', 'l.example']);
  });
});

describe('what protects a colleague is their mail, not their address', () => {
  it('refuses a source whose mail varies, which is what a person’s does', () => {
    // The other half of why 61% of a mailbox came back `important`: a
    // colleague classified that way three times became a rule answering
    // `important` for everything they ever send.
    //
    // What stops that is no longer a regex on the address. Measured over 396
    // real verdicts, the most consistent human sender in this mailbox reached
    // 42% on one category, well under the 80% a pattern needs; the colleagues
    // scatter across four and five categories because their mail genuinely
    // varies.
    const varied = [
      ...seen('cmcaron@linagora.com', 'rapport-compte-rendu-interne', 5),
      ...seen('cmcaron@linagora.com', 'demande-interne', 5),
      ...seen('cmcaron@linagora.com', 'correspondance-commerciale-client', 2),
    ];
    expect(learnPatterns(varied)).toEqual([]);
  });

  it('learns a source that keeps sending the same kind of thing', () => {
    for (const sender of [
      'no-reply@service.example',
      'customer-service@ovh.example',
      'recommendations@discover.pinterest.example',
      'franck.balestra@dgfip.finances.gouv.example',
    ]) {
      expect(learnPatterns(seen(sender, 'support-technique-ticket', 3))).toHaveLength(1);
    }
  });

  it('tolerates a stray verdict, because the labeller is not consistent either', () => {
    // Sixteen of eighteen `license-review` messages agreed and strict unanimity
    // threw the pattern away, taking 4.5% of the mailbox with it. The economy
    // model agrees with a larger one on 65% of this mailbox; a rule that breaks
    // on one disagreement in eighteen is a rule tuned for a labeller that does
    // not exist.
    const mostly = [
      ...seen('digest@example.org', 'veille-newsletter', 16),
      ...seen('digest@example.org', 'rapport-compte-rendu-interne', 2),
    ];
    const [pattern] = learnPatterns(mostly);
    expect(pattern?.category).toBe('veille-newsletter');
  });

  it('still refuses a source split down the middle', () => {
    const split = [
      ...seen('mixed@example.org', 'veille-newsletter', 5),
      ...seen('mixed@example.org', 'demande-interne', 5),
    ];
    expect(learnPatterns(split)).toEqual([]);
  });

  it('never learns the cascade’s own non-answer', () => {
    // Unanimous over thirty-one messages on the target mailbox: the contact
    // form the economy model cannot place. A pattern saying "this sender is
    // always unclassifiable" settles nothing and stops the model ever being
    // asked again — the owner states a route for it instead.
    expect(learnPatterns(seen('nple@linagora.com', 'needs-review', 31))).toEqual([]);
  });

  it('still learns a mailing list, whose senders are all different people', () => {
    const observations = Array.from({ length: 3 }, (_, i) => ({
      sender: `person${String(i)}@example.org`,
      listId: 'l.example',
      category: 'rapport-compte-rendu-interne' as const,
      confidence: 0.9,
      decidedBy: 'llm' as const,
    }));
    expect(learnPatterns(observations)).toHaveLength(1);
  });
});
