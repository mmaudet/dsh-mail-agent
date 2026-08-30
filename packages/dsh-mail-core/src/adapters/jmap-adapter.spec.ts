import { describe, expect, it, vi } from 'vitest';

import { decodeCursor, encodeCursor } from '../types.js';
import {
  JmapAdapter,
  type JmapPushChannel,
  type JmapRequest,
  type JmapTransport,
} from './jmap-adapter.js';

/** Replays canned method responses and records what was asked. */
function transportOf(...responses: readonly unknown[]): JmapTransport & {
  readonly sent: JmapRequest[];
} {
  const sent: JmapRequest[] = [];
  let index = 0;
  return {
    sent,
    request: vi.fn((body: JmapRequest): Promise<unknown> => {
      sent.push(body);
      const args = responses[index++] ?? {};
      const callId = body.methodCalls[0]?.[2] ?? 'c0';
      const name = body.methodCalls[0]?.[0] ?? 'Unknown';
      return Promise.resolve({ methodResponses: [[name, args, callId]] });
    }),
  };
}

const MAILBOXES = {
  list: [
    { id: 'mb-inbox', name: 'INBOX', parentId: null, role: 'inbox', totalEmails: 3, unreadEmails: 1 },
    { id: 'mb-news', name: 'Newsletters', parentId: null, role: null, totalEmails: 0, unreadEmails: 0 },
    { id: 'mb-tech', name: 'Tech', parentId: 'mb-news', role: null, totalEmails: 9, unreadEmails: 2 },
    { id: 'mb-drafts', name: 'Drafts', parentId: null, role: 'drafts', totalEmails: 0, unreadEmails: 0 },
  ],
};

function adapterWith(transport: JmapTransport): JmapAdapter {
  return new JmapAdapter({ transport, accountId: 'acc1', identityId: 'id1' });
}

describe('listFolders', () => {
  it('builds nested paths from parentId', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES));
    const folders = await adapter.listFolders();

    expect(folders.map((f) => f.path)).toStrictEqual([
      'INBOX',
      'Newsletters',
      'Newsletters/Tech',
      'Drafts',
    ]);
  });

  it('carries roles and counts through', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES));
    const [inbox] = await adapter.listFolders();

    expect(inbox).toStrictEqual({
      id: 'mb-inbox',
      name: 'INBOX',
      path: 'INBOX',
      role: 'inbox',
      totalMessages: 3,
      unreadMessages: 1,
    });
  });

  it('ignores a role the vocabulary does not cover', async () => {
    const adapter = adapterWith(
      transportOf({ list: [{ id: 'm', name: 'X', parentId: null, role: 'importantMail' }] }),
    );
    const [folder] = await adapter.listFolders();
    expect(folder?.role).toBeNull();
  });

  it('survives a parentId cycle rather than looping forever', async () => {
    const adapter = adapterWith(
      transportOf({
        list: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' },
        ],
      }),
    );
    const folders = await adapter.listFolders();
    expect(folders.map((f) => f.path)).toStrictEqual(['B/A', 'A/B']);
  });
});

