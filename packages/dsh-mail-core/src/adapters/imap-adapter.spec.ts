import { describe, expect, it, vi } from 'vitest';

import { encodeCursor } from '../types.js';
import {
  ImapAdapter,
  RE_IDLE_INTERVAL_MS,
  messageId,
  parseMessageId,
  type ImapConnection,
  type ImapFetchedMessage,
  type ImapMailbox,
  type MailboxStatus,
  type OutgoingMessage,
  type SmtpSender,
} from './imap-adapter.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeOptions {
  readonly status?: MailboxStatus;
  readonly mailboxes?: readonly ImapMailbox[];
  readonly uids?: readonly number[];
  readonly fetched?: readonly ImapFetchedMessage[];
}

class FakeConnection implements ImapConnection {
  readonly moved: { uid: number; from: string; to: string }[] = [];
  readonly flagged: { uid: number; flags: readonly string[] }[] = [];
  readonly appended: { path: string; flags: readonly string[] }[] = [];
  readonly ensured: string[] = [];
  readonly idled: string[] = [];
  /** Resolves the pending idle so a test can advance the loop. */
  onIdle: ((change: () => void) => void) | null = null;

  constructor(private readonly options: FakeOptions = {}) {}

  open(): Promise<MailboxStatus> {
    return Promise.resolve(this.options.status ?? { uidValidity: 7, uidNext: 11 });
  }

  listMailboxes(): Promise<readonly ImapMailbox[]> {
    return Promise.resolve(this.options.mailboxes ?? []);
  }

  searchFrom(): Promise<readonly number[]> {
    return Promise.resolve(this.options.uids ?? []);
  }

  fetchByUid(_path: string, uids: readonly number[]): Promise<readonly ImapFetchedMessage[]> {
    const all = this.options.fetched ?? [];
    return Promise.resolve(all.filter((message) => uids.includes(message.uid)));
  }

  moveByUid(path: string, uid: number, target: string): Promise<void> {
    this.moved.push({ uid, from: path, to: target });
    return Promise.resolve();
  }

  addFlagsByUid(_path: string, uid: number, flags: readonly string[]): Promise<void> {
    this.flagged.push({ uid, flags: [...flags] });
    return Promise.resolve();
  }

  append(path: string, _raw: string, flags: readonly string[]): Promise<number | null> {
    this.appended.push({ path, flags: [...flags] });
    return Promise.resolve(42);
  }

  ensureMailbox(path: string): Promise<void> {
    this.ensured.push(path);
    return Promise.resolve();
  }

  idle(path: string, signal: AbortSignal, onChange: () => void): Promise<void> {
    this.idled.push(path);
    this.onIdle?.(onChange);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        resolve();
      });
    });
  }
}

class FakeSmtp implements SmtpSender {
  readonly sent: OutgoingMessage[] = [];

  send(message: OutgoingMessage): Promise<{ messageId: string; raw: string }> {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'generated@example.org', raw: 'RAW-BYTES' });
  }
}

function fetched(overrides: Partial<ImapFetchedMessage> = {}): ImapFetchedMessage {
  return {
    uid: 5,
    flags: ['\\Seen'],
    envelope: {
      messageId: '<own@example.org>',
      inReplyTo: '<parent@example.org>',
      subject: 'Hello',
      date: new Date('2026-08-20T09:00:00Z'),
      from: [{ name: 'A', email: 'a@example.org' }],
      to: [{ name: null, email: 'me@example.org' }],
      cc: [],
    },
    internalDate: new Date('2026-08-20T10:00:00Z'),
    headers: {},
    bodyText: 'Body',
    bodyHtml: null,
    hasAttachments: false,
    ...overrides,
  };
}

function adapterOf(connection: ImapConnection, smtp: SmtpSender = new FakeSmtp()): ImapAdapter {
  return new ImapAdapter({ connection, smtp });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message identity', () => {
  it('round-trips a folder and UID, colons in the path included', () => {
    const id = messageId('Archives/2026:Q3', 91);
    expect(parseMessageId(id)).toStrictEqual({ folder: 'Archives/2026:Q3', uid: 91 });
  });

  it('rejects anything that is not folder:uid', () => {
    expect(parseMessageId('INBOX')).toBeNull();
    expect(parseMessageId(':5')).toBeNull();
    expect(parseMessageId('INBOX:abc')).toBeNull();
  });
});

