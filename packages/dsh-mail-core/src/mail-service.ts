/**
 * The abstract mail contract and the Cordis service that exposes it.
 *
 * Tools consume `ctx.mailbox` and never an adapter directly, so swapping JMAP
 * for IMAP in `cordis.patch.yml` changes no consumer. Where the protocols
 * genuinely differ, consumers branch on {@link Capabilities} rather than on
 * which adapter happens to be mounted.
 */

import { Service, type Context } from '@deepseek-ai/cordis';

import {
  sentinelKeyword,
  toMailCategory,
  type Capabilities,
  type DraftMessage,
  type MailCategory,
  type MailChange,
  type MailFolder,
  type MailMessage,
} from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    mailbox: MailboxService;
  }
}

/**
 * What every adapter implements (PRD section 3.2).
 *
 * Cursors cross this boundary as opaque strings: only the adapter that issued
 * one knows how to read it.
 */
export interface MailService {
  listFolders(): Promise<MailFolder[]>;
  /**
   * The folder's cursor as it stands now, without its contents.
   *
   * An addition to the contract PRD section 3.2 states verbatim, and the
   * reason is a gap rather than a preference: `queryChanges` requires a cursor
   * and every cursor it produces rides on a `MailChange`, so a folder that has
   * not changed hands back nothing to resume from. An agent meeting a mailbox
   * it has never seen had nowhere to begin.
   *
   * This is the cold start, named. It reports where the folder is so a first
   * run can start from now, leaving the history to a deliberate backfill
   * rather than classifying a whole mailbox by accident.
   */
  currentCursor(folder: string): Promise<string>;
  queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]>;
  getMessages(ids: string[]): Promise<MailMessage[]>;
  watchInbox(handler: (evt: MailChange) => void): AsyncDisposable;
  moveMessage(id: string, targetFolder: string): Promise<void>;
  setKeywords(id: string, keywords: string[]): Promise<void>;
  createDraft(msg: DraftMessage): Promise<string>;
  /** Hands the draft to the DSH approval policy before anything leaves. */
  submitDraft(draftId: string): Promise<void>;
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Degradation for servers without custom keywords
// ---------------------------------------------------------------------------

/**
 * How a category is expressed on a server that cannot store custom keywords.
 *
 * `folder` is `null` when the category must not move the message: `important`
 * is flagged in place, `standard` needs no marking at all, and `transactional`
 * stays in the inbox for its first day (PRD section 4.5) before a later phase
 * archives it on a timer.
 */
export interface KeywordFallback {
  readonly flags: readonly string[];
  readonly folder: string | null;
}

const FALLBACKS: Readonly<Record<MailCategory, KeywordFallback>> = {
  important: { flags: ['\\Flagged'], folder: null },
  standard: { flags: [], folder: null },
  'newsletter-tech': { flags: [], folder: 'Newsletters/Tech' },
  'newsletter-promo': { flags: [], folder: 'Newsletters/Promo' },
  'newsletter-notification': { flags: [], folder: 'Newsletters/Notifications' },
  transactional: { flags: [], folder: null },
  'spam-probable': { flags: [], folder: 'Junk' },
  'spam-certain': { flags: [], folder: 'Junk' },
  // On JMAP a keyword marks this and the message stays in the inbox, as
  // section 4.2 specifies. A server without custom keywords has no way to
  // mark anything in place, so the folder *is* the mark here.
  'needs-review': { flags: [], folder: 'NeedsReview' },
};

/** The fallback for a category, for adapters and consumers that need to plan. */
export function keywordFallback(category: MailCategory): KeywordFallback {
  return FALLBACKS[category];
}

// ---------------------------------------------------------------------------
// The Cordis service
// ---------------------------------------------------------------------------

/**
 * Registered as `ctx.mailbox`.
 *
 * The harness claims plain service names such as `tools` and `llm`, so a
 * third-party service namespaces itself; `mailbox` says what it owns without
 * colliding with anything the harness registers.
 */
export class MailboxService extends Service implements MailService {
  // `private`, not `#`, and the exception to the house rule is the reason:
  // consumers reach a service through a Cordis proxy, and `#field` is a runtime
  // brand check against the real instance. Through the proxy every method
  // throws `Cannot read private member #adapter from an object whose class did
  // not declare it` — at first call, long after a clean boot. `private` erases
  // at runtime, which is exactly what makes it survive the proxy. Every Service
  // subclass in DSH itself does the same.
  private readonly adapter: MailService;

  constructor(ctx: Context, adapter: MailService) {
    super(ctx, 'mailbox');
    this.adapter = adapter;
  }

  get capabilities(): Capabilities {
    return this.adapter.capabilities;
  }

  listFolders(): Promise<MailFolder[]> {
    return this.adapter.listFolders();
  }

  currentCursor(folder: string): Promise<string> {
    return this.adapter.currentCursor(folder);
  }

  queryChanges(folder: string, sinceCursor: string): Promise<MailChange[]> {
    return this.adapter.queryChanges(folder, sinceCursor);
  }

  getMessages(ids: string[]): Promise<MailMessage[]> {
    return this.adapter.getMessages(ids);
  }

  watchInbox(handler: (evt: MailChange) => void): AsyncDisposable {
    return this.adapter.watchInbox(handler);
  }

  moveMessage(id: string, targetFolder: string): Promise<void> {
    return this.adapter.moveMessage(id, targetFolder);
  }

  createDraft(msg: DraftMessage): Promise<string> {
    return this.adapter.createDraft(msg);
  }

  submitDraft(draftId: string): Promise<void> {
    return this.adapter.submitDraft(draftId);
  }

  /**
   * Sets keywords, degrading when the server cannot store custom ones.
   *
   * On a capable server this is a straight pass-through. Otherwise each
   * Sentinel keyword becomes the flags and the folder move that stand in for
   * it, so a consumer that asked for `$twaky-newsletter-promo` gets the
   * message filed under `Newsletters/Promo` without knowing an IMAP server is
   * mounted.
   */
  async setKeywords(id: string, keywords: string[]): Promise<void> {
    if (this.adapter.capabilities.customKeywords) {
      await this.adapter.setKeywords(id, keywords);
      return;
    }

    const plan = planDegradedKeywords(keywords);
    if (plan.flags.length > 0) await this.adapter.setKeywords(id, [...plan.flags]);
    if (plan.folder !== null) await this.adapter.moveMessage(id, plan.folder);
  }
}

/**
 * Resolve a keyword list into the flags and single destination folder that
 * express it on a server without custom keywords.
 *
 * Keywords that are not Sentinel tags pass through as flags: a server that
 * rejects custom keywords still stores the standard IMAP ones. When several
 * Sentinel tags name a folder, the first wins, since a message has one home.
 */
export function planDegradedKeywords(keywords: readonly string[]): KeywordFallback {
  const flags: string[] = [];
  let folder: string | null = null;

  for (const keyword of keywords) {
    const category = sentinelCategory(keyword);
    if (category === null) {
      flags.push(keyword);
      continue;
    }
    const fallback = FALLBACKS[category];
    flags.push(...fallback.flags);
    folder ??= fallback.folder;
  }

  return { flags, folder };
}

function sentinelCategory(keyword: string): MailCategory | null {
  const lowered = keyword.toLowerCase();
  if (!lowered.startsWith('$twaky-')) return null;
  return toMailCategory(lowered.slice('$twaky-'.length));
}

/** Re-exported so callers can build the keyword the fallbacks are keyed on. */
export { sentinelKeyword };
