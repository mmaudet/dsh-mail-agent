/**
 * The IMAP and SMTP wire clients against real servers.
 *
 * These are the tests the fakes could not be: every method here was written
 * against an interface, and until this file ran, none of them had spoken to a
 * server. The destructive half runs on a throwaway Dovecot, never on anything
 * that holds real mail.
 *
 * A second, read-only block runs against the account this project targets when
 * `MAIL_SENTINEL_IMAP_PASSWORD` is set. It exists because a container is not a
 * production mailbox: it has three folders where the real one has 418, and a
 * hierarchy separator that differs.
 *
 *   bash test/integration/provision.sh
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ImapFlowConnection, NodemailerSender } from './imap-client.js';

const DOVECOT = {
  host: process.env['ITEST_DOVECOT_HOST'] ?? 'localhost',
  port: Number(process.env['ITEST_DOVECOT_PORT'] ?? 11143),
  secure: false,
  user: process.env['ITEST_USER'] ?? 'itest@example.test',
  password: process.env['ITEST_PASSWORD'] ?? 'itest-secret',
} as const;

const JAMES_SMTP = {
  host: process.env['ITEST_JAMES_HOST'] ?? 'localhost',
  port: Number(process.env['ITEST_JAMES_SMTP_PORT'] ?? 10587),
  secure: false,
  user: process.env['ITEST_USER'] ?? 'itest@example.test',
  password: process.env['ITEST_PASSWORD'] ?? 'itest-secret',
} as const;

/** A distinct name per run, so a failed run never poisons the next. */
const SUFFIX = `${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`;
const WORK = `dsh-itest-${SUFFIX}`;
const ARCHIVE = `dsh-itest-archive-${SUFFIX}`;

