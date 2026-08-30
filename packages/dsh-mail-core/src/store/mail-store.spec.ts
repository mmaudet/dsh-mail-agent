/**
 * What survives a restart, and in what shape.
 *
 * The store is where the cost KPI stops being a projection: `efficiency` reads
 * what actually happened, and the whole argument for the cascade is that
 * number.
 */

import { describe, expect, it } from 'vitest';

import type { DecisionTrace, LearnedPattern } from '../cascade/types.js';
import { MailStore } from './mail-store.js';

function store(): MailStore {
  return new MailStore(':memory:');
}

function trace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    messageId: 'm1',
    decidedBy: 'static-rule',
    category: 'newsletter-tech',
    confidence: 1,
    rationale: 'bulk sender',
    steps: [
      { node: 'thread-continuity', verdict: null, durationMs: 0 },
      {
        node: 'static-rule',
        verdict: { category: 'newsletter-tech', confidence: 1, rationale: 'bulk sender' },
        durationMs: 1,
      },
    ],
    usedModel: false,
    startedAt: new Date('2026-08-30T08:00:00.000Z'),
    durationMs: 3,
    ...overrides,
  };
}

describe('traces', () => {
  it('round-trips a decision, steps and dates included', () => {
    const db = store();
    const original = trace();
    db.recordTrace(original);

    const read = db.traceFor('m1');
    expect(read).toStrictEqual(original);
    // A Date that came back as a string would break every consumer silently.
    expect(read?.startedAt).toBeInstanceOf(Date);
    db.close();
  });

  it('keeps one current decision per message rather than a history', () => {
    // A message has one classification the agent currently believes. A history
    // of re-decisions is a different feature with different retention
    // questions.
    const db = store();
    db.recordTrace(trace({ category: 'newsletter-tech' }));
    db.recordTrace(trace({ category: 'spam-certain', decidedBy: 'spam-prefilter' }));

    expect(db.traceFor('m1')?.category).toBe('spam-certain');
    expect(db.recentTraces()).toHaveLength(1);
    db.close();
  });

  it('returns nothing for a message it has not seen', () => {
    const db = store();
    expect(db.traceFor('never-classified')).toBeNull();
    db.close();
  });

  it('orders recent traces newest first', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'old', startedAt: new Date('2026-08-01T00:00:00.000Z') }));
    db.recordTrace(trace({ messageId: 'new', startedAt: new Date('2026-08-30T00:00:00.000Z') }));

    expect(db.recentTraces().map((t) => t.messageId)).toStrictEqual(['new', 'old']);
    db.close();
  });
});

describe('the efficiency KPI', () => {
  it('reports nothing rather than zero before anything is classified', () => {
    // Zero percent free and no data are different claims, and a dashboard that
    // conflates them reports a catastrophe on a fresh install.
    const db = store();
    expect(db.efficiency()).toStrictEqual({ classified: 0, withModel: 0, settledFree: null });
    db.close();
  });

  it('counts what actually reached the model', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a', usedModel: false }));
    db.recordTrace(trace({ messageId: 'b', usedModel: false }));
    db.recordTrace(trace({ messageId: 'c', usedModel: true, decidedBy: 'llm' }));
    db.recordTrace(trace({ messageId: 'd', usedModel: true, decidedBy: 'llm' }));

    expect(db.efficiency()).toStrictEqual({ classified: 4, withModel: 2, settledFree: 0.5 });
    db.close();
  });

  it('can be asked about a window', () => {
    const db = store();
    db.recordTrace(
      trace({ messageId: 'old', usedModel: true, startedAt: new Date('2026-08-01T00:00:00.000Z') }),
    );
    db.recordTrace(
      trace({ messageId: 'new', usedModel: false, startedAt: new Date('2026-08-30T00:00:00.000Z') }),
    );

    const since = db.efficiency(new Date('2026-08-15T00:00:00.000Z'));
    expect(since).toStrictEqual({ classified: 1, withModel: 0, settledFree: 1 });
    db.close();
  });
});

describe('cursors', () => {
  it('remembers where a folder was left', () => {
    const db = store();
    db.saveCursor('INBOX', 'jmap:s1');
    db.saveCursor('INBOX', 'jmap:s2');

    expect(db.loadCursor('INBOX')).toBe('jmap:s2');
    db.close();
  });

  it('reports nothing for a folder never polled', () => {
    // Which is what `currentCursor` exists to answer: a cold start is a real
    // state, not an error.
    const db = store();
    expect(db.loadCursor('Newsletters/Tech')).toBeNull();
    db.close();
  });
});

