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

import type { MailAddress, MailMessage } from '../types.js';
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
 * A spam-filter score at or past this is settled as junk, on the prefilter
 * alone. rspamd's default junk threshold is 10; the corpus leans on it with a
 * clear-cut case at 14.8 and a grey-zone case at 5.2 that must pass through.
 */
const JUNK_SCORE = 10;

/**
 * Display names that, paired with an authentication failure, read as a brand
 * impersonation. Matched case-insensitively as a substring of the display
 * name, so "PayPal" and "PayPal Security Team" both trip it.
 */
const SPOOFED_BRANDS: readonly string[] = [
  'paypal',
  'amazon',
  'apple',
  'google',
  'microsoft',
  'visa',
  'mastercard',
  'american express',
  'amex',
  'bank of america',
  'chase',
  'citibank',
  'western union',
  'icloud',
  'netflix',
  'linkedin',
  'facebook',
  'instagram',
  'twitter',
];

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

  // 5. Brand spoofing — a display name claiming a brand while auth fails.
  if (settled === null) await runNode('brand-spoofing', () => brandSpoofing(message));

  // 6. The model — the only node that leaves the process. It is reached only
  //    when the six above all declined, and only when one was handed in.
  if (settled === null && model !== null) {
    const stepStart = now();
    const answer = await model.classify(message, context);
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
  const score = readSpamScore(message.spamHeaders);
  if (score !== null && score >= JUNK_SCORE) {
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
    const senderHit = pattern.sender !== null && sender.includes(pattern.sender.toLowerCase());
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
 */
function staticRules(message: MailMessage, context: CascadeContext): NodeVerdict | null {
  const from = firstFrom(message);
  if (from !== null) {
    const email = from.email.toLowerCase();
    if (context.vipSenders.some((vip) => vip.toLowerCase() === email)) {
      return { category: 'important', confidence: 1, rationale: 'sender is on the VIP list' };
    }
    const domain = domainOf(email);
    if (context.corporateDomains.some((d) => d.toLowerCase() === domain)) {
      // A known corporate sender is legitimate, not urgent by itself, so it
      // settles as `standard` rather than inflating to `important`.
      return { category: 'standard', confidence: 1, rationale: 'sender is on a known corporate domain' };
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
 * Node 5: a brand impersonation is an authentication problem, not a content
 * one. It needs both a display name that claims a known brand and a failed
 * authentication result, so a legitimate sender whose DMARC is merely "none"
 * is never caught.
 */
function brandSpoofing(message: MailMessage): NodeVerdict | null {
  const displayName = firstFrom(message)?.name?.toLowerCase() ?? '';
  const claimsBrand = SPOOFED_BRANDS.some((brand) => displayName.includes(brand));
  if (claimsBrand && authenticationFailed(message.spamHeaders)) {
    return {
      category: 'spam-certain',
      confidence: 1,
      rationale: 'display name claims a brand while message authentication fails',
    };
  }
  return null;
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

/** The numeric spam-filter score, or `null` when absent or unparseable. */
function readSpamScore(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['x-spam-score'];
  if (raw === undefined) return null;
  const score = Number.parseFloat(raw);
  return Number.isFinite(score) ? score : null;
}

/** True when any of DMARC, DKIM or SPF reports a hard failure. */
function authenticationFailed(headers: Readonly<Record<string, string>>): boolean {
  for (const name of ['x-spam-dmarc', 'x-spam-dkim', 'x-spam-spf']) {
    const value = headers[name];
    if (value !== undefined && value.toLowerCase() === 'fail') return true;
  }
  return false;
}

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
