/**
 * The wire client behind {@link ImapConnection} and {@link SmtpSender}.
 *
 * The adapter owns the protocol reasoning — cursor arithmetic, UIDVALIDITY
 * invalidation, the re-IDLE clock — and it was written against ports so none of
 * that needs a server. This is the other half: the part that does need one, and
 * that no unit test can tell you is correct.
 *
 * ImapFlow and Nodemailer carry the parsing that is genuinely hard to get right
 * — literals, continuations, MIME, modified UTF-7 mailbox names — and both are
 * MIT. Hand-rolling that surface would be a larger risk than the dependency.
 */

import { ImapFlow, type ListResponse, type FetchMessageObject } from 'imapflow';
import { createTransport, type Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { MailAddress } from '../types.js';
import type {
  ImapConnection,
  ImapFetchedMessage,
  ImapMailbox,
  MailboxStatus,
  OutgoingMessage,
  SmtpSender,
} from './imap-adapter.js';

export interface ImapClientConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  /**
   * Resolved at construction by the caller; never read from config here.
   * Exactly one of `password` and `accessToken` is used: a server advertising
   * `AUTH=XOAUTH2` (Gmail, Outlook 365) takes the token, everything else takes
   * the password. The account this project targets advertises `AUTH=PLAIN`
   * only, which is why both paths exist.
   */
  readonly password?: string | undefined;
  /** OAuth 2 bearer for XOAUTH2. Refreshing it is the caller's job. */
  readonly accessToken?: string | undefined;
  /** Trust a self-signed certificate. Test servers only. */
  readonly allowInsecureTls?: boolean | undefined;
}

export interface SmtpClientConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  /** As for IMAP: one of these, not both. */
  readonly password?: string | undefined;
  readonly accessToken?: string | undefined;
  readonly from: MailAddress;
  readonly allowInsecureTls?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

function toAddresses(
  list: readonly { name?: string | undefined; address?: string | undefined }[] | undefined,
): readonly MailAddress[] {
  if (list === undefined) return [];
  const out: MailAddress[] = [];
  for (const entry of list) {
    if (entry.address === undefined || entry.address.length === 0) continue;
    out.push({ name: entry.name ?? null, email: entry.address });
  }
  return out;
}

/** `Buffer | string | undefined` is what the library hands back for a body part. */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
}

/**
 * True when the structure names any part that is not the message's own text.
 *
 * `bodyStructure` is a recursive shape; anything with a disposition of
 * `attachment`, or a leaf that is neither text/plain nor text/html, counts.
 */
function hasAttachment(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as {
    disposition?: string;
    type?: string;
    childNodes?: readonly unknown[];
  };
  if (typeof n.disposition === 'string' && n.disposition.toLowerCase() === 'attachment') {
    return true;
  }
  if (Array.isArray(n.childNodes) && n.childNodes.length > 0) {
    return n.childNodes.some((child) => hasAttachment(child));
  }
  const type = (n.type ?? '').toLowerCase();
  return type.length > 0 && type !== 'text/plain' && type !== 'text/html' && !type.startsWith('multipart/');
}

export class ImapFlowConnection implements ImapConnection {
  private readonly client: ImapFlow;
  private opened: string | null = null;
  private plainListOnly = false;