describe('queryChanges', () => {
  it('refuses a cursor issued by the other adapter', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES));
    const imapCursor = encodeCursor({ kind: 'imap', uidValidity: 1, lastUid: 2 });

    await expect(adapter.queryChanges('INBOX', imapCursor)).rejects.toThrow(/Not a JMAP cursor/);
  });

  it('maps created, updated and destroyed onto the change feed', async () => {
    const transport = transportOf(
      MAILBOXES,
      { oldState: 's1', newState: 's2', created: ['e2'], updated: ['e3'], destroyed: ['e1'] },
      { list: [{ id: 'e2', mailboxIds: { 'mb-inbox': true } }, { id: 'e3', mailboxIds: { 'mb-inbox': true } }] },
    );
    const adapter = adapterWith(transport);
    const changes = await adapter.queryChanges(
      'INBOX',
      encodeCursor({ kind: 'jmap', sinceState: 's1' }),
    );

    expect(changes).toStrictEqual([
      { kind: 'destroyed', id: 'e1', folder: 'INBOX', cursor: 'jmap:s2' },
      { kind: 'created', id: 'e2', folder: 'INBOX', cursor: 'jmap:s2' },
      // `Email/queryChanges`, which the PRD names, cannot report this at all:
      // a keyword edit does not move a message in or out of a query.
      { kind: 'updated', id: 'e3', folder: 'INBOX', cursor: 'jmap:s2' },
    ]);
  });

  it('drops changes that landed in another folder', async () => {
    // `Email/changes` is account-wide, so a poll on one folder sees the whole
    // account's traffic and has to route it.
    const transport = transportOf(
      MAILBOXES,
      { newState: 's2', created: ['e2', 'e9'], updated: [], destroyed: [] },
      { list: [{ id: 'e2', mailboxIds: { 'mb-inbox': true } }, { id: 'e9', mailboxIds: { 'mb-tech': true } }] },
    );
    const changes = await adapterWith(transport).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'jmap', sinceState: 's1' }),
    );

    expect(changes.map((c) => c.id)).toStrictEqual(['e2']);
  });

  it('counts from the account state and bounds what it asks for', async () => {
    const transport = transportOf(MAILBOXES, { newState: 's2', created: [], updated: [], destroyed: [] });
    await adapterWith(transport).queryChanges(
      'Newsletters/Tech',
      encodeCursor({ kind: 'jmap', sinceState: 's1' }),
    );

    const [, changesCall] = transport.sent;
    expect(changesCall?.methodCalls[0]?.[0]).toBe('Email/changes');
    expect(changesCall?.methodCalls[0]?.[1]).toMatchObject({ sinceState: 's1' });
    // Unbounded, a poll a week behind blocks until it has drained the account.
    expect((changesCall?.methodCalls[0]?.[1] as { maxChanges?: number }).maxChanges).toBeGreaterThan(0);
  });

  it('asks nothing more when the account reports no change', async () => {
    const transport = transportOf(MAILBOXES, { newState: 's1', created: [], updated: [], destroyed: [] });
    const changes = await adapterWith(transport).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'jmap', sinceState: 's1' }),
    );

    expect(changes).toStrictEqual([]);
    // Two calls, not three: the mailbox lookup is skipped when there is
    // nothing to route.
    expect(transport.sent).toHaveLength(2);
  });

  it('fails loudly when the server returns no new state', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES, { created: [], updated: [], destroyed: [] }));
    await expect(
      adapter.queryChanges('INBOX', encodeCursor({ kind: 'jmap', sinceState: 's1' })),
    ).rejects.toThrow(/newState/);
  });
});

describe('getMessages', () => {
  const EMAIL = {
    list: [
      {
        id: 'e1',
        threadId: 't1',
        mailboxIds: { 'mb-tech': true },
        keywords: { $seen: true, '$twaky-veille-newsletter': true },
        messageId: ['abc@example.org'],
        inReplyTo: ['prev@example.org'],
        references: ['root@example.org'],
        from: [{ name: 'A List', email: 'list@example.org' }],
        to: [{ name: null, email: 'me@example.org' }],
        cc: [],
        subject: 'Weekly digest',
        receivedAt: '2026-08-20T10:00:00Z',
        sentAt: '2026-08-20T09:59:00Z',
        preview: 'Top stories',
        hasAttachment: false,
        textBody: [{ partId: 'p1' }],
        bodyValues: { p1: { value: 'Body text' } },
        'header:list-unsubscribe:asText':
          '<https://example.org/u/1>, <mailto:unsub@example.org>',
      },
    ],
  };

  it('returns nothing without asking the server', async () => {
    const transport = transportOf();
    const adapter = adapterWith(transport);

    expect(await adapter.getMessages([])).toStrictEqual([]);
    expect(transport.sent).toStrictEqual([]);
  });

  it('maps a message onto the domain shape', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES, EMAIL));
    const [message] = await adapter.getMessages(['e1']);

    expect(message).toMatchObject({
      id: 'e1',
      threadId: 't1',
      messageId: 'abc@example.org',
      inReplyTo: ['prev@example.org'],
      subject: 'Weekly digest',
      folder: 'Newsletters/Tech',
      bodyText: 'Body text',
      bodyHtml: null,
      hasAttachments: false,
      keywords: ['$seen', '$twaky-veille-newsletter'],
    });
    expect(message?.receivedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('splits every List-Unsubscribe target (RFC 2369)', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES, EMAIL));
    const [message] = await adapter.getMessages(['e1']);

    expect(message?.listUnsubscribe).toStrictEqual([
      'https://example.org/u/1',
      'mailto:unsub@example.org',
    ]);
  });

  it('drops an entry with no id rather than inventing one', async () => {
    const adapter = adapterWith(
      transportOf({ list: [{ threadId: 't1', receivedAt: '2026-08-20T10:00:00Z' }] }, MAILBOXES),
    );
    expect(await adapter.getMessages(['e1'])).toStrictEqual([]);
  });

  it('collects x-spam headers and lowercases their names', async () => {
    const adapter = adapterWith(
      transportOf(MAILBOXES, {
        list: [
          {
            id: 'e1',
            receivedAt: '2026-08-20T10:00:00Z',
            'header:X-Spam-Score:asText': '4.2',
            'header:X-Spam-Status:asText': 'No',
            'header:Subject:asText': 'not a spam header',
          },
        ],
      }),
    );
    const [message] = await adapter.getMessages(['e1']);

    expect(message?.spamHeaders).toStrictEqual({ 'x-spam-score': '4.2', 'x-spam-status': 'No' });
  });
});

