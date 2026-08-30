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
  /**
   * Which folders each of these messages is in now, by id.
   *
   * A second addition to the contract PRD section 3.2 states, and like the
   * first it closes a gap the PRD did not anticipate: the agent could file a
   * message and never learn that the owner had taken it back out. Every
   * correction the owner makes is expressed by moving mail, and nothing here
   * could read that.
   *
   * Folders plural, and not one folder, because on Gmail a label is a mailbox
   * and a message is in several at once. The question a caller actually has is
   * whether the message is still where it was put, which a set answers and a
   * single name would have to guess at.
   *
   * Ids that no longer resolve are absent from the map rather than reported as
   * an error: a message deleted since it was filed is an ordinary outcome, and
   * one the caller has to tell apart from a message that moved.
   */
  locate(ids: readonly string[]): Promise<Map<string, string[]>>;
  /**
   * Message ids in a folder received at or after a date, oldest first.
   *
   * The third addition to the contract PRD section 3.2 states, and the one it
   * named as missing: `queryChanges` needs a cursor, every cursor rides on a
   * change, and `currentCursor` reports the present — so an agent meeting a
   * mailbox with history could start from now and nothing else. Backfilling a
   * week, which is the only way to see a real mix of mail without waiting a
   * week, had no expression here at all.
   *
   * Oldest first because a backfill replays arrival order, and arrival order
   * is what node 1 and node 3 are built on: a thread's category is inherited
   * from the message that came before it, and a pattern is three sightings
   * accumulating. Newest-first would invert both.
   *
   * Bounded by `limit`, and the caller pages by moving `since` forward past
   * what it handled. No cursor, because the point is to reach mail that
   * predates every cursor there is.
   */
  messagesSince(folder: string, since: Date, limit: number): Promise<string[]>;
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
  // Nothing in the `acts` band moves. Mail the owner has to answer belongs
  // where they will see it, and a flag is the strongest thing a server without
  // custom keywords can say in place.
  'correspondance-commerciale-client': { flags: ['\\Flagged'], folder: null },
  'obligations-administratives-echeance': { flags: ['\\Flagged'], folder: null },
  'demande-interne': { flags: ['\\Flagged'], folder: null },
  'planification-reunion-rdv': { flags: ['\\Flagged'], folder: null },
  'incident-securite': { flags: ['\\Flagged'], folder: null },

  // The `reads` band files, because filing is what a thing worth reading later
  // and not now is for. `rh-interne` is the exception: it stays in the inbox
  // because it concerns a named person and is usually short-lived.
  'veille-newsletter': { flags: [], folder: 'Veille' },
  'support-technique-ticket': { flags: [], folder: 'Support' },
  'rapport-compte-rendu-interne': { flags: [], folder: 'Archives/Interne' },
  'notifications-personnelles-diverses': { flags: [], folder: 'Archives/Notifications' },
  'liste-diffusion': { flags: [], folder: 'Listes' },
  'recu-transaction': { flags: [], folder: 'Archives/Comptabilite' },
  'rh-interne': { flags: [], folder: null },
  'candidature-emploi': { flags: [], folder: 'Recrutement' },

  // The `drops` band leaves. Cold prospecting has no folder here because it
  // does not move: it is trashed, which is its own action with its own
  // reversal window, and naming `Trash` as a destination would hide a deletion
  // inside a filing rule.
  'prospection-commerciale-non-sollicitee': { flags: [], folder: null },
  'spam-formulaire-contact': { flags: [], folder: 'Junk' },
  'phishing-arnaque': { flags: [], folder: 'Junk' },

  // On JMAP a keyword marks this and the message stays in the inbox, as
  // section 4.2 specifies. A server without custom keywords has no way to
  // mark anything in place, so the folder *is* the mark here — which is why
  // `destinationFor` excludes it. This table answers "how does a server that
  // cannot tag record the category"; that one answers "where does this mail
  // belong". They agree for fifteen categories and differ for this one, and
  // collapsing them loses exactly that.
  'needs-review': { flags: [], folder: 'NeedsReview' },
};

/**
 * Where a category's mail belongs, on any server, or `null` when it stays put.
 *
 * Kept beside the fallback table rather than in the planner: the two used to
 * live in different files and could disagree about a destination, which is one
 * table too many for one question. Here the disagreement is visible and
 * deliberate.
 */
export function destinationFor(category: MailCategory): string | null {
  // The cascade saying it does not know is not a reason to move anything. On a
  // server that can tag, the message stays in the inbox wearing its keyword.
  if (category === 'needs-review') return null;
  return FALLBACKS[category].folder;
}

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

  locate(ids: readonly string[]): Promise<Map<string, string[]>> {
    return this.adapter.locate(ids);
  }

  messagesSince(folder: string, since: Date, limit: number): Promise<string[]> {
    return this.adapter.messagesSince(folder, since, limit);
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
/**
 * How one category is expressed on a server that cannot store custom keywords.
 *
 * Exported because the action planner needs the same table: the fallback is
 * not only a degradation, it is where a category's flags and folder are
 * written down.
 */
export function categoryFallback(category: MailCategory): KeywordFallback {
  return FALLBACKS[category];
}

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
