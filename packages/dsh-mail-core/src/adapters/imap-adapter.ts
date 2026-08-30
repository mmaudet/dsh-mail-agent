/**
 * IMAP + SMTP adapter (RFC 3501, RFC 2177 for IDLE).
 *
 * The adapter owns the protocol reasoning that is worth testing: cursor
 * arithmetic, UIDVALIDITY invalidation, the re-IDLE clock, thread
 * reconstruction, and writing a copy of every sent message back to `Sent`.
 * The wire clients sit behind {@link ImapConnection} and {@link SmtpSender},
 * so none of that reasoning needs a server to be exercised.
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

/**
 * RFC 2177 lets a server drop an idle connection after 30 minutes. Re-issuing
 * at 29 keeps the command inside that window with a minute to spare.
 */
export const RE_IDLE_INTERVAL_MS = 29 * 60 * 1000;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface MailboxStatus {
  readonly uidValidity: number;
  readonly uidNext: number;
}

export interface ImapMailbox {
  readonly path: string;
  readonly name: string;
  /** `SPECIAL-USE` attribute such as `\Sent`, when the server advertises one. */
  readonly specialUse: string | null;
  readonly totalMessages: number;
  readonly unreadMessages: number;
}

/** One message as `FETCH` returns it. */
export interface ImapFetchedMessage {
  readonly uid: number;
  readonly flags: readonly string[];
  readonly envelope: {
    readonly messageId: string | null;
    readonly inReplyTo: string | null;
    readonly subject: string | null;
    readonly date: Date | null;
    readonly from: readonly MailAddress[];
    readonly to: readonly MailAddress[];
    readonly cc: readonly MailAddress[];
  };
  readonly internalDate: Date;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly hasAttachments: boolean;
}

/** The subset of an IMAP client this adapter drives. */
export interface ImapConnection {
  open(path: string): Promise<MailboxStatus>;
  listMailboxes(): Promise<readonly ImapMailbox[]>;
  /** `UID SEARCH UID <from>:*`, returning the UIDs that exist at or past it. */
  searchFrom(path: string, fromUid: number): Promise<readonly number[]>;
  fetchByUid(path: string, uids: readonly number[]): Promise<readonly ImapFetchedMessage[]>;
  moveByUid(path: string, uid: number, target: string): Promise<void>;
  addFlagsByUid(path: string, uid: number, flags: readonly string[]): Promise<void>;
  append(path: string, raw: string, flags: readonly string[]): Promise<number | null>;
  /** Creates the mailbox when absent; a no-op when it already exists. */
  ensureMailbox(path: string): Promise<void>;
  /**
   * Holds one `IDLE` command until `signal` aborts, calling `onChange` for
   * every untagged update. Resolves when the command ends for any reason.
   */
  idle(path: string, signal: AbortSignal, onChange: () => void): Promise<void>;
}

export interface OutgoingMessage {
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly bodyText: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
}

export interface SmtpSender {
  /** Submits the message and returns the `Message-ID` and the raw RFC 5322 bytes. */
  send(message: OutgoingMessage): Promise<{ readonly messageId: string; readonly raw: string }>;
}