describe('writes', () => {
  it('moves a message by replacing its mailboxIds', async () => {
    const transport = transportOf(MAILBOXES, {});
    const adapter = adapterWith(transport);
    await adapter.moveMessage('e1', 'Newsletters/Tech');

    expect(transport.sent[1]?.methodCalls[0]?.[1]).toStrictEqual({
      accountId: 'acc1',
      update: { e1: { mailboxIds: { 'mb-tech': true } } },
    });
  });

  it('lowercases keywords, which JMAP compares case-insensitively', async () => {
    const transport = transportOf({});
    const adapter = adapterWith(transport);
    await adapter.setKeywords('e1', ['$Seen', '$TWAKY-Demande-Interne']);

    expect(transport.sent[0]?.methodCalls[0]?.[1]).toStrictEqual({
      accountId: 'acc1',
      update: { e1: { keywords: { $seen: true, '$twaky-demande-interne': true } } },
    });
  });

  it('reports a rejected update instead of returning quietly', async () => {
    const adapter = adapterWith(transportOf({ notUpdated: { e1: { type: 'forbidden' } } }));
    await expect(adapter.setKeywords('e1', ['$seen'])).rejects.toThrow(/forbidden/);
  });

  it('surfaces a method-level error', async () => {
    const transport: JmapTransport = {
      request: () =>
        Promise.resolve({ methodResponses: [['error', { type: 'accountNotFound' }, 'c0']] }),
    };
    await expect(adapterWith(transport).listFolders()).rejects.toThrow(/accountNotFound/);
  });
});

describe('drafts and submission', () => {
  it('creates a draft in the Drafts mailbox and returns its id', async () => {
    const transport = transportOf(MAILBOXES, { created: { draft: { id: 'e9' } } });
    const adapter = adapterWith(transport);

    const id = await adapter.createDraft({
      to: [{ name: null, email: 'someone@example.org' }],
      cc: [],
      subject: 'Re: hello',
      bodyText: 'Hi',
      inReplyTo: 'prev@example.org',
      references: ['root@example.org'],
    });

    expect(id).toBe('e9');
    expect(transport.sent[1]?.methodCalls[0]?.[1]).toMatchObject({
      create: {
        draft: {
          mailboxIds: { 'mb-drafts': true },
          keywords: { $draft: true },
          inReplyTo: ['prev@example.org'],
          references: ['root@example.org'],
        },
      },
    });
  });

  it('explains why a draft was refused', async () => {
    const adapter = adapterWith(
      transportOf(MAILBOXES, { notCreated: { draft: { type: 'tooLarge' } } }),
    );
    await expect(
      adapter.createDraft({
        to: [],
        cc: [],
        subject: '',
        bodyText: '',
        inReplyTo: null,
        references: [],
      }),
    ).rejects.toThrow(/tooLarge/);
  });

  it('submits with the configured identity and clears the draft keyword', async () => {
    const transport = transportOf({ created: { submission: { id: 's1' } } });
    const adapter = adapterWith(transport);
    await adapter.submitDraft('e9');

    const call = transport.sent[0]?.methodCalls[0];
    expect(transport.sent[0]?.using).toContain('urn:ietf:params:jmap:submission');
    expect(call?.[1]).toMatchObject({
      create: { submission: { emailId: 'e9', identityId: 'id1' } },
      onSuccessUpdateEmail: { '#submission': { 'keywords/$draft': null } },
    });
  });

  it('reports a refused submission', async () => {
    const adapter = adapterWith(transportOf({ notCreated: { submission: { type: 'forbidden' } } }));
    await expect(adapter.submitDraft('e9')).rejects.toThrow(/forbidden/);
  });
});

