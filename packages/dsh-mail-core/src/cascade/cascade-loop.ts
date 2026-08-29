/**
 * The seven-node classification cascade (PRD section 4.2).
 *
 * The nodes run in a fixed order, each cheaper than the one after it, and the
 * first one to settle a message stops the run. The point of the order is cost:
 * a message a static rule can settle must never reach the model, and the
 * returned {@link DecisionTrace} records which node settled it so that
 * property is measurable rather than assumed.
 *
 * Node 6 is the only one that leaves the process, and it stays behind the
 * `ClassifierModel` port, so the other six run (and are tested) with no
 * network. When the gateway is down the caller passes `null` and the cascade
 * runs static-only, degrading what it cannot settle to `needs-review`
 * (PRD section 3.6) rather than throwing.
 *
 * A rationale is a short sentence about *why* a node settled a message, never
 * a quote of the evidence: traces are exported to CSV and to external
 * observability, so nothing from a message body or a header value may leave
 * with one (PRD section 4.6).
 */

import type { MailAddress, MailCategory, MailMessage } from '../types.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type CascadeContext,
  type CascadeNode,
  type CascadeOptions,
  type DecisionTrace,
  type NodeVerdict,
  type TraceStep,
} from './types.js';

// ---------------------------------------------------------------------------
// Tuning constants
//
// These are the knobs the cascade keys on. They are deliberately visible here,
// not buried in a node, so a miscalibration is a one-line change that reads as
// one.
// ---------------------------------------------------------------------------

/**
 * Fallback threshold, used only when the filter does not state its own.
 *
 * rspamd's documented default is 10, and the corpus leans on it with a
 * clear-cut case at 14.8 and a grey-zone case at 5.2 that must pass through.
 * A deployment that reports `requiredScore` overrides this — the account this
 * project targets answers 15.
 */
const JUNK_SCORE = 10;

/**
 * A word of this length or more is matched against the domain's words by
 * containment as well as by equality, so `banque` in `Banque Populaire`
 * stands for `banquepopulaire.example`. Shorter words are exact matches only:
 * a short word is too generic to carry the similarity on its own.
 */
const MIN_BRAND_WORD_LENGTH = 4;

/**
 * Subject markers for transactional mail: one-time/2FA codes, receipts, order
 * and payment confirmations, invoices. Matched case-insensitively as
 * substrings. Transactional mail is never digested (PRD section 4.5).
 */
const TRANSACTIONAL_MARKERS: readonly string[] = [
  // one-time / 2FA codes
  'code de connexion',
  'code de verification',
  'code de vérification',
  "code d'identification",
  'code d identification',
  'one-time code',
  'one time code',
  'verification code',
  'otp',
  // receipts, orders, payments, invoices
  'confirmation de commande',
  'confirmation de paiement',
  'order confirmation',
  'payment confirmation',
  'votre commande',
  'reçu de commande',
  'receipt',
  'invoice',
  'facture',
];

/** Subject markers of a commercial (promo) newsletter. */
const PROMO_MARKERS: readonly string[] = [
  '%',
  'solde',
  'promotion',
  'promo',
  'offre',
  'semaine',
  'rdv',
  'réduction',
  'remise',
  'deal',
  'discount',
];

/** Subject markers of a machine-generated notification. */
const MACHINE_MARKERS: readonly string[] = [
  '[repo]',
  'pull request',
  'notification',
  'alerte',
  'alert',
  'merged',
  'deploy',
  'new issue',
  'issue #',
  'ticket #',
];

/**
 * The rationale a `List-Unsubscribe` mail is settled with, per sub-category.
 * Kept in one place so the three newsletter answers read as one decision.
 */