describe('listFolders', () => {
  it('maps SPECIAL-USE onto folder roles', async () => {
    const connection = new FakeConnection({
      mailboxes: [
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', totalMessages: 2, unreadMessages: 1 },
        {
          path: 'Newsletters/Tech',
          name: 'Tech',
          specialUse: null,
          totalMessages: 9,
          unreadMessages: 0,
        },
      ],
    });
    const folders = await adapterOf(connection).listFolders();

    expect(folders.map((f) => [f.path, f.role])).toStrictEqual([
      ['INBOX', 'inbox'],
      ['Newsletters/Tech', null],
    ]);
  });
});

describe('queryChanges', () => {
  it('refuses a cursor issued by the other adapter', async () => {
    const adapter = adapterOf(new FakeConnection());
    await expect(
      adapter.queryChanges('INBOX', encodeCursor({ kind: 'jmap', sinceState: 's1' })),
    ).rejects.toThrow(/Not an IMAP cursor/);
  });

  it('reports new UIDs and advances the cursor past each one', async () => {
    const connection = new FakeConnection({
      status: { uidValidity: 7, uidNext: 13 },
      uids: [11, 12],
    });
    const changes = await adapterOf(connection).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'imap', uidValidity: 7, lastUid: 10 }),
    );

    expect(changes).toStrictEqual([
      { kind: 'created', id: 'INBOX:11', folder: 'INBOX', cursor: 'imap:7:11' },
      { kind: 'created', id: 'INBOX:12', folder: 'INBOX', cursor: 'imap:7:12' },
    ]);
  });

  it('drops a UID at or below the cursor even when the server returns it', async () => {
    const connection = new FakeConnection({ status: { uidValidity: 7, uidNext: 13 }, uids: [10, 11] });
    const changes = await adapterOf(connection).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'imap', uidValidity: 7, lastUid: 10 }),
    );

    expect(changes.map((c) => c.id)).toStrictEqual(['INBOX:11']);
  });

  it('resyncs the whole folder when UIDVALIDITY changed', async () => {
    const connection = new FakeConnection({
      status: { uidValidity: 99, uidNext: 4 },
      uids: [1, 2, 3],
    });
    const spy = vi.spyOn(connection, 'searchFrom');

    const changes = await adapterOf(connection).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'imap', uidValidity: 7, lastUid: 10 }),
    );

    expect(spy).toHaveBeenCalledWith('INBOX', 1);
    expect(changes.map((c) => c.id)).toStrictEqual(['INBOX:1', 'INBOX:2', 'INBOX:3']);
    expect(changes.at(-1)?.cursor).toBe('imap:99:3');
  });

  it('sorts UIDs so the last cursor is the highest one', async () => {
    const connection = new FakeConnection({ status: { uidValidity: 7, uidNext: 20 }, uids: [14, 12, 13] });
    const changes = await adapterOf(connection).queryChanges(
      'INBOX',
      encodeCursor({ kind: 'imap', uidValidity: 7, lastUid: 11 }),
    );

    expect(changes.map((c) => c.id)).toStrictEqual(['INBOX:12', 'INBOX:13', 'INBOX:14']);
    expect(changes.at(-1)?.cursor).toBe('imap:7:14');
  });
});