export interface ImapAdapterOptions {
  readonly connection: ImapConnection;
  readonly smtp: SmtpSender;
  readonly inboxPath?: string | undefined;
  readonly draftsPath?: string | undefined;
  readonly sentPath?: string | undefined;
  /** Injected for tests; defaults to real timers. */
  readonly setTimer?: ((fn: () => void, ms: number) => () => void) | undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ImapAdapter implements MailService {
  readonly capabilities: Capabilities = {
    push: 'imap-idle',
    // Most IMAP servers reject arbitrary keywords, so the service degrades
    // Sentinel tags into flags and folder moves on this adapter's behalf.
    customKeywords: false,
    threadNative: false,
    spamHeaders: true,
    // A move assigns a new UID (RFC 3501), so the id a plan was made against
    // stops resolving the moment the message leaves. A successful filing and
    // an owner taking it back are indistinguishable here.
    stableIds: false,
  };

  readonly #imap: ImapConnection;
  readonly #smtp: SmtpSender;
  readonly #inbox: string;
  readonly #drafts: string;
  readonly #sent: string;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  /** Draft id to the UID and path that hold it, since IMAP has no id space. */
  readonly #drafted = new Map<string, { path: string; uid: number }>();
  #draftCounter = 0;

  constructor(options: ImapAdapterOptions) {
    this.#imap = options.connection;
    this.#smtp = options.smtp;
    this.#inbox = options.inboxPath ?? 'INBOX';
    this.#drafts = options.draftsPath ?? 'Drafts';
    this.#sent = options.sentPath ?? 'Sent';
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => {
          clearTimeout(handle);
        };
      });
  }

  async listFolders(): Promise<MailFolder[]> {
    const mailboxes = await this.#imap.listMailboxes();
    return mailboxes.map((mailbox) => ({
      id: mailbox.path,
      name: mailbox.name,
      path: mailbox.path,
      role: toFolderRole(mailbox.specialUse),
      totalMessages: mailbox.totalMessages,
      unreadMessages: mailbox.unreadMessages,
    }));
  }

  /**
   * Delta poll for one folder.
   *
   * A `UIDVALIDITY` change means every UID the caller stored refers to nothing
   * (RFC 3501 section 2.3.1.1). Rather than resume from a UID that no longer
   * identifies the same message, the whole folder is reported as new and the
   * caller resyncs from a cursor it can trust.
   *
   * Flag edits on messages already seen are not reported: detecting them needs
   * CONDSTORE, which this adapter does not require of a server.
   */
  /**
   * Where the folder stands now, from `SELECT`'s own answer.
   *
   * UIDNEXT is the UID the next message will be given, so the last one that
   * exists is the one before it — and on a folder nothing has ever reached,
   * UIDNEXT is 1 and there is no last UID at all. Getting this off by one
   * re-reads a message on every resume, or skips one for ever.
   */
  async currentCursor(folder: string): Promise<string> {
    const status = await this.#imap.open(folder);
    return encodeCursor({
      kind: 'imap',
      uidValidity: status.uidValidity,
      lastUid: Math.max(0, status.uidNext - 1),
    });
  }

  async queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]> {
    const cursor = decodeCursor(sinceCursor);
    if (cursor === null || cursor.kind !== 'imap') {
      throw new TypeError(`Not an IMAP cursor: ${sinceCursor}`);
    }

    const status = await this.#imap.open(folder);
    const invalidated = status.uidValidity !== cursor.uidValidity;
    const fromUid = invalidated ? 1 : cursor.lastUid + 1;

    const uids = [...(await this.#imap.searchFrom(folder, fromUid))]
      .filter((uid) => uid >= fromUid)
      .sort((a, b) => a - b);

    let lastUid = invalidated ? 0 : cursor.lastUid;
    return uids.map((uid) => {
      lastUid = Math.max(lastUid, uid);
      return {
        kind: 'created' as const,
        id: messageId(folder, uid),
        folder,
        cursor: encodeCursor({ kind: 'imap', uidValidity: status.uidValidity, lastUid }),
      };
    });
  }

  /**
   * Which folders each of these messages is in now, by id.
   *
   * An IMAP id encodes the folder it was read from, and a move assigns a new
   * UID — so this can only confirm that a message is still where its id says,
   * never find one that has left. `capabilities.stableIds` is false here for
   * that reason, and a caller reading corrections must check it: absence from
   * this map means moved *or* deleted *or* filed successfully by the agent
   * itself, and nothing here can tell those apart.
   */
  async locate(ids: readonly string[]): Promise<Map<string, string[]>> {
    const byFolder = new Map<string, number[]>();
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (parsed === null) continue;
      const uids = byFolder.get(parsed.folder) ?? [];
      uids.push(parsed.uid);
      byFolder.set(parsed.folder, uids);
    }

    const out = new Map<string, string[]>();
    for (const [folder, uids] of byFolder) {
      const fetched = await this.#imap.fetchByUid(folder, uids);
      for (const entry of fetched) out.set(messageId(folder, entry.uid), [folder]);
    }
    return out;
  }

  async getMessages(ids: string[]): Promise<MailMessage[]> {
    const byFolder = new Map<string, number[]>();
    for (const id of ids) {
      const parsed = parseMessageId(id);
      if (parsed === null) continue;
      const uids = byFolder.get(parsed.folder) ?? [];
      uids.push(parsed.uid);
      byFolder.set(parsed.folder, uids);
    }

    const messages: MailMessage[] = [];
    for (const [folder, uids] of byFolder) {
      const fetched = await this.#imap.fetchByUid(folder, uids);
      for (const entry of fetched) messages.push(toMailMessage(entry, folder));
    }
    return messages;
  }

  /**
   * Holds an `IDLE` on the inbox, re-issuing it before the server's timeout and
   * reconnecting with exponential backoff when the command fails.
   */
  watchInbox(handler: (evt: MailChange) => void): AsyncDisposable {
    const controller = new AbortController();
    let cursor: string | null = null;
    let backoffMs = INITIAL_BACKOFF_MS;
    let cancelTimer: (() => void) | null = null;

    const drain = (): void => {
      void (async () => {
        try {
          cursor ??= await this.#currentCursor(this.#inbox);
          for (const change of await this.queryChanges(this.#inbox, cursor)) {
            cursor = change.cursor;
            handler(change);
          }
        } catch {
          // Leave the cursor untouched: the next wake retries the same delta.
        }
      })();
    };

    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const cycle = new AbortController();
        const endCycle = (): void => {
          cycle.abort();
        };
        controller.signal.addEventListener('abort', endCycle, { once: true });
        cancelTimer = this.#setTimer(endCycle, RE_IDLE_INTERVAL_MS);

        try {
          await this.#imap.idle(this.#inbox, cycle.signal, drain);
          backoffMs = INITIAL_BACKOFF_MS;
        } catch {
          if (controller.signal.aborted) break;
          await this.#sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        } finally {
          controller.signal.removeEventListener('abort', endCycle);
          cancelTimer?.();
          cancelTimer = null;
        }
      }
    };

    const running = loop();

    return {
      [Symbol.asyncDispose]: async () => {
        controller.abort();
        cancelTimer?.();
        await running;
      },
    };
  }

  async moveMessage(id: string, targetFolder: string): Promise<void> {
    const parsed = requireMessageId(id);
    await this.#imap.ensureMailbox(targetFolder);
    await this.#imap.moveByUid(parsed.folder, parsed.uid, targetFolder);
  }

  /**
   * Adds flags to a message.
   *
   * `capabilities.customKeywords` is false, so the service has already turned
   * Sentinel tags into standard flags and a folder move before reaching here.
   */
  async setKeywords(id: string, keywords: string[]): Promise<void> {
    const parsed = requireMessageId(id);
    if (keywords.length === 0) return;
    await this.#imap.addFlagsByUid(parsed.folder, parsed.uid, keywords);
  }

  async createDraft(msg: DraftMessage): Promise<string> {
    const { raw } = await this.#smtp.send({ ...msg, subject: msg.subject });
    await this.#imap.ensureMailbox(this.#drafts);
    const uid = await this.#imap.append(this.#drafts, raw, ['\\Draft']);

    const handle = `draft-${String(++this.#draftCounter)}`;
    this.#drafted.set(handle, { path: this.#drafts, uid: uid ?? 0 });
    return handle;
  }

  /**
   * Submits a draft over SMTP, then writes the sent copy back to `Sent`.
   *
   * IMAP has no equivalent of `EmailSubmission/set`: nothing files the message
   * for us, so the `APPEND` is part of sending, not an optimisation.
   */
  async submitDraft(draftId: string): Promise<void> {
    const draft = this.#drafted.get(draftId);
    if (draft === undefined) throw new TypeError(`No such draft: ${draftId}`);

    const [fetched] = await this.#imap.fetchByUid(draft.path, [draft.uid]);
    if (fetched === undefined) throw new TypeError(`Draft ${draftId} is no longer in ${draft.path}`);

    const { raw } = await this.#smtp.send({
      to: fetched.envelope.to,
      cc: fetched.envelope.cc,
      subject: fetched.envelope.subject ?? '',
      bodyText: fetched.bodyText ?? '',
      inReplyTo: fetched.envelope.inReplyTo,
      references: headerReferences(fetched.headers),
    });

    await this.#imap.ensureMailbox(this.#sent);
    await this.#imap.append(this.#sent, raw, ['\\Seen']);
    this.#drafted.delete(draftId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #currentCursor(folder: string): Promise<string> {
    const status = await this.#imap.open(folder);
    return encodeCursor({
      kind: 'imap',
      uidValidity: status.uidValidity,
      lastUid: Math.max(status.uidNext - 1, 0),
    });
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#setTimer(() => {
        resolve();
      }, ms);
    });
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * IMAP identifies a message by `(folder, UID)`, not by a global id, so the
 * contract's opaque string carries both.
 */