const NEWSLETTER_RATIONALE: Readonly<Record<'newsletter-tech' | 'newsletter-promo' | 'newsletter-notification', string>> = {
  'newsletter-tech': 'bulk newsletter with an unsubscribe link; technology edition',
  'newsletter-promo': 'commercial bulk mail with an unsubscribe link',
  'newsletter-notification': 'machine notification with an unsubscribe link',
};

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/**
 * Runs the seven nodes over one message and returns the decision trace.
 *
 * Never rejects for a message it cannot classify: an unresolvable message is a
 * `needs-review` answer, not an error, so a single odd mail cannot take down a
 * batch run.
 */
export async function runCascade(message: MailMessage, options: CascadeOptions): Promise<DecisionTrace> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now());
  const startedMs = now();
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const { context, model } = options;

  const steps: TraceStep[] = [];
  // The first node to settle the message. `null` until one does, which is how
  // the cheap nodes are stopped the moment a message is decided.
  let settled: { node: CascadeNode; verdict: NodeVerdict } | null = null;
  let usedModel = false;

  const runNode = async (node: CascadeNode, decide: () => NodeVerdict | null | Promise<NodeVerdict | null>): Promise<void> => {
    const stepStart = now();
    const result = await decide();
    // Every node that runs is recorded, in order, including those that
    // declined, so a trace shows what was considered and rejected.
    steps.push({ node, verdict: result, durationMs: Math.max(0, now() - stepStart) });
    if (result !== null && settled === null) settled = { node, verdict: result };
  };

  // 1. Thread continuity — inherit the thread's category and stop. Zero cost,
  //    which is why it must run first.
  await runNode('thread-continuity', () => threadContinuity(context));

  // 2. Spam prefilter — decided on headers, before any other logic.
  if (settled === null) await runNode('spam-prefilter', () => spamPrefilter(message));

  // 3. Learned patterns — before the static rules on purpose, so a case the
  //    owner has always filed one way is answered that way before a generic
  //    rule gets a chance (PRD section 4.2).
  if (settled === null) await runNode('learned-pattern', () => learnedPatterns(message, context));

  // 4. Static rules — VIP, corporate domains, newsletters, transactional.
  if (settled === null) await runNode('static-rule', () => staticRules(message, context));

  // A corporate sender's legitimacy is already established, so node 5 has
  // nothing to weigh: a generic display name from a known internal domain is
  // the exact shape it mistakes for an impersonation.
  const corporate = isCorporate(message, context);

  // 5. Brand spoofing — a display name claiming an identity its domain does
  //    not support, while authentication fails.
  if (settled === null && !corporate) {
    await runNode('brand-spoofing', () => brandSpoofing(message));
  }

  // 6. The model — the only node that leaves the process. It is reached only
  //    when the six above all declined, and only when one was handed in.
  if (settled === null && model !== null) {
    const stepStart = now();
    const raw = await model.classify(message, context);
    // A colleague cannot be junked or filed as a newsletter on a model's
    // say-so. Rather than substitute a category of our own, the answer
    // degrades to the honest non-answer: something is off, a person looks.
    const answer: NodeVerdict =
      corporate && BULK_CATEGORIES.includes(raw.category)
        ? {
            category: 'needs-review',
            confidence: raw.confidence,
            rationale: 'a bulk category was proposed for a corporate sender; left for review',
          }
        : raw;
    steps.push({ node: 'llm', verdict: answer, durationMs: Math.max(0, now() - stepStart) });
    usedModel = true;
    settled = { node: 'llm', verdict: answer };
  }

  // 7. Confidence threshold — apply one threshold to every answer. Below it
  //    the answer degrades to `needs-review`; a missing answer (no cheap node
  //    settled it and there is no model) degrades to the same honest
  //    non-answer.
  let finalVerdict: NodeVerdict;
  let finalDecidedBy: CascadeNode;
  const node7Start = now();
  if (settled === null) {
    finalVerdict = { category: 'needs-review', confidence: 0, rationale: 'no cheap node settled it and no model is available' };
    finalDecidedBy = 'below-threshold';
    steps.push({ node: 'below-threshold', verdict: finalVerdict, durationMs: Math.max(0, now() - node7Start) });
  } else if (settled.verdict.confidence < threshold) {
    finalVerdict = {
      category: 'needs-review',
      confidence: settled.verdict.confidence,
      rationale: 'confidence is below the threshold; left for review',
    };
    finalDecidedBy = 'below-threshold';
    steps.push({ node: 'below-threshold', verdict: finalVerdict, durationMs: Math.max(0, now() - node7Start) });
  } else {
    // At or above the threshold the answer stands; node 7 ran but declined to
    // change it, so it leaves no step (the last step stays the decider).
    finalVerdict = settled.verdict;
    finalDecidedBy = settled.node;
  }

  return {
    messageId: message.id,
    decidedBy: finalDecidedBy,
    category: finalVerdict.category,
    confidence: finalVerdict.confidence,
    rationale: finalVerdict.rationale,
    steps,
    usedModel,
    startedAt,
    durationMs: Math.max(0, now() - startedMs),
  };
}

