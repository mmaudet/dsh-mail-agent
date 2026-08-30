/**
 * The loop, which is the first thing in this package that drives the rest.
 *
 * What is tested here is the pass's own behaviour — resuming, bounding,
 * advancing — rather than classification, which `cascade-loop.spec.ts` owns.
 */

import { describe, expect, it } from 'vitest';

import { MailStore } from './store/mail-store.js';
import { runAgent, describePass } from './agent.js';
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
      return Promise.resolve();
    },
  } as unknown as MailService;
  return { service, calls };
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
  const primed = async () => {
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    return store;
  };

  it('writes nothing unless asked', async () => {
    const store = await primed();
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
    const store = await primed();
    const { service, calls } = mailbox([change('a', 'c1')], [message('a')]);

    await runAgent({ mailbox: service, store, context: CONTEXT, model, dryRun: false });

    expect(calls.filter((c) => c.startsWith('keywords:'))).toStrictEqual([
      'keywords:a:$twaky-veille-newsletter',
    ]);
    expect(calls.filter((c) => c.startsWith('move:'))).toStrictEqual([]);
    store.close();
  });

  it('records the source, so the pass feeds the learning it needs', async () => {
    const store = await primed();
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
    const store = await primed();
    const { service } = mailbox(
      [change('a', 'c1'), { kind: 'updated', id: 'a', folder: 'INBOX', cursor: 'c2' }],
      [message('a')],
    );

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.classified).toHaveLength(1);
    store.close();
  });

  it('ignores a message destroyed before the pass reached it', async () => {
    const store = await primed();
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
    const store = await primed();
    const { service } = mailbox([change('a', 'c1'), change('b', 'c2')], [message('b')]);

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model });
    expect(pass.classified.map((t) => t.messageId)).toStrictEqual(['b']);
    store.close();
  });
});

describe('the limit bounds the pass, and says what that cost', () => {
  it('stops at the limit and advances past what it skipped', async () => {
    // The cursor advances over everything the poll reported, or a backlog
    // larger than the limit is re-polled forever and the pass never reaches
    // the present. What that costs is reported rather than hidden.
    const store = new MailStore(':memory:');
    store.saveCursor('INBOX', 'c0');
    const changes = ['a', 'b', 'c'].map((id, i) => change(id, `c${String(i + 1)}`));
    const { service } = mailbox(changes, ['a', 'b', 'c'].map((id) => message(id)));

    const pass = await runAgent({ mailbox: service, store, context: CONTEXT, model, limit: 2 });

    expect(pass.truncated).toBe(true);
    expect(pass.classified).toHaveLength(2);
    expect(store.loadCursor('INBOX')).toBe('c3');
    expect(describePass(pass)).toContain('passed over, not deferred');
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