describe('getMessages', () => {
  it('reconstructs the thread root from References', async () => {
    const connection = new FakeConnection({
      fetched: [fetched({ headers: { References: '<root@example.org> <mid@example.org>' } })],
    });
    const [message] = await adapterOf(connection).getMessages(['INBOX:5']);

    expect(message?.threadId).toBe('root@example.org');
    expect(message?.references).toStrictEqual(['root@example.org', 'mid@example.org']);
  });

  it('falls back to In-Reply-To when there is no References chain', async () => {
    const [message] = await adapterOf(
      new FakeConnection({ fetched: [fetched()] }),
    ).getMessages(['INBOX:5']);

    expect(message?.threadId).toBe('parent@example.org');
  });

  it('makes a message its own thread root when it answers nothing', async () => {
    const connection = new FakeConnection({
      fetched: [fetched({ envelope: { ...fetched().envelope, inReplyTo: null } })],
    });
    const [message] = await adapterOf(connection).getMessages(['INBOX:5']);

    expect(message?.threadId).toBe('own@example.org');
  });

  it('collects x-spam headers case-insensitively', async () => {
    const connection = new FakeConnection({
      fetched: [fetched({ headers: { 'X-Spam-Score': '4.2', Subject: 'no' } })],
    });
    const [message] = await adapterOf(connection).getMessages(['INBOX:5']);

    expect(message?.spamHeaders).toStrictEqual({ 'x-spam-score': '4.2' });
  });

  it('splits every List-Unsubscribe target', async () => {
    const connection = new FakeConnection({
      fetched: [
        fetched({
          headers: { 'List-Unsubscribe': '<https://e.org/u>, <mailto:u@e.org>' },
        }),
      ],
    });
    const [message] = await adapterOf(connection).getMessages(['INBOX:5']);

    expect(message?.listUnsubscribe).toStrictEqual(['https://e.org/u', 'mailto:u@e.org']);
  });

  it('skips ids that are not IMAP message ids', async () => {
    const connection = new FakeConnection({ fetched: [fetched()] });
    expect(await adapterOf(connection).getMessages(['nonsense'])).toStrictEqual([]);
  });
});

describe('writes', () => {
  it('creates the destination before moving into it', async () => {
    const connection = new FakeConnection();
    await adapterOf(connection).moveMessage('INBOX:5', 'Newsletters/Promo');

    expect(connection.ensured).toStrictEqual(['Newsletters/Promo']);
    expect(connection.moved).toStrictEqual([
      { uid: 5, from: 'INBOX', to: 'Newsletters/Promo' },
    ]);
  });

  it('rejects an id the other adapter would have produced', async () => {
    await expect(adapterOf(new FakeConnection()).moveMessage('e1', 'Junk')).rejects.toThrow(
      /Not an IMAP message id/,
    );
  });

  it('does not issue an empty STORE', async () => {
    const connection = new FakeConnection();
    await adapterOf(connection).setKeywords('INBOX:5', []);
    expect(connection.flagged).toStrictEqual([]);
  });

  it('adds the flags the service already degraded for it', async () => {
    const connection = new FakeConnection();
    await adapterOf(connection).setKeywords('INBOX:5', ['\\Flagged']);
    expect(connection.flagged).toStrictEqual([{ uid: 5, flags: ['\\Flagged'] }]);
  });
});

describe('drafts and submission', () => {
  const DRAFT = {
    to: [{ name: null, email: 'someone@example.org' }],
    cc: [],
    subject: 'Re: hello',
    bodyText: 'Hi',
    inReplyTo: 'prev@example.org',
    references: ['root@example.org'],
  };

  it('appends the draft to Drafts with the Draft flag', async () => {
    const connection = new FakeConnection();
    const id = await adapterOf(connection).createDraft(DRAFT);

    expect(id).toBe('draft-1');
    expect(connection.appended).toStrictEqual([{ path: 'Drafts', flags: ['\\Draft'] }]);
  });

  it('sends over SMTP and files the copy in Sent, which IMAP does not do for us', async () => {
    const connection = new FakeConnection({ fetched: [fetched({ uid: 42 })] });
    const smtp = new FakeSmtp();
    const adapter = adapterOf(connection, smtp);

    const id = await adapter.createDraft(DRAFT);
    await adapter.submitDraft(id);

    expect(smtp.sent).toHaveLength(2);
    expect(connection.appended).toStrictEqual([
      { path: 'Drafts', flags: ['\\Draft'] },
      { path: 'Sent', flags: ['\\Seen'] },
    ]);
  });

  it('refuses an unknown draft', async () => {
    await expect(adapterOf(new FakeConnection()).submitDraft('draft-9')).rejects.toThrow(
      /No such draft/,
    );
  });

  it('refuses to send a draft that vanished from the mailbox', async () => {
    const connection = new FakeConnection({ fetched: [] });
    const adapter = adapterOf(connection);
    const id = await adapter.createDraft(DRAFT);

    await expect(adapter.submitDraft(id)).rejects.toThrow(/no longer in Drafts/);
  });

  it('forgets a draft once it has been sent', async () => {
    const connection = new FakeConnection({ fetched: [fetched({ uid: 42 })] });
    const adapter = adapterOf(connection);
    const id = await adapter.createDraft(DRAFT);

    await adapter.submitDraft(id);
    await expect(adapter.submitDraft(id)).rejects.toThrow(/No such draft/);
  });
});