  constructor(config: ImapClientConfig) {
    if (config.password === undefined && config.accessToken === undefined) {
      throw new TypeError('An IMAP connection needs either a password or an access token');
    }
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth:
        config.accessToken === undefined
          ? { user: config.user, pass: config.password }
          : { user: config.user, accessToken: config.accessToken },
      logger: false,
      // A test server's certificate is self-signed; a real one is not, and the
      // flag has to be asked for explicitly rather than defaulted on.
      tls: config.allowInsecureTls === true ? { rejectUnauthorized: false } : undefined,
    });
  }

  /** Connects on first use, so constructing a client performs no I/O. */
  private async ready(): Promise<ImapFlow> {
    if (!this.client.usable) await this.client.connect();
    return this.client;
  }

  /**
   * Retries a LIST-driven call with the extended arguments turned off.
   *
   * The account this project targets answers `NO LIST processing failed.` to
   * `LIST "" "*" RETURN (SUBSCRIBED)`, while `RETURN (SPECIAL-USE)` and
   * `RETURN (CHILDREN)` both succeed, and so does the `LIST (SUBSCRIBED)`
   * selection option and plain `LSUB`. Narrowed by issuing each option on its
   * own: `SUBSCRIBED` as a *return* option is the single trigger. Upstream
   * `apache/james:memory-latest` accepts all of them, so this is a property of
   * that deployment rather than of James — see docs/upstream/james-list-return-subscribed.md.
   *
   * Only that one argument is dropped. Turning off the aux options too would
   * cost `SPECIAL-USE`, which is how folder roles are resolved.
   *
   * `mailboxOpen` lists before it selects, so this covers opening too. The
   * flag stays set for the connection: a server that failed once will fail
   * again, and a round trip per call to rediscover that is waste.
   */
  private async withPlainListFallback<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.plainListOnly || !/list processing failed|command failed/i.test(message)) {
        throw err;
      }
      this.plainListOnly = true;
      // Not in the published types: an escape hatch the library documents in
      // its own source for exactly this class of server.
      const escape = this.client as unknown as Record<string, boolean>;
      escape['skipListSubscribedArg'] = true;
      return run();
    }
  }

  async open(path: string): Promise<MailboxStatus> {
    const client = await this.ready();
    const box = await this.withPlainListFallback(() => client.mailboxOpen(path));
    this.opened = path;
    return {
      uidValidity: Number(box.uidValidity),
      uidNext: box.uidNext ?? 0,
    };
  }

  async listMailboxes(): Promise<readonly ImapMailbox[]> {
    const client = await this.ready();
    const boxes = await this.withPlainListFallback(() => client.list());
    const out: ImapMailbox[] = [];
    for (const box of boxes as readonly ListResponse[]) {
      // STATUS is a second round trip per mailbox. On an account with several
      // hundred folders that is the difference between a listing and a stall,
      // so counts are reported only for what a caller opened.
      out.push({
        path: box.path,
        name: box.name,
        specialUse: box.specialUse ?? null,
        totalMessages: 0,
        unreadMessages: 0,
      });
    }
    return out;
  }

  async searchFrom(path: string, fromUid: number): Promise<readonly number[]> {
    const client = await this.ready();
    if (this.opened !== path) await this.open(path);
    // `UID SEARCH UID <from>:*` — the range the adapter's cursor describes.
    const found = await client.search({ uid: `${String(fromUid)}:*` }, { uid: true });
    return found === false ? [] : found.filter((uid) => uid >= fromUid);
  }

  async fetchByUid(path: string, uids: readonly number[]): Promise<readonly ImapFetchedMessage[]> {
    if (uids.length === 0) return [];
    const client = await this.ready();
    if (this.opened !== path) await this.open(path);

    const out: ImapFetchedMessage[] = [];
    for await (const raw of client.fetch(
      { uid: uids.join(',') },
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
        headers: true,
        bodyParts: ['text'],
      },
      { uid: true },
    )) {
      out.push(this.toFetched(raw));
    }
    return out;
  }

  private toFetched(raw: FetchMessageObject): ImapFetchedMessage {
    const envelope = raw.envelope ?? {};
    const headerText = asText(raw.headers) ?? '';
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
    }

    const text = asText(raw.bodyParts?.get('text'));
    const contentType = (headers['content-type'] ?? '').toLowerCase();
    const isHtml = contentType.includes('text/html');

    return {
      uid: raw.uid,
      flags: raw.flags === undefined ? [] : [...raw.flags],
      envelope: {
        messageId: envelope.messageId ?? null,
        inReplyTo: envelope.inReplyTo ?? null,
        subject: envelope.subject ?? null,
        date: envelope.date ?? null,
        from: toAddresses(envelope.from),
        to: toAddresses(envelope.to),
        cc: toAddresses(envelope.cc),
      },
      // The library types this as `string | Date` depending on the server's
      // reply; the port promises a Date, so the conversion happens here.
      internalDate: raw.internalDate === undefined ? new Date(0) : new Date(raw.internalDate),
      headers,
      bodyText: isHtml ? null : text,
      bodyHtml: isHtml ? text : null,
      hasAttachments: hasAttachment(raw.bodyStructure),
    };
  }

  async moveByUid(path: string, uid: number, target: string): Promise<void> {
    const client = await this.ready();
    if (this.opened !== path) await this.open(path);
    await client.messageMove({ uid: String(uid) }, target, { uid: true });
    // MOVE expunges from the source, so what is cached about it is now wrong.
    this.opened = null;
  }

  async addFlagsByUid(path: string, uid: number, flags: readonly string[]): Promise<void> {
    if (flags.length === 0) return;
    const client = await this.ready();
    if (this.opened !== path) await this.open(path);
    await client.messageFlagsAdd({ uid: String(uid) }, [...flags], { uid: true });
  }

  async append(path: string, raw: string, flags: readonly string[]): Promise<number | null> {
    const client = await this.ready();
    const result = await client.append(path, raw, [...flags]);
    // UIDPLUS gives back the assigned UID; a server without it gives nothing,
    // and the adapter is written to accept that.
    return result === false || result.uid === undefined ? null : result.uid;
  }

  async ensureMailbox(path: string): Promise<void> {
    const client = await this.ready();
    try {
      await client.mailboxCreate(path);
    } catch (err: unknown) {
      // ALREADYEXISTS is the documented response to creating what is there,
      // and it is the outcome this method asks for.
      const message = err instanceof Error ? err.message : String(err);
      if (!/alreadyexists|already exists/i.test(message)) throw err;
    }
  }

  async idle(path: string, signal: AbortSignal, onChange: () => void): Promise<void> {
    const client = await this.ready();
    if (this.opened !== path) await this.open(path);

    const fire = (): void => {
      onChange();
    };
    client.on('exists', fire);
    client.on('expunge', fire);
    client.on('flags', fire);

    const abort = new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        resolve();
      }, { once: true });
    });

    try {
      // idle() resolves when the command ends; the race is what lets an abort
      // return control without waiting for the server's own timeout.
      await Promise.race([client.idle(), abort]);
    } finally {
      client.off('exists', fire);
      client.off('expunge', fire);
      client.off('flags', fire);
    }
  }

  /** Closes the connection. Not part of the port: only a test or a shutdown calls it. */
  async close(): Promise<void> {
    if (this.client.usable) await this.client.logout();
  }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