// ---------------------------------------------------------------------------
// Nodes 1 to 5 — pure with respect to the message and context they are given.
// ---------------------------------------------------------------------------

/** Node 1: inherit the thread's category when the owner has acted in it. */
function threadContinuity(context: CascadeContext): NodeVerdict | null {
  if (context.threadCategory === null) return null;
  return {
    category: context.threadCategory,
    confidence: 1,
    rationale: 'inherits the category already assigned to this thread',
  };
}

/** Node 2: junk settles on the spam-filter score; clean and grey pass through. */
function spamPrefilter(message: MailMessage): NodeVerdict | null {
  const verdict = readSpamVerdict(message.spamHeaders);
  if (verdict !== null && verdict.score >= verdict.threshold) {
    return {
      category: 'spam-certain',
      confidence: 1,
      rationale: 'spam-filter score is past the junk threshold',
    };
  }
  // Grey (and clean) both decline: the prefilter defers them to be decided
  // later, which is exactly what node 6 exists for.
  return null;
}

/** Node 3: a learned sender or subject pattern settles the message. */
function learnedPatterns(message: MailMessage, context: CascadeContext): NodeVerdict | null {
  const sender = firstFrom(message)?.email.toLowerCase() ?? '';
  const subject = message.subject.toLowerCase();
  for (const pattern of context.learnedPatterns) {
    // Full-address equality, per the contract in `types.ts`: a pattern learned
    // for `veille@partenaire.example` must not fire on a crafted address that
    // merely contains it.
    const senderHit = pattern.sender !== null && sender === pattern.sender.toLowerCase();
    const subjectHit = pattern.subjectContains !== null && subject.includes(pattern.subjectContains.toLowerCase());
    if (senderHit || subjectHit) {
      return {
        category: pattern.category,
        confidence: pattern.confidence,
        rationale: 'matches a learned pattern for this owner',
      };
    }
  }
  return null;
}

/**
 * Node 4: the explicit rules. Order is by cost and certainty — a VIP is
 * answered before any other rule is even considered, and a transactional
 * marker is checked before a generic bulk signal, since the two are disjoint.
 *
 * A corporate domain deliberately settles nothing: it answers the
 * legitimacy question, not the category one (PRD section 4.2). Stamping
 * every message from a colleague as `standard` at confidence 1 would keep
 * node 7 from degrading it and node 6 from ever seeing it, so a message
 * from a corporate domain simply continues down the cascade.
 */
function staticRules(message: MailMessage, context: CascadeContext): NodeVerdict | null {
  const from = firstFrom(message);
  if (from !== null) {
    const email = from.email.toLowerCase();
    if (context.vipSenders.some((vip) => vip.toLowerCase() === email)) {
      return { category: 'important', confidence: 1, rationale: 'sender is on the VIP list' };
    }
  }
  if (hasAnyMarker(message.subject.toLowerCase(), TRANSACTIONAL_MARKERS)) {
    return { category: 'transactional', confidence: 1, rationale: 'transactional message (code or receipt); never digested' };
  }
  if (message.listUnsubscribe.length > 0) {
    const category = newsletterSubcategory(message);
    return { category, confidence: 1, rationale: NEWSLETTER_RATIONALE[category] };
  }
  return null;
}

