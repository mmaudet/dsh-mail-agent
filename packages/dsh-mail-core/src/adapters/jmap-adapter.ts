/**
 * JMAP adapter (RFC 8620 core, RFC 8621 mail).
 *
 * The HTTP transport is injected rather than built here: unit tests supply
 * recorded responses, and a later phase can swap in a client with retries or
 * connection pooling without touching the protocol logic.
 *
 * Every value coming back from a server is `unknown` until a guard proves
 * otherwise. A JMAP response is remote input, not a typed API.
 */

import type { MailService } from '../mail-service.js';
import {
  decodeCursor,
  encodeCursor,
  listIdOf,
  type Capabilities,
  type DraftMessage,
  type FolderRole,
  type MailAddress,
  type MailChange,
  type MailFolder,
  type MailMessage,
} from '../types.js';

// ---------------------------------------------------------------------------
// Wire vocabulary
// ---------------------------------------------------------------------------

export const JMAP_CORE = 'urn:ietf:params:jmap:core';

/**
 * How many changes one `Email/changes` may report.
 *
 * The server answers `hasMoreChanges` when it truncates, and the cursor each
 * change carries points just past it, so a caller that persists the last one
 * resumes exactly where this batch stopped. Bounded rather than looped here: a
 * poll that has fallen a week behind should return control, not block until it
 * has drained a mailbox.
 */
const MAX_CHANGES = 256;

/**
 * How many messages one `Email/get` asks for.
 *
 * Not a count limit — James advertises `maxObjectsInGet: 500` — but a size
 * one: full bodies and headers for 200 messages answered `requestTooLarge`.
 * Fifty keeps a batch well under it while staying one round trip for an
 * ordinary poll.
 */
const GET_BATCH = 50;
export const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
export const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';

export type JmapMethodCall = readonly [
  name: string,
  args: Readonly<Record<string, unknown>>,
  callId: string,
];

export interface JmapRequest {
  readonly using: readonly string[];
  readonly methodCalls: readonly JmapMethodCall[];
}

/** Posts a JMAP request to the account's `apiUrl` and returns parsed JSON. */
export interface JmapTransport {
  request(body: JmapRequest): Promise<unknown>;
}

/**
 * A push channel over the account's `eventSourceUrl` (RFC 8620 section 7.3).
 *
 * A `StateChange` says only that something moved; the adapter answers it with
 * a delta poll, which is what the specification intends.
 */
export interface JmapPushChannel {
  subscribe(onStateChange: () => void): AsyncDisposable;
}