describe('learned patterns', () => {
  const patterns: LearnedPattern[] = [
    { listId: 'l.example', sender: null, subjectContains: null, category: 'standard', confidence: 0.9 },
    { listId: null, sender: 'a@example.org', subjectContains: null, category: 'important', confidence: 0.88 },
  ];

  it('round-trips a set', () => {
    const db = store();
    db.savePatterns(patterns);

    const read = db.loadPatterns();
    expect(read).toHaveLength(2);
    expect(read.find((p) => p.listId === 'l.example')?.category).toBe('standard');
    expect(read.find((p) => p.sender === 'a@example.org')?.confidence).toBeCloseTo(0.88);
    db.close();
  });

  it('replaces the stored set rather than accumulating', () => {
    // `mergePatterns` already decides what survives. Two places deciding that
    // is how a pattern nobody can explain ends up in the table.
    const db = store();
    db.savePatterns(patterns);
    db.savePatterns([patterns[0] as LearnedPattern]);

    expect(db.loadPatterns()).toHaveLength(1);
    db.close();
  });

  it('drops a stored row whose category left the vocabulary', () => {
    // Rather than guess at it. The next learning pass replaces it.
    const db = store();
    db.savePatterns(patterns);
    // Simulates a schema this version no longer understands.
    const inner = db as unknown as { db: { exec: (sql: string) => void } };
    inner.db.exec("update patterns set category = 'retired-category' where key = 'list:l.example'");

    const read = db.loadPatterns();
    expect(read).toHaveLength(1);
    expect(read[0]?.sender).toBe('a@example.org');
    db.close();
  });
});

describe('what a thread was decided to be', () => {
  it('reports the most recent decision in the thread', () => {
    // A thread that changed character — a notification someone replied to — is
    // described by its latest message, not its first.
    const db = store();
    db.recordTrace(
      trace({
        messageId: 'a',
        category: 'newsletter-notification',
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      't1',
      true,
    );
    db.recordTrace(
      trace({ messageId: 'b', category: 'important', startedAt: new Date('2026-08-30T00:00:00.000Z') }),
      't1',
    );

    expect(db.threadCategory('t1')).toBe('important');
    expect(db.threadSize('t1')).toBe(2);
    db.close();
  });

  it('refuses to inherit a non-answer', () => {
    // Inheriting "I do not know" propagates it down a thread and makes it look
    // like a decision.
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'needs-review' }), 't1');
    expect(db.threadCategory('t1')).toBeNull();
    db.close();
  });

  it('refuses to inherit a guess', () => {
    // Node 1 settles at zero cost with no second opinion, so it inherits from
    // a decision rather than from a low-confidence one.
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'important', confidence: 0.6 }), 't1', true);
    expect(db.threadCategory('t1')).toBeNull();
    expect(db.threadCategory('t1', 0.5)).toBe('important');
    db.close();
  });

  it('knows nothing about a thread it has not seen, or about no thread at all', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a' }), 't1');
    expect(db.threadCategory('t2')).toBeNull();
    expect(db.threadCategory(null)).toBeNull();
    expect(db.threadSize(null)).toBe(0);
    db.close();
  });

  it('keeps the thread when a message is re-decided', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'standard' }), 't1', true);
    db.recordTrace(trace({ messageId: 'a', category: 'important' }), 't1', true);

    expect(db.threadSize('t1')).toBe(1);
    expect(db.threadCategory('t1')).toBe('important');
    db.close();
  });
});

describe('node 1 waits for the owner', () => {
  it('refuses a thread the owner has never acted in', () => {
    // PRD 4.2 says "a thread where the owner has already acted", and a warm
    // simulation showed why the weaker reading is dangerous: inheriting into
    // every thread the classifier has touched amplifies whatever it leans
    // towards. 61% of a mailbox came back `important`.
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'important' }), 't1');
    expect(db.threadCategory('t1')).toBeNull();
    db.close();
  });

  it('inherits once the owner has replied anywhere in it', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'important' }), 't1');
    expect(db.threadCategory('t1')).toBeNull();

    // A later message in the same thread carries the owner's reply.
    db.recordTrace(trace({ messageId: 'b', category: 'important' }), 't1', true);
    expect(db.threadCategory('t1')).toBe('important');
    db.close();
  });

  it('keeps the owner\'s engagement separate from the category it inherits', () => {
    // The engagement gates the node; the most recent decision supplies the
    // answer. They are different messages more often than not.
    const db = store();
    db.recordTrace(
      trace({ messageId: 'a', category: 'standard', startedAt: new Date('2026-08-01T00:00:00.000Z') }),
      't1',
      true,
    );
    db.recordTrace(
      trace({ messageId: 'b', category: 'important', startedAt: new Date('2026-08-30T00:00:00.000Z') }),
      't1',
      false,
    );

    expect(db.threadCategory('t1')).toBe('important');
    db.close();
  });
});