/**
 * Node 5: an impersonation is an authentication problem, not a content one.
 *
 * The signal is the comparison PRD section 4.2 node 5 names: a failed
 * authentication plus a display name that claims an identity the sender's
 * own address does not support. A display name consistent with its address —
 * no matter how badly its authentication is configured — is not an
 * impersonation, so no list of "known brands" stands in for the comparison.
 */
function brandSpoofing(message: MailMessage): NodeVerdict | null {
  const from = firstFrom(message);
  if (from === null || from.name === null || from.name.trim() === '') return null;
  if (!authenticationFailed(message.spamHeaders)) return null;
  if (nameSupportedByDomain(from.name, domainOf(from.email.toLowerCase()))) return null;
  // `spam-probable`, never `spam-certain`. The comparison cannot tell an
  // impersonation from a generic display name on a badly configured relay:
  // `Support` at `zendesk.example` fails it exactly as a lookalike domain
  // does. Probable spam is junked but listed in the weekly digest, so a
  // mistake here is visible and reversible (PRD section 4.5); certain spam is
  // not, and this node has not earned that.
  return {
    category: 'spam-probable',
    confidence: 0.8,
    rationale: 'display name claims an identity the sender domain does not support, while message authentication fails',
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The first `From` address, or `null` when the message has none. */
function firstFrom(message: MailMessage): MailAddress | null {
  const from = message.from[0];
  return from === undefined ? null : from;
}

/** The domain of a lowercased address: `a@b.example` -> `b.example`. */
function domainOf(email: string): string {
  const domain = email.split('@')[1];
  return domain === undefined ? '' : domain;
}

/** The local part of a lowercased address: `a@b.example` -> `a`. */
function localPartOf(email: string): string {
  const local = email.split('@')[0];
  return local === undefined ? '' : local;
}

/**
 * Whether a display name's claimed identity is supported by the sender's
 * domain — the comparison PRD section 4.2 node 5 asks for, in place of a
 * fixed brand list.
 *
 * A name is supported when at least one of its words is backed by a word of
 * the domain: an exact match ("Boutique" against `boutique.example`), or —
 * for words of four characters or more — the word contained in a domain word
 * ("Banque" against `banquepopulaire.example`). A lookalike spelling is not
 * support: "PayPal" is not found in `paypa1-secure.example`, so the name is
 * claiming an identity the domain does not stand behind.
 *
 * Comparison is case-insensitive on normalised words, so accents and
 * punctuation do not matter.
 */
function nameSupportedByDomain(displayName: string, domain: string): boolean {
  const nameWords = normalizeWords(displayName);
  const domainWords = normalizeWords(domain);
  if (nameWords.length === 0 || domainWords.length === 0) return false;
  return nameWords.some((word) =>
    domainWords.some((dw) => dw === word || (word.length >= MIN_BRAND_WORD_LENGTH && dw.includes(word))),
  );
}

/**
 * Lowercase, strip accents, split on anything that is not a letter or digit.
 * `paypa1-secure.example` becomes `['paypa1', 'secure', 'example']`.
 */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
}

/**
 * What the spam filter concluded, and the threshold it judged against.
 *
 * Two shapes, because the PRD assumes one the target account does not use.
 * James stamps `org.apache.james.rspamd.status`:
 *
 *     No, actions=no action score=-1.307155 requiredScore=15.0
 *
 * `requiredScore` is the filter's own threshold, and reading it beats
 * hardcoding one: this deployment answers 15 where rspamd's documented default
 * is 10, so a constant would have called clean mail junk for five points.
 */
function readSpamVerdict(
  headers: Readonly<Record<string, string>>,
): { score: number; threshold: number } | null {
  const status = headers['org.apache.james.rspamd.status'];
  if (status !== undefined) {
    const score = Number.parseFloat(/score=(-?[\d.]+)/.exec(status)?.[1] ?? '');
    const required = Number.parseFloat(/requiredScore=([\d.]+)/.exec(status)?.[1] ?? '');
    if (Number.isFinite(score)) {
      return { score, threshold: Number.isFinite(required) ? required : JUNK_SCORE };
    }
  }

  const raw = headers['x-spam-score'];
  if (raw === undefined) return null;
  const score = Number.parseFloat(raw);
  return Number.isFinite(score) ? { score, threshold: JUNK_SCORE } : null;
}

/** True when any of DMARC, DKIM or SPF reports a hard failure. */
function authenticationFailed(headers: Readonly<Record<string, string>>): boolean {
  // RFC 8601: `Authentication-Results: mx.example; dmarc=fail (p=reject)
  // header.from=x; spf=softfail smtp.mailfrom=y`. The method names carry
  // qualifiers and trailing properties, so an equality test against `fail`
  // sees none of them — which is how a rule that passes on a fixture reads
  // nothing at all on the wire.
  const results = headers['authentication-results'];
  if (results !== undefined && HARD_FAIL.test(results)) return true;

  // Some filters stamp their own verdict instead, one method per header.
  for (const name of ['x-spam-dmarc', 'x-spam-dkim', 'x-spam-spf']) {
    const value = headers[name]?.toLowerCase();
    // `softfail` and `permerror` are not assertions of forgery, and treating
    // them as one is how legitimate mail behind a forwarder gets junked.
    if (value !== undefined && /^fail\b/.test(value)) return true;
  }
  return false;
}

/**
 * A hard authentication failure in an RFC 8601 result string.
 *
 * `dmarc=fail`, `dkim=fail`, `spf=fail` only. `softfail`, `neutral`, `none`,
 * `temperror` and `permerror` all say something other than "this is forged",
 * and the boundary between them is the difference between catching a spoof and
 * junking a mailing list.
 */
const HARD_FAIL = /\b(?:dmarc|dkim|spf)\s*=\s*fail\b/i;

/**
 * Whether the sender is on a domain the owner has declared corporate.
 *
 * PRD section 4.2 lists these at node 4 beside the VIPs. They answer a
 * question of *legitimacy*, not one of category: being a colleague says the
 * message is not bulk and says nothing about how urgent it is. So the list
 * settles nothing and instead removes the bulk categories from what the rest
 * of the cascade may conclude.
 */
function isCorporate(message: MailMessage, context: CascadeContext): boolean {
  const from = firstFrom(message);
  if (from === null) return false;
  const domain = domainOf(from.email.toLowerCase());
  return context.corporateDomains.some((d) => d.toLowerCase() === domain);
}

const BULK_CATEGORIES: readonly MailCategory[] = [
  'spam-certain',
  'spam-probable',
  'newsletter-tech',
  'newsletter-promo',
  'newsletter-notification',
];

/** True when a (lowercased) subject carries any of the given markers. */
function hasAnyMarker(subject: string, markers: readonly string[]): boolean {
  return markers.some((marker) => subject.includes(marker));
}

/**
 * Which newsletter sub-category a `List-Unsubscribe` mail belongs to.
 *
 * The local part of the sender is the strongest signal (a `promos@` or
 * `notifications@` address); the subject markers are a fallback for senders
 * that use a plain local part. Whatever has an unsubscribe link and no
 * stronger signal is filed as the technology digest.
 */
function newsletterSubcategory(message: MailMessage): 'newsletter-tech' | 'newsletter-promo' | 'newsletter-notification' {
  const from = firstFrom(message);
  const local = from !== null ? localPartOf(from.email.toLowerCase()) : '';
  const subject = message.subject.toLowerCase();
  if (local.includes('promo') || hasAnyMarker(subject, PROMO_MARKERS)) return 'newsletter-promo';
  if (local.includes('notif') || hasAnyMarker(subject, MACHINE_MARKERS)) return 'newsletter-notification';
  return 'newsletter-tech';
}
