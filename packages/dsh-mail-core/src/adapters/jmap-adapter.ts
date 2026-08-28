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
  async queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]> {
    const cursor = decodeCursor(sinceCursor);
    if (cursor === null || cursor.kind !== 'jmap') {
      throw new TypeError(`Not a JMAP cursor: ${sinceCursor}`);
    }

    const folderId = await this.#folderId(folder);
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/queryChanges',
        {
          accountId: this.#accountId,
          filter: { inMailbox: folderId },
          sinceQueryState: cursor.sinceState,
        },
        'q0',
      ],
    );

    const newState = asString(readProp(response, 'newQueryState'));
    if (newState === null) throw new TypeError('Email/queryChanges returned no newQueryState');
    const next = encodeCursor({ kind: 'jmap', sinceState: newState });

    const changes: MailChange[] = [];
    for (const entry of asArray(readProp(response, 'removed'))) {
      const id = asString(entry);
      if (id !== null) changes.push({ kind: 'destroyed', id, folder, cursor: next });
    }
    for (const entry of asArray(readProp(response, 'added'))) {
      const id = asString(readProp(entry, 'id'));
      if (id !== null) changes.push({ kind: 'created', id, folder, cursor: next });
    }
    return changes;
  }

  async getMessages(ids: string[]): Promise<MailMessage[]> {
    if (ids.length === 0) return [];

    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/get',
        {
          accountId: this.#accountId,
          ids,
          properties: EMAIL_PROPERTIES,
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        'g0',
      ],
    );

    const folders = await this.#pathsById();
    return asArray(readProp(response, 'list'))
      .map((entry) => toMailMessage(entry, folders))
      .filter(isNotNull);
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

  async #inboxCursor(): Promise<string> {
    const folderId = await this.#folderId('INBOX');
    const response = await this.#call(
      [JMAP_CORE, JMAP_MAIL],
      [
        'Email/query',
        { accountId: this.#accountId, filter: { inMailbox: folderId }, limit: 0 },
        'c0',
      ],
    );
    const state = asString(readProp(response, 'queryState'));
    if (state === null) throw new TypeError('Email/query returned no queryState');
    return encodeCursor({ kind: 'jmap', sinceState: state });
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

function spamHeaders(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (record === null) return {};

  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const match = /^header:(x-spam-[^:]+)/i.exec(key);
    const text = asString(raw);
    if (match?.[1] !== undefined && text !== null) headers[match[1].toLowerCase()] = text;
  }
  return headers;
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
