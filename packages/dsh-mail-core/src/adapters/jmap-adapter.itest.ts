/**
 * JmapAdapter against a real Apache James.
 *
 * The unit suite proves the adapter's reasoning against a fake transport. This
 * proves the reasoning survives a server: that the method names, argument
 * shapes and response shapes it assumes are the ones James actually speaks.
 * Those are exactly the assumptions a mock cannot falsify, and three of the
 * four models benchmarked on this package got one of them wrong.
 *
 * The transport here speaks Basic, because that is what James's memory server
 * accepts. The production transport speaks Bearer and is covered by a live
 * call against the real account; keeping them apart avoids widening production
 * code for a test's convenience.
 *
 *   bash test/integration/provision.sh
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { decodeCursor } from '../types.js';
import { JmapAdapter, type JmapRequest, type JmapTransport } from './jmap-adapter.js';

const SESSION_URL = process.env['ITEST_JMAP_SESSION'] ?? 'http://localhost:18080/jmap/session';
const USER = process.env['ITEST_USER'] ?? 'itest@example.test';
const PASSWORD = process.env['ITEST_PASSWORD'] ?? 'itest-secret';

const basic = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

/** The same discovery the production transport performs, with Basic auth. */
function createBasicTransport(): JmapTransport {
  let apiUrl: string | null = null;

  return {
    async request(body: JmapRequest): Promise<unknown> {
      if (apiUrl === null) {
        const session = await fetch(SESSION_URL, {
          headers: { accept: 'application/json', authorization: basic },
        });
        if (!session.ok) throw new Error(`JMAP session fetch returned ${String(session.status)}`);
        const parsed = (await session.json()) as { apiUrl?: unknown };
        if (typeof parsed.apiUrl !== 'string') throw new TypeError('session carries no apiUrl');
        // James answers `http://localhost/jmap`: its own address inside the
        // container, port 80. Followed verbatim from the host that reaches
        // whatever else is listening there — which on this machine answered
        // TLS. Behind a port mapping or a proxy the discovered origin is not
        // the client's, so only the path is kept.
        apiUrl = new URL(new URL(parsed.apiUrl).pathname, SESSION_URL).toString();
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: basic,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`JMAP request failed: HTTP ${String(response.status)}`);
      return response.json();
    },
  };
}

async function resolveAccountId(): Promise<string> {
  const session = await fetch(SESSION_URL, {
    headers: { accept: 'application/json', authorization: basic },
  });
  if (!session.ok) {
    throw new Error(
      `No JMAP server at ${SESSION_URL} (HTTP ${String(session.status)}). ` +
        'Run: bash test/integration/provision.sh',
    );
  }
  const parsed = (await session.json()) as {
    primaryAccounts?: Record<string, string>;
    accounts?: Record<string, unknown>;
  };
  const primary = parsed.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (typeof primary === 'string') return primary;
  const first = Object.keys(parsed.accounts ?? {})[0];
  if (first === undefined) throw new Error('session lists no accounts');
  return first;
}

describe('JmapAdapter against Apache James', () => {
  let adapter: JmapAdapter;

  beforeAll(async () => {
    const accountId = await resolveAccountId();
    adapter = new JmapAdapter({
      transport: createBasicTransport(),
      accountId,
      // Submission is not exercised here: it would put mail on the wire.
      identityId: 'unused-in-these-tests',
    });
  });

  it('discovers the session and lists the account mailboxes', async () => {
    const folders = await adapter.listFolders();

    expect(folders.length).toBeGreaterThan(0);
    // Every JMAP account has an inbox, and the adapter is expected to have
    // read the role rather than matched on the name.
    const inbox = folders.find((f) => f.role === 'inbox');
    expect(inbox).toBeDefined();
    expect(inbox?.id).toMatch(/\S/);
  });

  it('reports capabilities the server actually advertises', () => {
    // James stores custom keywords; the degraded path exists for servers that
    // do not, and asserting this stops the fallback being taken silently.
    expect(adapter.capabilities.customKeywords).toBe(true);
  });

  it('refuses a cursor that is not its own rather than guessing a state', async () => {
    const folders = await adapter.listFolders();
    const inbox = folders.find((f) => f.role === 'inbox');
    expect(inbox).toBeDefined();

    // An IMAP cursor against a JMAP adapter is a configuration error, and
    // silently starting from zero would re-process a whole mailbox.
    await expect(adapter.queryChanges(inbox?.id ?? '', '')).rejects.toThrow(/Not a JMAP cursor/);
  });

  it('hands a first run a cursor the server accepts back', async () => {
    // The cold start, against a server rather than a fake. `limit: 0` is the
    // part a fake cannot check: a server that ignores it would answer with the
    // folder's contents, which on a real inbox is tens of thousands of ids.
    const folders = await adapter.listFolders();
    const inbox = folders.find((f) => f.role === 'inbox');
    expect(inbox).toBeDefined();

    const cursor = await adapter.currentCursor(inbox?.path ?? 'INBOX');
    expect(cursor.length).toBeGreaterThan(0);
    expect(decodeCursor(cursor)?.kind).toBe('jmap');
  });

  it('follows the delta from that cursor and finds nothing new behind it', async () => {
    // The round trip the fake cannot prove: a state this server minted, handed
    // back to the call that consumes it. This is where `Email/queryChanges`
    // answered `unknownMethod` on both the container and the production
    // deployment — see docs/upstream/james-email-querychanges.md.
    const folders = await adapter.listFolders();
    const inbox = folders.find((f) => f.role === 'inbox');
    const cursor = await adapter.currentCursor(inbox?.path ?? 'INBOX');

    await expect(adapter.queryChanges(inbox?.path ?? 'INBOX', cursor)).resolves.toEqual([]);
  });

  it('returns nothing rather than failing for ids that do not exist', async () => {
    const messages = await adapter.getMessages(['no-such-email-id']);
    expect(messages).toEqual([]);
  });
});