function rfc5322(subject: string, body: string): string {
  return [
    'From: Integration Test <itest@example.test>',
    'To: Integration Test <itest@example.test>',
    `Subject: ${subject}`,
    `Message-ID: <${subject}.${SUFFIX}@example.test>`,
    'Date: Thu, 29 Aug 2026 12:00:00 +0200',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

describe('ImapFlowConnection against Dovecot', () => {
  let imap: ImapFlowConnection;

  beforeAll(async () => {
    imap = new ImapFlowConnection(DOVECOT);
    // Fails loudly here rather than once per test if nothing is listening.
    await imap.open('INBOX');
  });

  afterAll(async () => {
    await imap.close();
  });

  it('opens a mailbox and reports a usable cursor origin', async () => {
    const status = await imap.open('INBOX');

    // UIDVALIDITY is the half of the IMAP cursor that invalidates it; a zero
    // or NaN here would make every resume look like a reset.
    expect(Number.isFinite(status.uidValidity)).toBe(true);
    expect(status.uidValidity).toBeGreaterThan(0);
    expect(status.uidNext).toBeGreaterThan(0);
  });

  it('creates a mailbox, and creating it again is not an error', async () => {
    await imap.ensureMailbox(WORK);
    // The second call is the one that matters: the adapter calls this on every
    // move to a category folder, so a throw on the existing case would break
    // every run after the first.
    await imap.ensureMailbox(WORK);

    const boxes = await imap.listMailboxes();
    expect(boxes.map((b) => b.path)).toContain(WORK);
  });

  it('appends a message and finds it by uid', async () => {
    await imap.ensureMailbox(WORK);
    const uid = await imap.append(WORK, rfc5322('appended', 'hello from the append test'), []);

    // Dovecot advertises UIDPLUS, so it reports the assigned UID. The port
    // allows null for servers that do not, and the adapter handles that.
    expect(uid).not.toBeNull();

    const found = await imap.searchFrom(WORK, 1);
    expect(found).toContain(uid);
  });

  it('fetches an envelope, headers and a body it can read back', async () => {
    await imap.ensureMailbox(WORK);
    const subject = `fetched-${SUFFIX}`;
    const uid = await imap.append(WORK, rfc5322(subject, 'the body under test'), []);
    expect(uid).not.toBeNull();

    const [message] = await imap.fetchByUid(WORK, [uid ?? 0]);
    expect(message).toBeDefined();
    expect(message?.envelope.subject).toBe(subject);
    expect(message?.envelope.from[0]?.email).toBe('itest@example.test');
    expect(message?.envelope.messageId).toContain(subject);
    expect(message?.bodyText).toContain('the body under test');
    expect(message?.hasAttachments).toBe(false);
    // internalDate must be a Date: the library types it as string-or-Date and
    // the port promises one, which is a conversion easy to get wrong.
    expect(message?.internalDate).toBeInstanceOf(Date);
    expect(Number.isNaN(message?.internalDate.getTime())).toBe(false);
  });

  it('adds a flag that survives a refetch', async () => {
    await imap.ensureMailbox(WORK);
    const uid = await imap.append(WORK, rfc5322(`flagged-${SUFFIX}`, 'flag me'), []);
    expect(uid).not.toBeNull();

    await imap.addFlagsByUid(WORK, uid ?? 0, ['\\Flagged']);

    const [message] = await imap.fetchByUid(WORK, [uid ?? 0]);
    expect(message?.flags).toContain('\\Flagged');
  });

  it('moves a message out of one mailbox and into another', async () => {
    await imap.ensureMailbox(WORK);
    await imap.ensureMailbox(ARCHIVE);
    const subject = `moved-${SUFFIX}`;
    const uid = await imap.append(WORK, rfc5322(subject, 'move me'), []);
    expect(uid).not.toBeNull();

    await imap.moveByUid(WORK, uid ?? 0, ARCHIVE);

    // MOVE expunges from the source. The UID in the target is a new one, so
    // the message is identified by its subject rather than by uid.
    const remaining = await imap.fetchByUid(WORK, [uid ?? 0]);
    expect(remaining).toEqual([]);

    const arrivedUids = await imap.searchFrom(ARCHIVE, 1);
    const arrived = await imap.fetchByUid(ARCHIVE, arrivedUids);
    expect(arrived.map((m) => m.envelope.subject)).toContain(subject);
  });

  it('returns from idle when the caller aborts, without waiting out the server', async () => {
    await imap.ensureMailbox(WORK);
    const controller = new AbortController();
    let fired = 0;

    const idling = imap.idle(WORK, controller.signal, () => {
      fired += 1;
    });

    // The point is the abort path: RFC 2177 lets a server hold the command for
    // 30 minutes, and a shutdown cannot wait for that.
    setTimeout(() => {
      controller.abort();
    }, 1500);

    const started = Date.now();
    await idling;
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(fired).toBeGreaterThanOrEqual(0);
  });
});

describe('NodemailerSender against James', () => {
  it('submits a message and reports the Message-ID and the bytes it sent', async () => {
    const smtp = new NodemailerSender({
      ...JAMES_SMTP,
      from: { name: 'Integration Test', email: 'itest@example.test' },
    });

    try {
      const sent = await smtp.send({
        to: [{ name: null, email: 'itest@example.test' }],
        cc: [],
        subject: `submitted-${SUFFIX}`,
        bodyText: 'submitted by the integration suite',
        inReplyTo: null,
        references: [],
      });

      expect(sent.messageId).toMatch(/^<.+>$/);
      // The adapter writes these bytes back to Sent, so an empty string here
      // would silently produce an empty copy of every sent message.
      expect(sent.raw).toContain(`submitted-${SUFFIX}`);
      expect(sent.raw).toContain('submitted by the integration suite');
    } finally {
      smtp.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The real account: read-only, and skipped unless a password is provisioned.
// ---------------------------------------------------------------------------

const realPassword = process.env['MAIL_SENTINEL_IMAP_PASSWORD'];

describe.skipIf(realPassword === undefined || realPassword.length === 0)(
  'ImapFlowConnection against the production account (read-only)',
  () => {
    let imap: ImapFlowConnection;

    beforeAll(() => {
      imap = new ImapFlowConnection({
        host: process.env['MAIL_SENTINEL_IMAP_HOST'] ?? 'imap.linagora.com',
        port: 993,
        secure: true,
        user: process.env['MAIL_SENTINEL_IMAP_USER'] ?? 'mmaudet@linagora.com',
        password: realPassword,
      });
    });

    afterAll(async () => {
      await imap.close();
    });

    it('lists a real folder tree without a per-mailbox round trip', async () => {
      const started = Date.now();
      const boxes = await imap.listMailboxes();
      const elapsed = Date.now() - started;

      // The container has three folders; this account has several hundred. A
      // STATUS per mailbox would turn a listing into minutes, which is why
      // listMailboxes reports zero counts and leaves them to open().
      expect(boxes.length).toBeGreaterThan(50);
      expect(elapsed).toBeLessThan(30_000);
      expect(boxes.map((b) => b.path)).toContain('INBOX');
    });

    it('opens the inbox and reports its real cursor origin', async () => {
      const status = await imap.open('INBOX');
      expect(status.uidValidity).toBeGreaterThan(0);
      expect(status.uidNext).toBeGreaterThan(1);
    });

    it('finds a special-use folder, which is how roles are resolved', async () => {
      const boxes = await imap.listMailboxes();
      const special = boxes.filter((b) => b.specialUse !== null);
      // Without SPECIAL-USE the adapter has to guess Sent and Drafts by name,
      // which is locale-dependent and wrong more often than not.
      expect(special.length).toBeGreaterThan(0);
    });
  },
);
