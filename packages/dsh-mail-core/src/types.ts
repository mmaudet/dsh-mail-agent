/**
 * Domain types shared by the mail contract and both adapters.
 *
 * Nothing here is protocol-specific: a value of these types means the same
 * thing whether it came from JMAP (RFC 8620/8621) or from IMAP (RFC 3501).
 * Where the two protocols genuinely disagree, the difference is exposed
 * through `Capabilities` rather than hidden behind a lossy abstraction.
 */

// ---------------------------------------------------------------------------
// Classification vocabulary
// ---------------------------------------------------------------------------

/**
 * The categories the cascade can assign to a message.
 *
 * PRD section 4.2 specifies eight, chosen before anyone had looked at a real
 * mailbox. These sixteen were derived from one: 400 messages described in free
 * words with no vocabulary imposed, grouped under a single rule — a category
 * exists only where the agent does something different with it — and then
 * measured by reclassifying the same 400, which put coverage at 97%.
 * `scripts/benchmark-taxonomy.mjs` reproduces all three passes, and
 * docs/reviews/sixteen-categories.md records what it found.
 *
 * Two of the sixteen came from reading the eleven messages nothing covered:
 * `recu-transaction`, which records money that has already moved, and
 * `demande-interne`, where a colleague asks the owner to decide. The second is
 * the one the owner cares most about, and the first fourteen had missed it.
 *
 * Eight distinctions were considered and rejected, among them the PRD's split
 * between a technical and a promotional newsletter: both are read once and
 * forgotten, so they are one category badly named.
 *
 * `needs-review` is not a classification the cascade is confident about: it is
 * what a below-threshold decision degrades to, and what a suspected spam
 * false-positive is re-routed to. It survives because it is an operational
 * state rather than a kind of mail.
 */
export type MailCategory =
  // Something only the owner can do, and it is not done. 35% of the mailbox.
  | 'correspondance-commerciale-client'
  | 'obligations-administratives-echeance'
  | 'demande-interne'
  | 'planification-reunion-rdv'
  | 'incident-securite'
  // Worth reading, asks nothing. 34%.
  | 'veille-newsletter'
  | 'support-technique-ticket'
  | 'rapport-compte-rendu-interne'
  | 'notifications-personnelles-diverses'
  | 'liste-diffusion'
  | 'recu-transaction'
  | 'rh-interne'
  | 'candidature-emploi'
  // Nothing to read and nothing to keep. 30%, and the largest single category
  // in the mailbox is in here.
  | 'prospection-commerciale-non-sollicitee'
  | 'spam-formulaire-contact'
  | 'phishing-arnaque'
  // Not a kind of mail.
  | 'needs-review';

const MAIL_CATEGORIES = [
  'correspondance-commerciale-client',
  'obligations-administratives-echeance',
  'demande-interne',
  'planification-reunion-rdv',
  'incident-securite',
  'veille-newsletter',
  'support-technique-ticket',
  'rapport-compte-rendu-interne',
  'notifications-personnelles-diverses',
  'liste-diffusion',
  'recu-transaction',
  'rh-interne',
  'candidature-emploi',
  'prospection-commerciale-non-sollicitee',
  'spam-formulaire-contact',
  'phishing-arnaque',
  'needs-review',
] as const satisfies readonly MailCategory[];

/**
 * How a category is handled, which is the axis the vocabulary was built on.
 *
 * A category earned its place by doing something different from its
 * neighbours; the band says which of the three things that difference is a
 * variation of. Consumers that only need the coarse decision — a digest, a
 * summary line, an approval default — read this rather than enumerating
 * sixteen names.
 */
export type CategoryBand = 'acts' | 'reads' | 'drops';

const BANDS: Readonly<Record<MailCategory, CategoryBand>> = {
  'correspondance-commerciale-client': 'acts',
  'obligations-administratives-echeance': 'acts',
  'demande-interne': 'acts',
  'planification-reunion-rdv': 'acts',
  'incident-securite': 'acts',
  'veille-newsletter': 'reads',
  'support-technique-ticket': 'reads',
  'rapport-compte-rendu-interne': 'reads',
  'notifications-personnelles-diverses': 'reads',
  'liste-diffusion': 'reads',
  'recu-transaction': 'reads',
  'rh-interne': 'reads',
  'candidature-emploi': 'reads',
  'prospection-commerciale-non-sollicitee': 'drops',
  'spam-formulaire-contact': 'drops',
  'phishing-arnaque': 'drops',
  // The cascade saying it does not know is not a reason to act on a message,
  // and not a reason to drop one either.
  'needs-review': 'reads',
};

/** Which of the three things the agent does with this category. */
export function bandOf(category: MailCategory): CategoryBand {
  return BANDS[category];
}

