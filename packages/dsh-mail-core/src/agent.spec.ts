/**
 * The loop, which is the first thing in this package that drives the rest.
 *
 * What is tested here is the pass's own behaviour — resuming, bounding,
 * advancing — rather than classification, which `cascade-loop.spec.ts` owns.
 */

import { describe, expect, it } from 'vitest';

import { MailStore } from './store/mail-store.js';
import { runAgent, describePass, backfill } from './agent.js';
import type { CascadeContext, ClassifierModel } from './cascade/types.js';
import type { MailService } from './mail-service.js';
import type { Capabilities, MailChange, MailMessage } from './types.js';

const CAPS: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
  stableIds: true,
};

const CONTEXT: CascadeContext = {
  owner: 'owner@example.org',
  vipSenders: [],
  corporateDomains: [],
  statedRoutes: [],
  threadCategory: null,
  learnedPatterns: [],
};

const model: ClassifierModel = {
  classify: () =>
    Promise.resolve({ category: 'veille-newsletter', confidence: 0.9, rationale: 'r' }),
};

function message(id: string, over: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    threadId: null,
    messageId: `${id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: null, email: 'news@example.org' }],
    to: [],
    cc: [],
    subject: 's',
    receivedAt: new Date(),
    sentAt: new Date(),
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...over,
  };
}

function mailbox(changes: MailChange[], messages: MailMessage[] = []) {
  const calls: string[] = [];
  /** Where each message has ended up, so a test can move one back. */
  const placed = new Map<string, string[]>();
  const service = {
    capabilities: CAPS,
    currentCursor: () => Promise.resolve('now'),
    queryChanges: (_folder: string, since: string) => {
      calls.push(`queryChanges:${since}`);
      return Promise.resolve(changes);
    },
    getMessages: (ids: string[]) => Promise.resolve(messages.filter((m) => ids.includes(m.id))),
    setKeywords: (id: string, kw: string[]) => {
      calls.push(`keywords:${id}:${kw.join(',')}`);
      return Promise.resolve();
    },
    moveMessage: (id: string, folder: string) => {
      calls.push(`move:${id}:${folder}`);
      placed.set(id, [folder]);
      return Promise.resolve();
    },
    locate: (ids: readonly string[]) => {
      const out = new Map<string, string[]>();
      for (const id of ids) {
        const at = placed.get(id);
        if (at !== undefined) out.set(id, at);
      }
      return Promise.resolve(out);
    },
  } as unknown as MailService;
  return { service, calls, placed };
}

const change = (id: string, cursor: string): MailChange => ({
  kind: 'created',
  id,
  folder: 'INBOX',
  cursor,
});

describe('a first pass does not invent a history', () => {
  it('stores the current position and classifies nothing', async () => {
    // The contract cannot enumerate a mailbox. Classifying whatever a first
    // poll happens to return would classify an arbitrary slice of the past and
    // call it new.
    const store = new MailStore(':memory:');
    const { service, calls } = mailbox([change('a', 'c1')], [message('a')]);

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });

    expect(pass.coldStart).toBe(true);
    expect(pass.classified).toStrictEqual([]);
    expect(calls).toStrictEqual([]);
    expect(store.loadCursor('INBOX')).toBe('now');
    store.close();
  });

  it('classifies on the pass after it', async () => {
    const store = new MailStore(':memory:');
    const { service } = mailbox([change('a', 'c1')], [message('a')]);

    await runAgent({ mailbox: service, store, context: CONTEXT, model });
    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });

    expect(pass.coldStart).toBe(false);
    expect(pass.classified).toHaveLength(1);
    expect(store.loadCursor('INBOX')).toBe('c1');
    store.close();
  });
});

describe('what one pass does', () => {
  const primed = (): MailStore => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    return store;
  };

  it('writes nothing unless asked', async () => {
    const store = primed();
    const { service, calls } = mailbox([change('a', 'c1')], [message('a')]);

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });

    expect(pass.dryRun).toBe(true);
    expect(calls.filter((c) => !c.startsWith('queryChanges'))).toStrictEqual([]);
    // And still records what it decided, so a dry run is measurable.
    expect(store.traceFor('a')).not.toBeNull();
    store.close();
  });

  it('writes the tag and nothing else when asked', async () => {
    // Only `keyword` is automatic under the shipped policy. A first real run
    // tags; it does not file.
    const store = primed();
    const { service, calls } = mailbox([change('a', 'c1')], [message('a')]);

    await runAgent({ mailbox: service, store, context: CONTEXT, model, dryRun: false });

    expect(calls.filter((c) => c.startsWith('keywords:'))).toStrictEqual([
      'keywords:a:$twaky-veille-newsletter',
    ]);
    expect(calls.filter((c) => c.startsWith('move:'))).toStrictEqual([]);
    store.close();
  });

  it('records the source, so the pass feeds the learning it needs', async () => {
    const store = primed();
    const { service } = mailbox(
      [change('a', 'c1')],
      [message('a', { listId: 'l.example', threadId: 't1' })],
    );

    await runAgent({ mailbox: service, store, context: CONTEXT, model });

    const [observation] = store.observations();
    expect(observation?.sender).toBe('news@example.org');
    expect(observation?.listId).toBe('l.example');
    store.close();
  });

  it('classifies a message reported twice only once', async () => {
    // A created-then-updated message in one batch would otherwise get two
    // traces for one arrival and be counted twice in every measurement built
    // on them.
    const store = primed();
    const { service } = mailbox(
      [change('a', 'c1'), { kind: 'updated', id: 'a', folder: 'INBOX', cursor: 'c2' }],
      [message('a')],
    );

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.classified).toHaveLength(1);
    store.close();
  });

  it('ignores a message destroyed before the pass reached it', async () => {
    const store = primed();
    const { service } = mailbox(
      [{ kind: 'destroyed', id: 'gone', folder: 'INBOX', cursor: 'c1' }],
      [],
    );

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.classified).toStrictEqual([]);
    expect(store.loadCursor('INBOX')).toBe('c1');
    store.close();
  });

  it('survives a message that vanished between the poll and the fetch', async () => {
    const store = primed();
    const { service } = mailbox([change('a', 'c1'), change('b', 'c2')], [message('b')]);

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.classified.map((t) => t.messageId)).toStrictEqual(['b']);
    store.close();
  });
});

describe('the limit bounds the pass, and says what that cost', () => {
  it('stops at the limit and leaves the cursor where it stopped', () => {
    // A limit is a rate, not a filter. An earlier version advanced past
    // everything the poll reported, on the reasoning that a backlog larger
    // than the limit would be re-polled forever. Each pass advances past what
    // it examined, so each pass makes progress; what the old rule actually did
    // was discard mail an agent stopped overnight would never come back to.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const changes = ['a', 'b', 'c'].map((id, i) => change(id, `c${String(i + 1)}`));
    const { service } = mailbox(
      changes,
      ['a', 'b', 'c'].map((id) => message(id)),
    );

    return runAgent({ mailbox: service, store, context: CONTEXT, model, limit: 2 }).then((pass) => {
      expect(pass.truncated).toBe(true);
      expect(pass.classified.map((t) => t.messageId)).toStrictEqual(['a', 'b']);
      expect(store.loadCursor('INBOX')).toBe('c2');
      expect(describePass(pass)).toContain('wait for the next one');
      store.close();
    });
  });

  it('picks up the rest on the pass after', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const all = ['a', 'b', 'c'].map((id, i) => change(id, `c${String(i + 1)}`));
    const messages = ['a', 'b', 'c'].map((id) => message(id));

    const first = mailbox(all, messages);
    await runAgent({ mailbox: first.service, store, context: CONTEXT, model, limit: 2 });

    // The server answers a cursor with what follows it.
    const rest = mailbox(all.slice(2), messages);
    const second = await runAgent({
      mailbox: rest.service,
      store,
      context: CONTEXT,
      model,
      limit: 2,
    });

    expect(second.classified.map((t) => t.messageId)).toStrictEqual(['c']);
    expect(store.loadCursor('INBOX')).toBe('c3');
    store.close();
  });

  it('leaves the cursor alone when nothing changed', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([]);

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.seen).toBe(0);
    expect(store.loadCursor('INBOX')).toBe('c0');
    store.close();
  });
});

describe('the agent does not chase its own writes', () => {
  it('leaves a message it has already decided alone', async () => {
    // Observed on the first real run: writing a keyword is an update, the next
    // poll reports the message as changed, and the agent classifies it again —
    // three model calls in nine minutes for one arrival.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([change('a', 'c1')], [message('a')]);

    const first = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    const second = await runAgent({ mailbox: service, store, context: CONTEXT, model });

    expect(first.classified).toHaveLength(1);
    expect(second.classified).toHaveLength(0);
    expect(second.alreadyDecided).toBe(1);
    store.close();
  });

  it('asks again about one the model could not be reached for', async () => {
    // Nothing was ever asked about it, so leaving it alone would make a
    // moment's rate limit a permanent verdict.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([change('a', 'c1')], [message('a')]);
    let down = true;
    const flaky: ClassifierModel = {
      classify: () =>
        down
          ? Promise.reject(new Error('429 rate limited'))
          : Promise.resolve({ category: 'veille-newsletter', confidence: 0.9, rationale: 'r' }),
    };

    const first = await runAgent({ mailbox: service, store, context: CONTEXT, model: flaky });
    expect(first.modelUnreachable).toBe(1);
    expect(store.traceFor('a')?.category).toBe('needs-review');

    down = false;
    const second = await runAgent({ mailbox: service, store, context: CONTEXT, model: flaky });
    expect(second.classified).toHaveLength(1);
    expect(store.traceFor('a')?.category).toBe('veille-newsletter');
    store.close();
  });

  it('says how many it passed over, so a quiet pass is not a broken one', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([change('a', 'c1')], [message('a')]);

    await runAgent({ mailbox: service, store, context: CONTEXT, model });
    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });

    expect(describePass(pass)).toContain('1 already decided');
    store.close();
  });
});

describe('an outage does not become a permanent verdict', () => {
  it('asks again about a message the poll will never report', async () => {
    // The retry added earlier only fired if the message came back through the
    // poll, and nothing changes a message that was never classified. The 429
    // from the first real run had frozen a notification at `needs-review` with
    // no way back.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    let down = true;
    const flaky: ClassifierModel = {
      classify: () =>
        down
          ? Promise.reject(new Error('429 rate limited'))
          : Promise.resolve({ category: 'veille-newsletter', confidence: 0.9, rationale: 'r' }),
    };

    const arrival = mailbox([change('a', 'c1')], [message('a')]);
    await runAgent({ mailbox: arrival.service, store, context: CONTEXT, model: flaky });
    expect(store.traceFor('a')?.category).toBe('needs-review');

    // The next poll reports nothing at all, as it would in reality.
    down = false;
    const quiet = mailbox([], [message('a')]);
    const pass = await runAgent({ mailbox: quiet.service, store, context: CONTEXT, model: flaky });

    expect(pass.retried).toBe(1);
    expect(store.traceFor('a')?.category).toBe('veille-newsletter');
    store.close();
  });

  it('stops retrying once the answer is an answer', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([change('a', 'c1')], [message('a')]);

    await runAgent({ mailbox: service, store, context: CONTEXT, model });
    const quiet = mailbox([], [message('a')]);
    const pass = await runAgent({ mailbox: quiet.service, store, context: CONTEXT, model });

    expect(pass.retried).toBe(0);
    expect(pass.classified).toHaveLength(0);
    store.close();
  });
});

describe('the pass reads what the owner moved back', () => {
  it('reports a correction against a stated route, with its total', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    store.saveRoutes([
      { listId: null, sender: 'news@example.org', category: 'spam-formulaire-contact' },
    ]);
    const { service } = mailbox([change('a', 'c1')], [message('a')]);
    // The route settles it and the policy files it, unattended.
    await runAgent({ mailbox: service, store, context: CONTEXT, model, dryRun: false });

    // The owner takes it back out.
    const moved = mailbox([], [message('a')]);
    moved.placed.set('a', ['INBOX']);

    const pass = await runAgent({ mailbox: moved.service, store, context: CONTEXT, model });
    expect(pass.corrections?.corrections).toHaveLength(1);
    expect(pass.corrections?.disputedRoutes[0]?.sender).toBe('news@example.org');
    expect(describePass(pass)).toContain('Only you can change a route.');
    store.close();
  });

  it('asks nothing on a server whose ids do not survive a move', async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const { service } = mailbox([], []);
    (service as unknown as { capabilities: unknown }).capabilities = { ...CAPS, stableIds: false };

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.corrections).toBeNull();
    store.close();
  });
});

describe('backfill reaches mail that predates every cursor', () => {
  const at = (day: number): Date => new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00Z`);

  function archive(days: readonly number[]) {
    const messages = days.map((d) => message(`m${String(d)}`, { receivedAt: at(d) }));
    const service = {
      capabilities: CAPS,
      messagesSince: (_folder: string, since: Date, limit: number) =>
        Promise.resolve(
          messages
            .filter((m) => m.receivedAt >= since)
            .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
            .slice(0, limit)
            .map((m) => m.id),
        ),
      getMessages: (ids: string[]) => Promise.resolve(messages.filter((m) => ids.includes(m.id))),
      setKeywords: () => Promise.resolve(),
      moveMessage: () => Promise.resolve(),
      locate: () => Promise.resolve(new Map<string, string[]>()),
    } as unknown as MailService;
    return service;
  }

  it('replays a week oldest first', async () => {
    // Arrival order is what nodes 1 and 3 are built on: a thread inherits from
    // the message before it, and a pattern is sightings accumulating.
    // Newest-first would produce a store that could not have arisen from the
    // mailbox.
    const store = new MailStore(':memory:');
    const result = await backfill({
      mailbox: archive([24, 25, 26, 27]),
      store,
      context: CONTEXT,
      model,
      since: at(24),
      pageSize: 2,
    });

    expect(result.classified.map((t) => t.messageId)).toStrictEqual(['m24', 'm25', 'm26', 'm27']);
    store.close();
  });

  it('pages past the message it just handled rather than re-reading it', async () => {
    // `messagesSince` is inclusive of its instant, so a page that did not move
    // the boundary forwards would return the same message for ever.
    const store = new MailStore(':memory:');
    const result = await backfill({
      mailbox: archive([24, 25, 26]),
      store,
      context: CONTEXT,
      model,
      since: at(24),
      pageSize: 1,
    });

    expect(result.examined).toBe(3);
    expect(result.classified).toHaveLength(3);
    store.close();
  });

  it('leaves the poll cursor alone', async () => {
    // A backfill reaches backwards and the poll moves forwards; a backfill
    // that moved the cursor would skip everything that arrived while it ran.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'live');
    await backfill({
      mailbox: archive([24, 25]),
      store,
      context: CONTEXT,
      model,
      since: at(24),
    });

    expect(store.loadCursor('INBOX')).toBe('live');
    store.close();
  });

  it('does not re-decide what the live loop already handled', async () => {
    const store = new MailStore(':memory:');
    const mailboxes = archive([24, 25]);
    await backfill({ mailbox: mailboxes, store, context: CONTEXT, model, since: at(24) });
    const again = await backfill({ mailbox: mailboxes, store, context: CONTEXT, model, since: at(24) });

    expect(again.classified).toStrictEqual([]);
    expect(again.alreadyDecided).toBe(2);
    store.close();
  });

  it('stops at the limit', async () => {
    const store = new MailStore(':memory:');
    const result = await backfill({
      mailbox: archive([24, 25, 26, 27, 28]),
      store,
      context: CONTEXT,
      model,
      since: at(24),
      limit: 2,
    });

    expect(result.examined).toBe(2);
    store.close();
  });
});