/** A push channel whose StateChange can be fired from the test body. */
function fakePush(): { channel: JmapPushChannel; fire: () => void } {
  const handlers: (() => void)[] = [];
  return {
    channel: {
      subscribe: (onStateChange) => {
        handlers.push(onStateChange);
        return { [Symbol.asyncDispose]: () => Promise.resolve() };
      },
    },
    fire: () => {
      for (const handler of handlers) handler();
    },
  };
}

describe('watchInbox', () => {
  it('refuses to pretend it can push without a channel', () => {
    const adapter = adapterWith(transportOf());
    expect(() => adapter.watchInbox(() => undefined)).toThrow(/push channel/);
  });

  it('polls the delta when the server signals a state change', async () => {
    const transport = transportOf(
      // The initial cursor, then the delta, then the lookup that routes it.
      { state: 's1' },
      MAILBOXES,
      { newState: 's2', created: ['e5'], updated: [], destroyed: [] },
      { list: [{ id: 'e5', mailboxIds: { 'mb-inbox': true } }] },
    );
    const push = fakePush();
    const adapter = new JmapAdapter({
      transport,
      accountId: 'acc1',
      identityId: 'id1',
      push: push.channel,
    });

    const seen: string[] = [];
    const subscription = adapter.watchInbox((change) => seen.push(change.id));
    push.fire();
    await vi.waitFor(() => {
      expect(seen).toStrictEqual(['e5']);
    });

    await subscription[Symbol.asyncDispose]();
  });

  it('keeps the subscription alive when a poll fails', async () => {
    const transport: JmapTransport = { request: () => Promise.reject(new Error('offline')) };
    const push = fakePush();
    const adapter = new JmapAdapter({
      transport,
      accountId: 'acc1',
      identityId: 'id1',
      push: push.channel,
    });

    const subscription = adapter.watchInbox(() => undefined);
    expect(() => {
      push.fire();
    }).not.toThrow();
    await subscription[Symbol.asyncDispose]();
  });
});

describe('currentCursor', () => {
  it('reports the query state without asking for any message', async () => {
    // The cold start, named: `queryChanges` needs a cursor, and every cursor
    // it produces rides on a `MailChange`, so a quiet folder hands back
    // nothing to resume from. A first run begins here.
    const transport = transportOf({ state: 'ms-42', list: [], notFound: [] });
    const adapter = adapterWith(transport);

    const cursor = await adapter.currentCursor('INBOX');

    expect(decodeCursor(cursor)).toEqual({ kind: 'jmap', sinceState: 'ms-42' });
    const [call] = transport.sent[0]?.methodCalls ?? [];
    // `Email/get` with no ids answers with the account's mail state and
    // nothing else — the state `Email/changes` counts from.
    expect(call?.[0]).toBe('Email/get');
    expect(call?.[1]).toMatchObject({ ids: [] });
  });

  it('produces a cursor queryChanges accepts', async () => {
    const cursor = await adapterWith(transportOf({ state: 'ms-7' })).currentCursor('INBOX');
    const adapter = adapterWith(
      transportOf(MAILBOXES, { newState: 'ms-7', created: [], updated: [], destroyed: [] }),
    );

    await expect(adapter.queryChanges('INBOX', cursor)).resolves.toEqual([]);
  });

  it('refuses to invent a state the server did not report', async () => {
    const adapter = adapterWith(transportOf({ list: [] }));
    await expect(adapter.currentCursor('INBOX')).rejects.toThrow(/state/);
  });
});

describe('headers the cascade reasons about', () => {
  it('reads x-spam-* and Authentication-Results out of the headers list', async () => {
    // JMAP returns only the properties asked for, and the ones the cascade
    // needs cannot be named in advance: asking for a fixed list is how nodes 2
    // and 5 came to see nothing at all on a live account.
    const transport = transportOf(MAILBOXES, {
      list: [
        {
          id: 'e1',
          threadId: 't1',
          mailboxIds: { 'mb-inbox': true },
          keywords: {},
          messageId: ['abc@example.org'],
          inReplyTo: [],
          references: [],
          from: [{ name: 'A', email: 'a@example.org' }],
          to: [{ name: null, email: 'me@example.org' }],
          cc: [],
          subject: 'S',
          receivedAt: '2026-08-29T10:00:00Z',
          sentAt: '2026-08-29T09:59:00Z',
          preview: 'p',
          hasAttachment: false,
          headers: [
            { name: 'X-Spam-Score', value: ' 14.8 ' },
            { name: 'Authentication-Results', value: 'mx; dmarc=fail (p=reject)' },
            { name: 'Subject', value: 'not a spam header' },
          ],
        },
      ],
    });

    const [message] = await adapterWith(transport).getMessages(['e1']);
    expect(message?.spamHeaders).toStrictEqual({
      'x-spam-score': '14.8',
      'authentication-results': 'mx; dmarc=fail (p=reject)',
    });
  });

  it('asks the server for the headers list', async () => {
    const transport = transportOf(MAILBOXES, { list: [] });
    await adapterWith(transport).getMessages(['e1']);

    const properties = (transport.sent[1]?.methodCalls[0]?.[1] as { properties?: string[] })
      .properties;
    expect(properties).toContain('headers');
  });
});