/** Narrow an untrusted string to a category, or `null` when it is not one. */
export function toMailCategory(raw: string): MailCategory | null {
  return (MAIL_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as MailCategory) // SAFETY: membership confirmed above
    : null;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * IMAP system flags that JMAP exposes as keywords (RFC 8621 section 4.1.1).
 * Keyword comparison is case-insensitive; this project stores them lowercase.
 */
export type SystemKeyword =
  | '$draft'
  | '$seen'
  | '$flagged'
  | '$answered'
  | '$forwarded'
  | '$phishing'
  | '$junk'
  | '$notjunk';

/** A classification tag owned by this project, for example `$twaky-important`. */
export type SentinelKeyword = `$twaky-${MailCategory}`;

/** A keyword this project is willing to *write*. */
export type MailKeyword = SystemKeyword | SentinelKeyword;

/** The Sentinel keyword that carries a given category. */
export function sentinelKeyword(category: MailCategory): SentinelKeyword {
  return `$twaky-${category}`;
}

/**
 * Keywords read back from a server are arbitrary strings: any client may have
 * set anything. This recovers only the ones this project understands.
 */
export function knownKeywords(raw: readonly string[]): MailKeyword[] {
  const known: MailKeyword[] = [];
  for (const value of raw) {
    const lowered = value.toLowerCase();
    if (SYSTEM_KEYWORDS.includes(lowered)) {
      known.push(lowered as SystemKeyword); // SAFETY: membership confirmed above
      continue;
    }
    const category = lowered.startsWith(SENTINEL_PREFIX)
      ? toMailCategory(lowered.slice(SENTINEL_PREFIX.length))
      : null;
    if (category !== null) known.push(sentinelKeyword(category));
  }
  return known;
}

const SENTINEL_PREFIX = '$twaky-';

const SYSTEM_KEYWORDS: readonly string[] = [
  '$draft',
  '$seen',
  '$flagged',
  '$answered',
  '$forwarded',
  '$phishing',
  '$junk',
  '$notjunk',
] satisfies readonly SystemKeyword[];

// ---------------------------------------------------------------------------
// Addresses, envelopes, messages
// ---------------------------------------------------------------------------

export interface MailAddress {
  /** Display name, or `null` when the header carried only an address. */
  readonly name: string | null;
  readonly email: string;
}

/**
 * Header-level facts about a message, cheap to fetch on both protocols
 * (JMAP `Email/get` with a header property set, IMAP `FETCH ENVELOPE`).
 */
export interface Envelope {
  readonly id: string;
  /**
   * Native on JMAP (`Thread/get`); reconstructed from `References` and
   * `In-Reply-To` on IMAP. `null` when the adapter could not place the
   * message in a thread, which `Capabilities.threadNative` predicts.
   */
  readonly threadId: string | null;
  /** RFC 5322 `Message-ID`, without angle brackets. */
  readonly messageId: string | null;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly from: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly receivedAt: Date;
  /** The `Date` header, which a sender controls and may omit or forge. */
  readonly sentAt: Date | null;
  /**
   * Raw keywords as the server reports them. Arbitrary strings by design:
   * pass through {@link knownKeywords} before matching against this project's
   * vocabulary.
   */
  readonly keywords: readonly string[];
  /** Folder path the message was observed in, for example `Newsletters/Tech`. */
  readonly folder: string;
}

/** An envelope plus the body and the signals classification needs. */
export interface MailMessage extends Envelope {
  readonly preview: string;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly hasAttachments: boolean;
  /**
   * `x-spam-*` headers, lowercased keys, when the server exposes them.
   * Empty when `Capabilities.spamHeaders` is false.
   */
  readonly spamHeaders: Readonly<Record<string, string>>;
  /** `List-Unsubscribe` targets (RFC 2369), in header order. */
  readonly listUnsubscribe: readonly string[];
  /**
   * The mailing list this message belongs to (RFC 2919 `List-Id`), or `null`.
   *
   * The identifier only, unbracketed: `List-Id: Licence review
   * <license-review.lists.example>` yields `license-review.lists.example`.
   *
   * Carried because a list is the unit of recurrence a sender is not. Its
   * messages come from many people, and the category belongs to the list
   * rather than to any of them — measured on the target inbox, where the
   * largest recurring source is a list no sender pattern could ever catch.
   */
  readonly listId: string | null;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/**
 * The role a server assigns a folder (JMAP `Mailbox.role`, IMAP `SPECIAL-USE`).
 * `null` for an ordinary folder such as `Newsletters/Tech`.
 */
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | 'archive' | null;

export interface MailFolder {
  readonly id: string;
  /** Leaf name, for example `Tech`. */
  readonly name: string;
  /** Full path with `/` separators, for example `Newsletters/Tech`. */
  readonly path: string;
  readonly role: FolderRole;
  readonly totalMessages: number;
  readonly unreadMessages: number;
}

// ---------------------------------------------------------------------------
// Change feed
// ---------------------------------------------------------------------------

export type MailChangeKind = 'created' | 'updated' | 'destroyed';

export interface MailChange {
  readonly kind: MailChangeKind;
  readonly id: string;
  readonly folder: string;
  /**
   * The cursor position *after* this change, encoded.
   *
   * The contract returns `MailChange[]` rather than a batch envelope, so each
   * change carries the position that follows it: persist the last one and a
   * resumed poll skips exactly what was already handled. Decode with
   * {@link decodeCursor}.
   */
  readonly cursor: string;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * A resume point in a folder's change feed.
 *
 * The two protocols track position in incompatible ways, so this is a
 * discriminated union rather than one shape with optional fields: a JMAP state
 * string and an IMAP `(UIDVALIDITY, UID)` pair are never interchangeable, and
 * feeding one to the other adapter must not typecheck.
 *
 * The contract passes cursors as opaque strings, so they cross the service
 * boundary through {@link encodeCursor} and {@link decodeCursor}.
 */
export type MailboxCursor =
  | {
      readonly kind: 'jmap';
      /** `Email/queryChanges` `sinceState` (RFC 8620 section 5.6). */
      readonly sinceState: string;
    }
  | {
      readonly kind: 'imap';
      /** `UIDVALIDITY`; a change means every stored UID is void (RFC 3501). */
      readonly uidValidity: number;
      readonly lastUid: number;
    };

export function encodeCursor(cursor: MailboxCursor): string {
  return cursor.kind === 'jmap'
    ? `jmap:${cursor.sinceState}`
    : `imap:${String(cursor.uidValidity)}:${String(cursor.lastUid)}`;
}

/** Decode a cursor, returning `null` for anything malformed. */
export function decodeCursor(raw: string): MailboxCursor | null {
  if (raw.startsWith('jmap:')) {
    const sinceState = raw.slice('jmap:'.length);
    return sinceState.length > 0 ? { kind: 'jmap', sinceState } : null;
  }
  if (!raw.startsWith('imap:')) return null;

  const parts = raw.slice('imap:'.length).split(':');
  if (parts.length !== 2) return null;
  const uidValidity = toUnsignedInteger(parts[0]);
  const lastUid = toUnsignedInteger(parts[1]);
  if (uidValidity === null || lastUid === null) return null;
  return { kind: 'imap', uidValidity, lastUid };
}

function toUnsignedInteger(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What the mounted adapter can actually do (PRD section 3.2).
 *
 * Consumers branch on these rather than on the adapter's identity, so a tool
 * written against the contract keeps working when the mounted adapter changes.
 */
export interface Capabilities {
  readonly push: 'jmap-push-subscription' | 'imap-idle';
  /** JMAP supports arbitrary keywords; most IMAP servers do not. */
  readonly customKeywords: boolean;
  /** Threads come from the server rather than being reconstructed client-side. */
  readonly threadNative: boolean;
  /** `x-spam-*` headers reach {@link MailMessage.spamHeaders}. */
  readonly spamHeaders: boolean;
  /**
   * A message keeps its id when it moves between folders.
   *
   * True on JMAP, false on IMAP, where a move assigns a new UID and the id a
   * plan was made against stops resolving the moment the message leaves.
   *
   * It gates the only feedback a mail agent gets. Nobody writes to say the
   * agent was wrong; the owner just moves the message back, and reading that
   * means asking where a filed message is now. Where ids are not stable, a
   * successful filing and an owner's correction look identical, so the
   * question cannot be asked at all rather than answered badly.
   */
  readonly stableIds: boolean;
}

// ---------------------------------------------------------------------------
// Outgoing mail
// ---------------------------------------------------------------------------

export interface DraftMessage {
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly bodyText: string;
  /** `Message-ID` this draft replies to, threading it on both protocols. */
  readonly inReplyTo: string | null;
  /** `References` chain to carry over, oldest first. */
  readonly references: readonly string[];
}

/**
 * The identifier out of an RFC 2919 `List-Id` header, lowercased.
 *
 * `Licence review <license-review.lists.example>` yields
 * `license-review.lists.example`. A header with no bracketed identifier is not
 * a usable list id — the description alone is free text and two lists may share
 * it — so it yields `null` rather than something that looks like an id.
 */
export function listIdOf(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const bracketed = /<([^>]+)>/.exec(header);
  const id = bracketed?.[1]?.trim().toLowerCase();
  return id === undefined || id.length === 0 ? null : id;
}