describe('a replay learns as it goes, or it measures a cold agent', () => {
  const at = (day: number, hour = 9): Date =>
    new Date(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`);

  function fromOneSender(count: number) {
    const messages = Array.from({ length: count }, (_, i) =>
      message(`s${String(i)}`, {
        receivedAt: at(24, i),
        from: [{ name: null, email: 'digest@example.org' }],
      }),
    );
    return {
      capabilities: CAPS,
      messagesSince: (_f: string, since: Date, limit: number) =>
        Promise.resolve(
          messages
            .filter((m) => m.receivedAt >= since)
            .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
            .slice(0, limit)
            .map((m) => m.id),
        ),
      getMessages: (ids: string[]) => Promise.resolve(messages.filter((m) => ids.includes(m.id))),
      setKeywords: () => Promise.resolve(),
      moveMessage: () => Promise.resolve(),
      locate: () => Promise.resolve(new Map<string, string[]>()),
    } as unknown as MailService;
  }

  it('lets later mail benefit from earlier mail', async () => {
    // Ordering the replay oldest-first exists for this. Learning only at the
    // end means node 3 reads an empty list for the whole week, every message
    // reaches the model, and what is measured is a cold agent however long the
    // history was — observed on a real replay: 74 messages, 0 settled free.
    const store = new MailStore(':memory:');
    const result = await backfill({
      mailbox: fromOneSender(8),
      store,
      context: CONTEXT,
      model,
      since: at(24, 0),
      pageSize: 4,
    });

    expect(result.patterns).toBe(1);
    const free = result.classified.filter((t) => !t.usedModel).length;
    expect(free).toBeGreaterThan(0);
    store.close();
  });

  it('measures a cold agent when told not to learn', async () => {
    const store = new MailStore(':memory:');
    const result = await backfill({
      mailbox: fromOneSender(8),
      store,
      context: CONTEXT,
      model,
      since: at(24, 0),
      pageSize: 4,
      learnBetweenPages: false,
    });

    expect(result.patterns).toBe(0);
    expect(result.classified.every((t) => t.usedModel)).toBe(true);
    store.close();
  });
});
