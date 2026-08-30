/**
 * What survives a restart, and in what shape.
 *
 * The store is where the cost KPI stops being a projection: `efficiency` reads
 * what actually happened, and the whole argument for the cascade is that
 * number.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    category: 'veille-newsletter',
    confidence: 1,
    rationale: 'bulk sender',
    steps: [
      { node: 'thread-continuity', verdict: null, durationMs: 0 },
      {
        node: 'static-rule',
        verdict: { category: 'veille-newsletter', confidence: 1, rationale: 'bulk sender' },
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
    db.recordTrace(trace({ category: 'veille-newsletter' }));
    db.recordTrace(trace({ category: 'phishing-arnaque', decidedBy: 'spam-prefilter' }));

    expect(db.traceFor('m1')?.category).toBe('phishing-arnaque');
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
    { listId: 'l.example', sender: null, subjectContains: null, category: 'rapport-compte-rendu-interne', confidence: 0.9 },
    { listId: null, sender: 'a@example.org', subjectContains: null, category: 'demande-interne', confidence: 0.88 },
  ];

  it('round-trips a set', () => {
    const db = store();
    db.savePatterns(patterns);

    const read = db.loadPatterns();
    expect(read).toHaveLength(2);
    expect(read.find((p) => p.listId === 'l.example')?.category).toBe('rapport-compte-rendu-interne');
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
        category: 'support-technique-ticket',
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
      { threadId: 't1', ownerActed: true },
    );
    db.recordTrace(
      trace({ messageId: 'b', category: 'demande-interne', startedAt: new Date('2026-08-30T00:00:00.000Z') }),
      { threadId: 't1' },
    );

    expect(db.threadCategory('t1')).toBe('demande-interne');
    expect(db.threadSize('t1')).toBe(2);
    db.close();
  });

  it('refuses to inherit a non-answer', () => {
    // Inheriting "I do not know" propagates it down a thread and makes it look
    // like a decision.
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'needs-review' }), { threadId: 't1' });
    expect(db.threadCategory('t1')).toBeNull();
    db.close();
  });

  it('refuses to inherit a guess', () => {
    // Node 1 settles at zero cost with no second opinion, so it inherits from
    // a decision rather than from a low-confidence one.
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'demande-interne', confidence: 0.6 }), { threadId: 't1', ownerActed: true });
    expect(db.threadCategory('t1')).toBeNull();
    expect(db.threadCategory('t1', 0.5)).toBe('demande-interne');
    db.close();
  });

  it('knows nothing about a thread it has not seen, or about no thread at all', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a' }), { threadId: 't1' });
    expect(db.threadCategory('t2')).toBeNull();
    expect(db.threadCategory(null)).toBeNull();
    expect(db.threadSize(null)).toBe(0);
    db.close();
  });

  it('keeps the thread when a message is re-decided', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'rapport-compte-rendu-interne' }), { threadId: 't1', ownerActed: true });
    db.recordTrace(trace({ messageId: 'a', category: 'demande-interne' }), { threadId: 't1', ownerActed: true });

    expect(db.threadSize('t1')).toBe(1);
    expect(db.threadCategory('t1')).toBe('demande-interne');
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
    db.recordTrace(trace({ messageId: 'a', category: 'demande-interne' }), { threadId: 't1' });
    expect(db.threadCategory('t1')).toBeNull();
    db.close();
  });

  it('inherits once the owner has replied anywhere in it', () => {
    const db = store();
    db.recordTrace(trace({ messageId: 'a', category: 'demande-interne' }), { threadId: 't1' });
    expect(db.threadCategory('t1')).toBeNull();

    // A later message in the same thread carries the owner's reply.
    db.recordTrace(trace({ messageId: 'b', category: 'demande-interne' }), { threadId: 't1', ownerActed: true });
    expect(db.threadCategory('t1')).toBe('demande-interne');
    db.close();
  });

  it('keeps the owner\'s engagement separate from the category it inherits', () => {
    // The engagement gates the node; the most recent decision supplies the
    // answer. They are different messages more often than not.
    const db = store();
    db.recordTrace(
      trace({ messageId: 'a', category: 'rapport-compte-rendu-interne', startedAt: new Date('2026-08-01T00:00:00.000Z') }),
      { threadId: 't1', ownerActed: true },
    );
    db.recordTrace(
      trace({ messageId: 'b', category: 'demande-interne', startedAt: new Date('2026-08-30T00:00:00.000Z') }),
      { threadId: 't1', ownerActed: false },
    );

    expect(db.threadCategory('t1')).toBe('demande-interne');
    db.close();
  });
});

describe('stated routes are not learned patterns', () => {
  it('survives a learning pass, which replaces the whole pattern set', () => {
    // The reason routes live in their own table. `savePatterns` deletes
    // everything it finds before writing, and a stated route sharing that
    // table would be destroyed by a routine nobody would think to check.
    const store = new MailStore(':memory:');
    store.saveRoutes([
      { listId: null, sender: 'nple@linagora.com', category: 'spam-formulaire-contact', note: 'the Twake contact form relay' },
    ]);
    store.savePatterns([
      { listId: null, sender: 'someone@example.org', subjectContains: null, category: 'veille-newsletter', confidence: 0.9 },
    ]);

    expect(store.loadRoutes()).toHaveLength(1);
    expect(store.loadRoutes()[0]?.sender).toBe('nple@linagora.com');
    store.close();
  });

  it('keeps the note, because a surprising route has to carry its reason', () => {
    // Measured on the target mailbox: the company's own `vente@` alias routes
    // to spam, because contact-form submissions transit through it. Without
    // the note, the next person to read the table deletes it.
    const store = new MailStore(':memory:');
    store.saveRoutes([
      { listId: null, sender: 'vente@linagora.com', category: 'phishing-arnaque', note: 'contact-form spam transits this alias' },
    ]);
    expect(store.loadRoutes()[0]?.note).toBe('contact-form spam transits this alias');
    store.close();
  });

  it('drops a route naming a category the vocabulary no longer has', () => {
    // Written through a second connection to the same file rather than through
    // the store's own handle: reaching into a private field to set up a test
    // makes the test pass for a reason the class does not promise.
    const file = join(mkdtempSync(join(tmpdir(), 'mail-store-')), 'store.db');
    const store = new MailStore(file);
    store.saveRoutes([{ listId: null, sender: 'a@example.org', category: 'veille-newsletter' }]);
    store.close();

    const raw = new DatabaseSync(file);
    raw.exec("update routes set category = 'newsletter-promo'");
    raw.close();

    // Unlike a learned pattern, nothing will replace it: the owner stated it,
    // and only the owner can restate it.
    const reopened = new MailStore(file);
    expect(reopened.loadRoutes()).toStrictEqual([]);
    expect(reopened.countRoutes()).toBe(1);
    reopened.close();
  });

  it('keys a list route the same way a pattern is keyed', () => {
    // One key function for both tables, so a route and a pattern for the same
    // source cannot disagree about what identifies them.
    const store = new MailStore(':memory:');
    store.saveRoutes([
      { listId: 'License-Review.Lists.Example', sender: null, category: 'liste-diffusion' },
      { listId: 'license-review.lists.example', sender: null, category: 'veille-newsletter' },
    ]);
    expect(store.countRoutes()).toBe(1);
    store.close();
  });
});

describe('the profile seeds the routes, and then stops mattering', () => {
  it('writes the seed into an empty store', () => {
    const store = new MailStore(':memory:');
    expect(store.seedRoutes([
      { listId: null, sender: 'nple@linagora.com', category: 'spam-formulaire-contact' },
    ])).toBe(1);
    expect(store.loadRoutes()).toHaveLength(1);
    store.close();
  });

  it('leaves a store that already has routes alone', () => {
    // Otherwise a route the owner removed at runtime comes back on the next
    // restart, and one they added is silently outranked by a stale file.
    const store = new MailStore(':memory:');
    store.saveRoutes([{ listId: null, sender: 'kept@example.org', category: 'liste-diffusion' }]);

    expect(store.seedRoutes([
      { listId: null, sender: 'from-the-profile@example.org', category: 'veille-newsletter' },
    ])).toBe(0);
    expect(store.loadRoutes().map((r) => r.sender)).toStrictEqual(['kept@example.org']);
    store.close();
  });

  it('does nothing when there is no seed', () => {
    const store = new MailStore(':memory:');
    expect(store.seedRoutes([])).toBe(0);
    expect(store.countRoutes()).toBe(0);
    store.close();
  });
});