describe('watchInbox', () => {
  /** Captures the re-IDLE timer instead of waiting 29 real minutes. */
  function controllableTimer(): {
    setTimer: (fn: () => void, ms: number) => () => void;
    fireLast: () => void;
    delays: number[];
  } {
    const pending: (() => void)[] = [];
    const delays: number[] = [];
    return {
      delays,
      setTimer: (fn, ms) => {
        delays.push(ms);
        pending.push(fn);
        return () => {
          const index = pending.indexOf(fn);
          if (index >= 0) pending.splice(index, 1);
        };
      },
      fireLast: () => {
        pending.pop()?.();
      },
    };
  }

  it('idles on the inbox', async () => {
    const connection = new FakeConnection();
    const timer = controllableTimer();
    const adapter = new ImapAdapter({ connection, smtp: new FakeSmtp(), setTimer: timer.setTimer });

    const subscription = adapter.watchInbox(() => undefined);
    await vi.waitFor(() => {
      expect(connection.idled).toStrictEqual(['INBOX']);
    });
    await subscription[Symbol.asyncDispose]();
  });

  it('re-issues IDLE inside the RFC 2177 window', async () => {
    const connection = new FakeConnection();
    const timer = controllableTimer();
    const adapter = new ImapAdapter({ connection, smtp: new FakeSmtp(), setTimer: timer.setTimer });

    const subscription = adapter.watchInbox(() => undefined);
    await vi.waitFor(() => {
      expect(connection.idled).toHaveLength(1);
    });

    expect(timer.delays[0]).toBe(RE_IDLE_INTERVAL_MS);
    expect(RE_IDLE_INTERVAL_MS).toBeLessThan(30 * 60 * 1000);

    timer.fireLast();
    await vi.waitFor(() => {
      expect(connection.idled).toHaveLength(2);
    });

    await subscription[Symbol.asyncDispose]();
  });

  it('turns an untagged update into a change on the handler', async () => {
    const connection = new FakeConnection({ status: { uidValidity: 7, uidNext: 11 }, uids: [11] });
    connection.onIdle = (notify) => {
      setTimeout(notify, 0);
    };
    const timer = controllableTimer();
    const adapter = new ImapAdapter({ connection, smtp: new FakeSmtp(), setTimer: timer.setTimer });

    const seen: string[] = [];
    const subscription = adapter.watchInbox((change) => seen.push(change.id));
    await vi.waitFor(() => {
      expect(seen).toStrictEqual(['INBOX:11']);
    });

    await subscription[Symbol.asyncDispose]();
  });

  it('stops the loop when the subscription is disposed', async () => {
    const connection = new FakeConnection();
    const timer = controllableTimer();
    const adapter = new ImapAdapter({ connection, smtp: new FakeSmtp(), setTimer: timer.setTimer });

    const subscription = adapter.watchInbox(() => undefined);
    await vi.waitFor(() => {
      expect(connection.idled).toHaveLength(1);
    });

    await subscription[Symbol.asyncDispose]();
    const idledAtDisposal = connection.idled.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connection.idled).toHaveLength(idledAtDisposal);
  });
});