export interface JmapAdapterOptions {
  readonly transport: JmapTransport;
  readonly accountId: string;
  /** Identity used as the envelope sender by `EmailSubmission/set`. */
  readonly identityId: string;
  readonly push?: JmapPushChannel | undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class JmapAdapter implements MailService {
  readonly capabilities: Capabilities = {
    push: 'jmap-push-subscription',
    customKeywords: true,
    threadNative: true,
    spamHeaders: true,
    // RFC 8620: an `Email` id is assigned on creation and survives every
    // change of mailbox, so a filed message can be found again.
    stableIds: true,
  };

  readonly #transport: JmapTransport;
  readonly #accountId: string;
  readonly #identityId: string;
  readonly #push: JmapPushChannel | undefined;
  /** Folder path to id, refreshed by every `listFolders` call. */
  #folderIds = new Map<string, string>();

  constructor(options: JmapAdapterOptions) {
    this.#transport = options.transport;
    this.#accountId = options.accountId;
    this.#identityId = options.identityId;
    this.#push = options.push;
  }

  async listFolders(): Promise<MailFolder[]> {
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      ['Mailbox/get', { accountId: this.#accountId, ids: null }, 'f0'],
    );
    const list = asArray(readProp(response, 'list'));

    const raw = list.map(toRawMailbox).filter(isNotNull);
    const byId = new Map(raw.map((mailbox) => [mailbox.id, mailbox]));

    const folders = raw.map((mailbox) => ({
      id: mailbox.id,
      name: mailbox.name,
      path: mailboxPath(mailbox, byId),
      role: toFolderRole(mailbox.role),
      totalMessages: mailbox.totalEmails,
      unreadMessages: mailbox.unreadEmails,
    }));

    this.#folderIds = new Map(folders.map((folder) => [folder.path, folder.id]));
    return folders;
  }

  /**
   * Delta poll for one folder.
   *
   * `Email/queryChanges` tracks membership of a filtered query, so it reports
   * a message entering or leaving the folder. It cannot report an in-place
   * change such as a flag edit: that is a property of the message, not of the
   * query. Consumers that need flag changes on JMAP watch the push channel,
   * which fires on any state change.
   */
  /**
   * Where the folder stands now, with none of its contents.
   *
   * `Email/get` with no ids answers with the account's mail state and nothing
   * else — the state `Email/changes` counts from. It is account-wide, so the
   * same cursor serves every folder; the argument is kept because the contract
   * is per-folder and IMAP's cursor genuinely is.
   */
  async currentCursor(folder: string): Promise<string> {
    void folder;
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      ['Email/get', { accountId: this.#accountId, ids: [], properties: ['id'] }, 'q0'],
    );

    const state = asString(readProp(response, 'state'));
    // Inventing a state would silently make the first poll re-read the account
    // or skip it entirely, and neither failure announces itself.
    if (state === null) throw new TypeError('Email/get returned no state');
    return encodeCursor({ kind: 'jmap', sinceState: state });
  }

  async queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]> {
    const cursor = decodeCursor(sinceCursor);
    if (cursor === null || cursor.kind !== 'jmap') {
      throw new TypeError(`Not a JMAP cursor: ${sinceCursor}`);
    }

    const folderId = await this.#folderId(folder);
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/changes',
        {
          accountId: this.#accountId,
          sinceState: cursor.sinceState,
          maxChanges: MAX_CHANGES,
        },
        'q0',
      ],
    );

    const newState = asString(readProp(response, 'newState'));
    if (newState === null) throw new TypeError('Email/changes returned no newState');
    const next = encodeCursor({ kind: 'jmap', sinceState: newState });

    const created = idsOf(readProp(response, 'created'));
    const updated = idsOf(readProp(response, 'updated'));
    const destroyed = idsOf(readProp(response, 'destroyed'));

    // `Email/changes` is account-wide: it reports what changed, not where it
    // lives. One lookup routes the survivors to their folders.
    const live = [...created, ...updated];
    const mailboxes = live.length === 0 ? new Map<string, Set<string>>() : await this.#mailboxesOf(live);

    const changes: MailChange[] = [];
    for (const id of destroyed) {
      // A destroyed message has no mailboxIds left to read, so it cannot be
      // attributed to a folder. It is reported to the caller that asked,
      // which is the one holding the id and able to recognise it.
      changes.push({ kind: 'destroyed', id, folder, cursor: next });
    }
    for (const id of created) {
      if (mailboxes.get(id)?.has(folderId) === true) {
        changes.push({ kind: 'created', id, folder, cursor: next });
      }
    }
    for (const id of updated) {
      if (mailboxes.get(id)?.has(folderId) === true) {
        // Flag edits arrive here. `Email/queryChanges`, which the PRD names,
        // cannot report them at all: it tracks membership of a query, and a
        // keyword change does not move a message in or out of one.
        changes.push({ kind: 'updated', id, folder, cursor: next });
      }
    }
    return changes;
  }

  /** Which folders each of these messages is in now, by id. */
  async locate(ids: readonly string[]): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const [byId, folders] = await Promise.all([this.#mailboxesOf(ids), this.listFolders()]);
    // Keyed on path rather than leaf name: two folders can share a name —
    // `Newsletters/Tech` and `Archives/Tech` — and a caller comparing against
    // what it filed needs the same string it was given.
    const pathOf = new Map(folders.map((f) => [f.id, f.path]));

    const out = new Map<string, string[]>();
    for (const [id, mailboxIds] of byId) {
      const paths: string[] = [];
      for (const m of mailboxIds) {
        const path = pathOf.get(m);
        if (path !== undefined) paths.push(path);
      }
      out.set(id, paths);
    }
    return out;
  }

  /** Which mailboxes each of these messages is in, in one round trip. */
  async #mailboxesOf(ids: readonly string[]): Promise<Map<string, Set<string>>> {
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/get',
        { accountId: this.#accountId, ids: [...ids], properties: ['id', 'mailboxIds'] },
        'q0',
      ],
    );