function formatAddress(address: MailAddress): string {
  return address.name === null || address.name.length === 0
    ? address.email
    : `${address.name} <${address.email}>`;
}

export class NodemailerSender implements SmtpSender {
  private readonly transport: Transporter;
  private readonly from: MailAddress;

  constructor(config: SmtpClientConfig) {
    this.from = config.from;
    if (config.password === undefined && config.accessToken === undefined) {
      throw new TypeError('An SMTP sender needs either a password or an access token');
    }
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth:
        config.accessToken === undefined
          ? { user: config.user, pass: config.password }
          : { type: 'OAuth2', user: config.user, accessToken: config.accessToken },
      ...(config.allowInsecureTls === true ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }

  async send(message: OutgoingMessage): Promise<{ messageId: string; raw: string }> {
    // Composed here rather than by sendMail, because an SMTP transport reports
    // only an envelope and a Message-ID — never the bytes. The adapter writes
    // a copy of every sent message to Sent, so it needs the message that was
    // actually submitted, not one re-rendered from the same fields afterwards.
    const composed = await new MailComposer({
      from: formatAddress(this.from),
      to: message.to.map(formatAddress),
      cc: message.cc.map(formatAddress),
      subject: message.subject,
      text: message.bodyText,
      ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
      ...(message.references.length === 0 ? {} : { references: [...message.references] }),
    })
      .compile()
      .build();

    const raw = composed.toString('utf8');

    // `SentMessageInfo` is `any` in the published types, so the result crosses
    // into this module as `unknown` and is read through a guard.
    // Sending raw bytes bypasses header parsing, so the envelope has to be
    // stated: SMTP takes its recipients from RCPT TO, not from the message.
    const sent: unknown = await this.transport.sendMail({
      raw: composed,
      envelope: {
        from: this.from.email,
        to: [...message.to, ...message.cc].map((a) => a.email),
      },
    });
    if (typeof sent !== 'object' || sent === null) {
      throw new TypeError('SMTP submission returned no result');
    }
    const info = sent as { messageId?: unknown };

    // The composed bytes carry the Message-ID; the server's echo of it is not
    // guaranteed to come back, so it is read from what was sent.
    const fromRaw = /^message-id:\s*(<[^>]+>)/im.exec(raw);
    const messageId =
      typeof info.messageId === 'string' && info.messageId.length > 0
        ? info.messageId
        : (fromRaw?.[1] ?? null);
    if (messageId === null) throw new TypeError('SMTP submission produced no Message-ID');

    return { messageId, raw };
  }

  close(): void {
    this.transport.close();
  }
}
