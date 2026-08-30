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
  it('learns a sender the model settled the same way three times', () => {
    const patterns = learnPatterns(seen('news@digest.example', 'newsletter-tech', 3));

    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.sender).toBe('news@digest.example');
    expect(patterns[0]?.category).toBe('newsletter-tech');
  });

  it('lowercases the sender, since addresses are matched case-insensitively', () => {
    const patterns = learnPatterns(seen('News@Digest.Example', 'newsletter-tech', 3));
    expect(patterns[0]?.sender).toBe('news@digest.example');
  });
});

describe('what does not', () => {
  it('refuses two observations: that is a coincidence, not a habit', () => {
    expect(learnPatterns(seen('a@example.org', 'standard', 2))).toEqual([]);
  });

  it('refuses a sender whose decisions disagree', () => {
    // A sender who is sometimes important and sometimes bulk is exactly the
    // one a pattern must not answer for. Unanimity, not a majority: three
    // samples cannot support a vote.
    const mixed = [
      ...seen('mixed@example.org', 'standard', 2),
      ...seen('mixed@example.org', 'important', 1),
    ];
    expect(learnPatterns(mixed)).toEqual([]);
  });

  it('refuses evidence the model was unsure about', () => {
    // Learning from an uncertain answer makes it permanent and free, which is
    // the worst of both.
    const unsure = seen('a@example.org', 'standard', 5, { confidence: 0.6 });
    expect(learnPatterns(unsure)).toEqual([]);
  });

  it('refuses decisions a cheaper node made', () => {
    // A message a static rule settles is already free, and learning from one
    // would let that rule's mistake harden into a pattern outliving it.
    const cheap = seen('a@example.org', 'newsletter-tech', 5, { decidedBy: 'static-rule' });
    expect(learnPatterns(cheap)).toEqual([]);
  });

  it('refuses an empty sender', () => {
    expect(learnPatterns(seen('   ', 'standard', 5))).toEqual([]);
  });
});

describe('how much a pattern may claim', () => {
  it('never claims more than the decisions it came from', () => {
    const patterns = learnPatterns(seen('a@example.org', 'standard', 4, { confidence: 0.86 }));
    expect(patterns[0]?.confidence).toBeCloseTo(0.86);
  });

  it('never reaches certainty, however many times it was seen', () => {
    // Volume makes a pattern eligible, not more certain. A node settling at 1
    // cannot be degraded by node 7 or reviewed by anyone.
    const patterns = learnPatterns(seen('a@example.org', 'standard', 50, { confidence: 1 }));
    expect(patterns[0]?.confidence).toBe(MAX_PATTERN_CONFIDENCE);
    expect(patterns[0]?.confidence).toBeLessThan(1);
  });
});

describe('merging with what is already stored', () => {
  it('lets newer evidence replace a sender it is about', () => {
    const stored = learnPatterns(seen('a@example.org', 'newsletter-promo', 3));
    const learned = learnPatterns(seen('a@example.org', 'newsletter-tech', 3));

    const merged = mergePatterns(stored, learned);
    expect(merged).toHaveLength(1);
    // The mailbox is what changed; the newer evidence describes it as it is.
    expect(merged[0]?.category).toBe('newsletter-tech');
  });

  it('keeps a stored sender the new run said nothing about', () => {
    const stored = learnPatterns(seen('old@example.org', 'standard', 3));
    const learned = learnPatterns(seen('new@example.org', 'important', 3));

    expect(mergePatterns(stored, learned).map((p) => p.sender)).toStrictEqual([
      'new@example.org',
      'old@example.org',
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
    const observations = onList('license-review.lists.example', 'standard', [
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
    const observations = onList('l.example', 'standard', ['a@x.org', 'a@x.org', 'a@x.org']);
    const patterns = learnPatterns(observations);

    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.listId).toBe('l.example');
  });

  it('refuses a list the model classified inconsistently', () => {
    // Measured on the target inbox: the model answered `standard` on one
    // message of a list and `newsletter-tech` on another.
    const mixed = [
      ...onList('l.example', 'standard', ['a@x.org', 'b@x.org']),
      ...onList('l.example', 'newsletter-tech', ['c@x.org']),
    ];
    expect(learnPatterns(mixed)).toEqual([]);
  });

  it('keeps list and sender patterns apart when merging', () => {
    const stored = learnPatterns(onList('l.example', 'standard', ['a@x.org', 'b@x.org', 'c@x.org']));
    const learned = learnPatterns(seen('d@x.org', 'important', 3));

    const merged = mergePatterns(stored, learned);
    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.listId ?? p.sender).sort()).toStrictEqual(['d@x.org', 'l.example']);
  });
});