describe('getMessages batching', () => {
  it('splits a large request rather than letting the server refuse it', async () => {
    // 200 ids answered `requestTooLarge` on the target account, well under the
    // advertised maxObjectsInGet of 500: it is a size limit, not a count one.
    const ids = Array.from({ length: 120 }, (_, i) => `e${String(i)}`);
    const transport = transportOf(MAILBOXES, { list: [] }, { list: [] }, { list: [] });

    await adapterWith(transport).getMessages(ids);

    const gets = transport.sent.filter((b) => b.methodCalls[0]?.[0] === 'Email/get');
    expect(gets).toHaveLength(3);
    for (const get of gets) {
      expect((get.methodCalls[0]?.[1] as { ids: string[] }).ids.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('messagesSince pages past the server cap', () => {
  it('keeps asking until it has what was requested', async () => {
    // `Email/query` on the target server caps a page at 256 whatever is asked,
    // and returns the truncated page without saying so. This project was
    // already caught by that once, and asking for 1500 here silently returned
    // 256 — the same mistake, in a primitive added to avoid a different one.
    const pages = [
      Array.from({ length: 256 }, (_, i) => `a${String(i)}`),
      Array.from({ length: 256 }, (_, i) => `b${String(i)}`),
      Array.from({ length: 10 }, (_, i) => `c${String(i)}`),
    ];
    let call = 0;
    const transport = {
      sent: [] as JmapRequest[],
      request(body: JmapRequest) {
        transport.sent.push(body);
        const name = body.methodCalls[0]?.[0];
        if (name === 'Mailbox/get') {
          return Promise.resolve({
            methodResponses: [['Mailbox/get', { list: [{ id: 'f1', name: 'INBOX', parentId: null, role: 'inbox', totalEmails: 0, unreadEmails: 0 }] }, 'c']],
          });
        }
        const ids = pages[call] ?? [];
        call += 1;
        return Promise.resolve({ methodResponses: [['Email/query', { ids }, 'q0']] });
      },
    };
    const adapter = new JmapAdapter({ transport, accountId: 'acc1', identityId: 'id1' });

    const ids = await adapter.messagesSince('INBOX', new Date('2026-08-24'), 600);

    expect(ids).toHaveLength(522);
    expect(ids[0]).toBe('a0');
    expect(ids.at(-1)).toBe('c9');
  });

  it('stops at the limit rather than overrunning it', async () => {
    const transport = {
      request(body: JmapRequest) {
        if (body.methodCalls[0]?.[0] === 'Mailbox/get') {
          return Promise.resolve({
            methodResponses: [['Mailbox/get', { list: [{ id: 'f1', name: 'INBOX', parentId: null, role: 'inbox', totalEmails: 0, unreadEmails: 0 }] }, 'c']],
          });
        }
        const asked = body.methodCalls[0]?.[1]['limit'] as number;
        return Promise.resolve({
          methodResponses: [['Email/query', { ids: Array.from({ length: asked }, (_, i) => `x${String(i)}`) }, 'q0']],
        });
      },
    };
    const adapter = new JmapAdapter({ transport, accountId: 'acc1', identityId: 'id1' });

    expect(await adapter.messagesSince('INBOX', new Date('2026-08-24'), 100)).toHaveLength(100);
  });

  it('asks for nothing when the limit is nothing', async () => {
    const transport = {
      request: () => Promise.reject(new Error('must not be called')),
    };
    const adapter = new JmapAdapter({ transport, accountId: 'acc1', identityId: 'id1' });
    expect(await adapter.messagesSince('INBOX', new Date(), 0)).toStrictEqual([]);
  });
});