    const out = new Map<string, Set<string>>();
    for (const entry of asArray(readProp(response, 'list'))) {
      const id = asString(readProp(entry, 'id'));
      if (id === null) continue;
      const map = readProp(entry, 'mailboxIds');
      const folders = new Set<string>();
      if (typeof map === 'object' && map !== null) {
        for (const key of Object.keys(map)) folders.add(key);
      }
      out.set(id, folders);
    }
    return out;
  }

  async getMessages(ids: string[]): Promise<MailMessage[]> {
    if (ids.length === 0) return [];

    const folders = await this.#pathsById();
    const messages: MailMessage[] = [];

    // Batched, because a whole message is a large object and a server answers
    // `requestTooLarge` long before it reaches its own `maxObjectsInGet`.
    // Doing it here rather than in every caller: a batch limit is a property
    // of the wire, and the contract promises a list for a list.
    for (let from = 0; from < ids.length; from += GET_BATCH) {
      const response = await this.#call(
        [JMAP_CORE, JMAP_MAIL],
        [
          'Email/get',
          {
            accountId: this.#accountId,
            ids: ids.slice(from, from + GET_BATCH),
            properties: EMAIL_PROPERTIES,
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
          'g0',
        ],
      );
      for (const entry of asArray(readProp(response, 'list'))) {
        const message = toMailMessage(entry, folders);
        if (message !== null) messages.push(message);
      }
    }
    return messages;
  }

  watchInbox(handler: (evt: MailChange) => void): AsyncDisposable {
    const push = this.#push;
    if (push === undefined) {
      throw new TypeError('This adapter was built without a push channel');
    }

    let cursor: string | null = null;
    let draining = false;

    const drain = (): void => {
      if (draining) return;
      draining = true;
      void (async () => {
        try {
          cursor ??= await this.#inboxCursor();
          const changes = await this.queryChanges('INBOX', cursor);
          for (const change of changes) {
            cursor = change.cursor;
            handler(change);
          }
        } catch {
          // A failed drain must not tear down the subscription: the next
          // StateChange retries from the same cursor, so nothing is skipped.
        } finally {
          draining = false;
        }
      })();
    };

    return push.subscribe(drain);
  }

  async moveMessage(id: string, targetFolder: string): Promise<void> {
    const folderId = await this.#folderId(targetFolder);
    await this.#update(id, { mailboxIds: { [folderId]: true } });
  }

  async setKeywords(id: string, keywords: string[]): Promise<void> {
    const map: Record<string, boolean> = {};
    for (const keyword of keywords) map[keyword.toLowerCase()] = true;
    await this.#update(id, { keywords: map });
  }

  async createDraft(msg: DraftMessage): Promise<string> {
    const draftsId = await this.#folderId('Drafts');
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/set',
        {
          accountId: this.#accountId,
          create: {
            draft: {
              mailboxIds: { [draftsId]: true },
              keywords: { $draft: true },
              to: msg.to.map(toWireAddress),
              cc: msg.cc.map(toWireAddress),
              subject: msg.subject,
              inReplyTo: msg.inReplyTo === null ? null : [msg.inReplyTo],
              references: msg.references.length > 0 ? [...msg.references] : null,
              bodyStructure: { type: 'text/plain', partId: 'body' },
              bodyValues: { body: { value: msg.bodyText } },
            },
          },
        },
        'd0',
      ],
    );

    const id = asString(readProp(readProp(readProp(response, 'created'), 'draft'), 'id'));
    if (id === null) throw new TypeError(`Draft was not created: ${describeSetError(response)}`);
    return id;
  }

  /**
   * Queues the draft for sending.
   *
   * The harness approval policy gates the tool that reaches this method; the
   * adapter itself performs the submission it is asked for.
   */
  async submitDraft(draftId: string): Promise<void> {
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION],
      [
        'EmailSubmission/set',
        {
          accountId: this.#accountId,
          create: {
            submission: { emailId: draftId, identityId: this.#identityId },
          },
          onSuccessUpdateEmail: {
            '#submission': { 'keywords/$draft': null, 'keywords/$seen': true },
          },
        },
        's0',
      ],
    );

    const created = readProp(readProp(response, 'created'), 'submission');
    if (created === undefined) {
      throw new TypeError(`Submission was rejected: ${describeSetError(response)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #call(using: readonly string[], call: JmapMethodCall): Promise<unknown> {
    const body = await this.#transport.request({ using, methodCalls: [call] });
    const responses = asArray(readProp(body, 'methodResponses'));
    const first = responses[0];
    if (first === undefined) throw new TypeError('JMAP response carried no methodResponses');

    const [name, args] = asArray(first);
    if (asString(name) === 'error') {
      throw new TypeError(`JMAP method error: ${asString(readProp(args, 'type')) ?? 'unknown'}`);
    }
    return args;
  }

  async #update(id: string, patch: Readonly<Record<string, unknown>>): Promise<void> {
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      ['Email/set', { accountId: this.#accountId, update: { [id]: patch } }, 'u0'],
    );
    const notUpdated = readProp(readProp(response, 'notUpdated'), id);
    if (notUpdated !== undefined) {
      throw new TypeError(
        `Email/set rejected ${id}: ${asString(readProp(notUpdated, 'type')) ?? 'unknown'}`,
      );
    }
  }

  async #folderId(path: string): Promise<string> {
    const known = this.#folderIds.get(path);
    if (known !== undefined) return known;

    await this.listFolders();
    const resolved = this.#folderIds.get(path);
    if (resolved === undefined) throw new TypeError(`No such folder: ${path}`);
    return resolved;
  }

  async #pathsById(): Promise<ReadonlyMap<string, string>> {
    if (this.#folderIds.size === 0) await this.listFolders();
    return new Map([...this.#folderIds].map(([path, id]) => [id, path]));
  }

  /**
   * The inbox position `watchInbox` starts from.
   *
   * Was a second copy of the same query, carrying the same `limit: 0` James
   * rejects — so watching the inbox would have failed on a real server while
   * every unit test passed. One implementation now, and the public one.
   */
  #inboxCursor(): Promise<string> {
    return this.currentCursor('INBOX');
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const EMAIL_PROPERTIES: readonly string[] = [
  'id',
  'threadId',
  'mailboxIds',
  'keywords',
  'messageId',
  'inReplyTo',
  'references',
  'from',
  'to',
  'cc',
  'subject',
  'receivedAt',
  'sentAt',
  'preview',
  'hasAttachment',
  'bodyValues',
  'textBody',
  'htmlBody',
  'header:list-unsubscribe:asText',
  // Every header, because the ones the cascade needs cannot be named in
  // advance: `x-spam-*` varies by filter, and authentication results arrive as
  // RFC 8601 `Authentication-Results` on one server and as `x-spam-dmarc` on
  // another. JMAP returns only what is asked for, and asking for a fixed list
  // is how nodes 2 and 5 came to see nothing at all on a live account.
  'headers',
];

interface RawMailbox {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly role: string | null;
  readonly totalEmails: number;
  readonly unreadEmails: number;
}

function toRawMailbox(value: unknown): RawMailbox | null {
  const id = asString(readProp(value, 'id'));
  const name = asString(readProp(value, 'name'));
  if (id === null || name === null) return null;
  return {
    id,
    name,
    parentId: asString(readProp(value, 'parentId')),
    role: asString(readProp(value, 'role')),
    totalEmails: asNumber(readProp(value, 'totalEmails')) ?? 0,
    unreadEmails: asNumber(readProp(value, 'unreadEmails')) ?? 0,
  };
}

/** Walk `parentId` to build `Newsletters/Tech` from a nested mailbox. */
function mailboxPath(mailbox: RawMailbox, byId: ReadonlyMap<string, RawMailbox>): string {
  const segments = [mailbox.name];
  const seen = new Set([mailbox.id]);

  let parentId = mailbox.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    segments.unshift(parent.name);
    parentId = parent.parentId;
  }
  return segments.join('/');
}

const FOLDER_ROLES: readonly FolderRole[] = [
  'inbox',
  'sent',
  'drafts',
  'junk',
  'trash',
  'archive',
];

function toFolderRole(raw: string | null): FolderRole {
  if (raw === null) return null;
  const lowered = raw.toLowerCase();
  return (FOLDER_ROLES as readonly (string | null)[]).includes(lowered)
    ? (lowered as FolderRole) // SAFETY: membership confirmed above
    : null;
}

function toMailMessage(value: unknown, folders: ReadonlyMap<string, string>): MailMessage | null {
  const id = asString(readProp(value, 'id'));
  const receivedAt = asDate(readProp(value, 'receivedAt'));
  if (id === null || receivedAt === null) return null;

  const mailboxIds = readProp(value, 'mailboxIds');
  const folder = firstFolderPath(mailboxIds, folders);
  const bodyValues = readProp(value, 'bodyValues');

  return {
    id,
    threadId: asString(readProp(value, 'threadId')),
    messageId: firstString(readProp(value, 'messageId')),
    inReplyTo: stringList(readProp(value, 'inReplyTo')),
    references: stringList(readProp(value, 'references')),
    from: addressList(readProp(value, 'from')),
    to: addressList(readProp(value, 'to')),
    cc: addressList(readProp(value, 'cc')),
    subject: asString(readProp(value, 'subject')) ?? '',
    receivedAt,
    sentAt: asDate(readProp(value, 'sentAt')),
    keywords: Object.keys(asRecord(readProp(value, 'keywords')) ?? {}),
    folder,
    preview: asString(readProp(value, 'preview')) ?? '',
    bodyText: bodyPart(bodyValues, readProp(value, 'textBody')),
    bodyHtml: bodyPart(bodyValues, readProp(value, 'htmlBody')),
    hasAttachments: readProp(value, 'hasAttachment') === true,
    spamHeaders: spamHeaders(value),
    listUnsubscribe: unsubscribeTargets(readProp(value, 'header:list-unsubscribe:asText')),
    listId: listIdOf(headerNamed(value, 'list-id')),
  };
}

function firstFolderPath(
  mailboxIds: unknown,
  folders: ReadonlyMap<string, string>,
): string {
  for (const id of Object.keys(asRecord(mailboxIds) ?? {})) {
    const path = folders.get(id);
    if (path !== undefined) return path;
  }
  return '';
}

function bodyPart(bodyValues: unknown, parts: unknown): string | null {
  const first = asArray(parts)[0];
  const partId = asString(readProp(first, 'partId'));
  if (partId === null) return null;
  return asString(readProp(readProp(bodyValues, partId), 'value'));
}

/**
 * The headers the cascade reasons about, keyed lowercase.
 *
 * `headers` is RFC 8621's list of every header as `{name, value}`. Anything
 * matching `x-spam-*` is kept, and `authentication-results` with it: that is
 * where SPF, DKIM and DMARC actually live on a standards-compliant server,
 * whatever a spam filter also chooses to stamp.
 */
function spamHeaders(value: unknown): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};

  for (const entry of asArray(readProp(value, 'headers'))) {
    const name = asString(readProp(entry, 'name'))?.toLowerCase();
    const text = asString(readProp(entry, 'value'));
    if (name === undefined || text === null) continue;
    // `x-spam-*` is the convention the PRD assumes, and the account this
    // project targets uses none of it: James stamps
    // `org.apache.james.rspamd.status` instead. Both are kept, and
    // `authentication-results` with them — but not `ARC-` or `X-MS-Exchange-`
    // prefixed variants, which assert something about a previous hop rather
    // than about this delivery.
    if (/^x-spam-/.test(name) || /\.rspamd\./.test(name) || name === 'authentication-results') {
      // A header may repeat; the last one wins, which is what a reader of the
      // message sees too.
      headers[name] = text.trim();
    }
  }

  // Servers that answer a named header property rather than the list.
  const record = asRecord(value);
  if (record !== null) {
    for (const [key, raw] of Object.entries(record)) {
      const match = /^header:(x-spam-[^:]+)/i.exec(key);
      const text = asString(raw);
      if (match?.[1] !== undefined && text !== null) headers[match[1].toLowerCase()] = text.trim();
    }
  }
  return headers;
}

/** One header by name, from the list the adapter asks for, or `null`. */
function headerNamed(value: unknown, name: string): string | null {
  for (const entry of asArray(readProp(value, 'headers'))) {
    if (asString(readProp(entry, 'name'))?.toLowerCase() === name) {
      return asString(readProp(entry, 'value'));
    }
  }
  return null;
}

/** Split a `List-Unsubscribe` header into its bracketed targets (RFC 2369). */
function unsubscribeTargets(value: unknown): readonly string[] {
  const raw = asString(value);
  if (raw === null) return [];
  return [...raw.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined);
}

function addressList(value: unknown): readonly MailAddress[] {
  return asArray(value)
    .map((entry): MailAddress | null => {
      const email = asString(readProp(entry, 'email'));
      return email === null ? null : { name: asString(readProp(entry, 'name')), email };
    })
    .filter(isNotNull);
}

function toWireAddress(address: MailAddress): Record<string, unknown> {
  return { name: address.name, email: address.email };
}

function describeSetError(response: unknown): string {
  const notCreated = asRecord(readProp(response, 'notCreated'));
  if (notCreated === null) return 'no reason given';
  const first = Object.values(notCreated)[0];
  return asString(readProp(first, 'type')) ?? 'no reason given';
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function readProp(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The ids in a `created`/`updated`/`destroyed` array, dropping anything else. */
function idsOf(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const id = asString(entry);
    if (id !== null) out.push(id);
  }
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): Date | null {
  const raw = asString(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstString(value: unknown): string | null {
  return asString(value) ?? asString(asArray(value)[0]);
}

function stringList(value: unknown): readonly string[] {
  return asArray(value)
    .map(asString)
    .filter(isNotNull);
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}
