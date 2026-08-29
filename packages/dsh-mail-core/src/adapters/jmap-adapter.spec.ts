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

  it('maps added and removed onto the change feed', async () => {
    const transport = transportOf(MAILBOXES, {
      oldQueryState: 's1',
      newQueryState: 's2',
      added: [{ id: 'e2', index: 0 }],
      removed: ['e1'],
    });
    const adapter = adapterWith(transport);
    const changes = await adapter.queryChanges(
      'INBOX',
      encodeCursor({ kind: 'jmap', sinceState: 's1' }),
    );

    expect(changes).toStrictEqual([
      { kind: 'destroyed', id: 'e1', folder: 'INBOX', cursor: 'jmap:s2' },
      { kind: 'created', id: 'e2', folder: 'INBOX', cursor: 'jmap:s2' },
    ]);
  });

  it('filters on the resolved mailbox id, not the path', async () => {
    const transport = transportOf(MAILBOXES, { newQueryState: 's2', added: [], removed: [] });
    const adapter = adapterWith(transport);
    await adapter.queryChanges('Newsletters/Tech', encodeCursor({ kind: 'jmap', sinceState: 's1' }));

    const [, changesCall] = transport.sent;
    expect(changesCall?.methodCalls[0]?.[1]).toMatchObject({
      filter: { inMailbox: 'mb-tech' },
      sinceQueryState: 's1',
    });
  });

  it('fails loudly when the server returns no new state', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES, { added: [], removed: [] }));
    await expect(
      adapter.queryChanges('INBOX', encodeCursor({ kind: 'jmap', sinceState: 's1' })),
    ).rejects.toThrow(/newQueryState/);
  });
});

describe('getMessages', () => {
  const EMAIL = {
    list: [
      {
        id: 'e1',
        threadId: 't1',
        mailboxIds: { 'mb-tech': true },
        keywords: { $seen: true, '$twaky-newsletter-tech': true },
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
    const adapter = adapterWith(transportOf(EMAIL, MAILBOXES));
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
      keywords: ['$seen', '$twaky-newsletter-tech'],
    });
    expect(message?.receivedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');
  });

  it('splits every List-Unsubscribe target (RFC 2369)', async () => {
    const adapter = adapterWith(transportOf(EMAIL, MAILBOXES));
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
      transportOf(
        {
          list: [
            {
              id: 'e1',
              receivedAt: '2026-08-20T10:00:00Z',
              'header:X-Spam-Score:asText': '4.2',
              'header:X-Spam-Status:asText': 'No',
              'header:Subject:asText': 'not a spam header',
            },
          ],
        },
        MAILBOXES,
      ),
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
    await adapter.setKeywords('e1', ['$Seen', '$TWAKY-Important']);

    expect(transport.sent[0]?.methodCalls[0]?.[1]).toStrictEqual({
      accountId: 'acc1',
      update: { e1: { keywords: { $seen: true, '$twaky-important': true } } },
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
      MAILBOXES,
      { queryState: 's1' },
      { newQueryState: 's2', added: [{ id: 'e5' }], removed: [] },
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
    // The mailbox list comes first: a folder is addressed by path, and the
    // adapter resolves it to an id before it can filter on it.
    const transport = transportOf(MAILBOXES, { queryState: 'qs-42', ids: [] });
    const adapter = adapterWith(transport);

    const cursor = await adapter.currentCursor('INBOX');

    expect(decodeCursor(cursor)).toEqual({ kind: 'jmap', sinceState: 'qs-42' });
    const [call] = transport.sent[1]?.methodCalls ?? [];
    expect(call?.[0]).toBe('Email/query');
    expect(call?.[1]).toMatchObject({ filter: { inMailbox: 'mb-inbox' } });
    // Asking for the state must not drag the folder's contents across the
    // wire: on a real inbox that is tens of thousands of messages. Not zero,
    // which James rejects as `invalidArguments` while a fake accepts it — a
    // difference only the integration suite could report.
    expect((call?.[1] as { limit?: number }).limit).toBe(1);
  });

  it('produces a cursor queryChanges accepts', async () => {
    const cursor = await adapterWith(transportOf(MAILBOXES, { queryState: 'qs-7' })).currentCursor(
      'INBOX',
    );
    const adapter = adapterWith(
      transportOf(MAILBOXES, { newQueryState: 'qs-7', added: [], removed: [] }),
    );

    await expect(adapter.queryChanges('INBOX', cursor)).resolves.toEqual([]);
  });

  it('refuses to invent a state the server did not report', async () => {
    const adapter = adapterWith(transportOf(MAILBOXES, { ids: [] }));
    await expect(adapter.currentCursor('INBOX')).rejects.toThrow(/queryState/);
  });
});