export function messageId(folder: string, uid: number): string {
  return `${folder}:${String(uid)}`;
}

export function parseMessageId(id: string): { folder: string; uid: number } | null {
  const separator = id.lastIndexOf(':');
  if (separator <= 0) return null;
  const folder = id.slice(0, separator);
  const raw = id.slice(separator + 1);
  if (!/^\d+$/.test(raw)) return null;
  return { folder, uid: Number(raw) };
}

function requireMessageId(id: string): { folder: string; uid: number } {
  const parsed = parseMessageId(id);
  if (parsed === null) throw new TypeError(`Not an IMAP message id: ${id}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const SPECIAL_USE_ROLES: Readonly<Record<string, FolderRole>> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\junk': 'junk',
  '\\trash': 'trash',
  '\\archive': 'archive',
};

function toFolderRole(specialUse: string | null): FolderRole {
  if (specialUse === null) return null;
  return SPECIAL_USE_ROLES[specialUse.toLowerCase()] ?? null;
}

function toMailMessage(entry: ImapFetchedMessage, folder: string): MailMessage {
  const references = headerReferences(entry.headers);
  const ownId = stripAngles(entry.envelope.messageId);
  const inReplyTo = stripAngles(entry.envelope.inReplyTo);

  return {
    id: messageId(folder, entry.uid),
    threadId: threadRoot(references, inReplyTo, ownId),
    messageId: ownId,
    inReplyTo: inReplyTo === null ? [] : [inReplyTo],
    references,
    from: entry.envelope.from,
    to: entry.envelope.to,
    cc: entry.envelope.cc,
    subject: entry.envelope.subject ?? '',
    receivedAt: entry.internalDate,
    sentAt: entry.envelope.date,
    keywords: entry.flags,
    folder,
    preview: (entry.bodyText ?? '').slice(0, 256),
    bodyText: entry.bodyText,
    bodyHtml: entry.bodyHtml,
    hasAttachments: entry.hasAttachments,
    spamHeaders: spamHeaders(entry.headers),
    listUnsubscribe: unsubscribeTargets(entry.headers),
    listId: listIdOf(entry.headers['list-id']),
  };
}

/**
 * The thread root, since IMAP has no native threads.
 *
 * The oldest entry of `References` is the conversation root; failing that the
 * message this one answers; failing that the message is its own root.
 */
function threadRoot(
  references: readonly string[],
  inReplyTo: string | null,
  ownId: string | null,
): string | null {
  return references[0] ?? inReplyTo ?? ownId;
}

function headerReferences(headers: Readonly<Record<string, string>>): readonly string[] {
  const raw = headerValue(headers, 'references');
  if (raw === null) return [];
  return [...raw.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function spamHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (lowered.startsWith('x-spam-')) found[lowered] = value;
  }
  return found;
}

function unsubscribeTargets(headers: Readonly<Record<string, string>>): readonly string[] {
  const raw = headerValue(headers, 'list-unsubscribe');
  if (raw === null) return [];
  return [...raw.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

function stripAngles(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const inner = /^<(.+)>$/.exec(trimmed);
  return inner?.[1] ?? (trimmed.length > 0 ? trimmed : null);
}
