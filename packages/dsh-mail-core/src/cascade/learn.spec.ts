/**
 * The write side of node 3.
 *
 * `learned-patterns.spec.ts` tests what counts as a pattern. What is tested
 * here is that a running agent actually accumulates them, which it did not do
 * at all while these functions had no caller.
 */

import { describe, expect, it } from 'vitest';

import { MailStore } from '../store/mail-store.js';
import { learn, describeLearn } from './learn.js';
import type { DecisionTrace } from './types.js';
import type { MailCategory } from '../types.js';

function trace(over: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    messageId: 'm1',
    decidedBy: 'llm',
    category: 'veille-newsletter',
    confidence: 0.95,
    rationale: 'r',
    steps: [],
    usedModel: true,
    startedAt: new Date('2026-08-30T10:00:00.000Z'),
    durationMs: 10,
    ...over,
  };
}

describe('a running agent accumulates what the model decided', () => {
  it('learns nothing from fewer than three agreeing decisions', () => {
    const store = new MailStore(':memory:');
    for (const n of [1, 2]) {
      store.recordTrace(trace({ messageId: `m${String(n)}` }), { sender: 'news@example.org' });
    }
    expect(learn(store).patterns).toStrictEqual([]);

    store.recordTrace(trace({ messageId: 'm3' }), { sender: 'news@example.org' });
    const result = learn(store);
    expect(result.observations).toBe(3);
    expect(result.patterns).toHaveLength(1);
    expect(result.added).toBe(1);
    store.close();
  });

  it('ignores what a cheap node settled, which would teach a rule to agree with itself', () => {
    const store = new MailStore(':memory:');
    for (const n of [1, 2, 3, 4]) {
      store.recordTrace(
        trace({ messageId: `m${String(n)}`, decidedBy: 'static-rule', usedModel: false }),
        { sender: 'news@example.org' },
      );
    }
    expect(learn(store).observations).toBe(0);
    store.close();
  });

  it('cannot see a decision recorded without its source', () => {
    // The state the store was in before it had these columns: every verdict
    // kept, and no way to say which sender produced it.
    const store = new MailStore(':memory:');
    for (const n of [1, 2, 3, 4]) store.recordTrace(trace({ messageId: `m${String(n)}` }));
    expect(learn(store).observations).toBe(0);
    store.close();
  });

  it('groups a mailing list by its List-Id, not by the people on it', () => {
    const store = new MailStore(':memory:');
    for (const [n, sender] of [['1', 'a@x.org'], ['2', 'b@x.org'], ['3', 'c@x.org']] as const) {
      store.recordTrace(
        trace({ messageId: `m${n}`, category: 'liste-diffusion' as MailCategory }),
        { sender, listId: 'discuss.lists.example' },
      );
    }
    const patterns = learn(store).patterns;
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.listId).toBe('discuss.lists.example');
    expect(patterns[0]?.category).toBe('liste-diffusion');
    store.close();
  });

  it('survives a restart, which is the whole point of storing it', () => {
    const store = new MailStore(':memory:');
    for (const n of [1, 2, 3]) {
      store.recordTrace(trace({ messageId: `m${String(n)}` }), { sender: 'news@example.org' });
    }
    learn(store);
    expect(store.loadPatterns()).toHaveLength(1);
    store.close();
  });

  it('says what changed rather than what it holds', () => {
    const store = new MailStore(':memory:');
    for (const n of [1, 2, 3]) {
      store.recordTrace(trace({ messageId: `m${String(n)}` }), { sender: 'news@example.org' });
    }
    expect(describeLearn(learn(store))).toBe('1 patterns from 3 model decisions (+1, -0)');
    store.close();
  });
});
