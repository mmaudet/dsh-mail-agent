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

import { bandOf, type MailAddress, type MailCategory, type MailMessage } from '../types.js';
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

/**
 * The rationale a `List-Unsubscribe` mail is settled with, per sub-category.
 * Kept in one place so the three newsletter answers read as one decision.
 */

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

  // 2b. Stated routes — what the owner told the agent, before anything it
  //     worked out for itself. Ahead of the learned patterns because an
  //     inference should never overrule an assertion, and ahead of the static
  //     rules because every generic rule tried on this mailbox turned out to
  //     be guessing (`List-Unsubscribe`, then `List-Id`) while a table of
  //     owner-stated routes covers 33% of it.
  if (settled === null) await runNode('stated-route', () => statedRoute(message, context));

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
    // The one node that leaves the process, and so the one that can fail for
    // reasons having nothing to do with the message: a rate limit, an expired
    // token, a gateway with a lapsed certificate.
    //
    // This block used to be unguarded while the comment above it claimed a
    // failing model was an answer rather than an error. The first real run
    // found the difference — one 429 on one message ended the pass and the
    // process with it.
    //
    // The failure is answered, not swallowed. `needs-review` is what the
    // cascade says when it does not know, the rationale names the cause so an
    // outage is legible in the traces rather than looking like a day of
    // unusually ambiguous mail, and `usedModel` stays true because the call
    // did leave the process and a failed call must not read as a free settle.
    let raw: NodeVerdict;
    try {
      raw = await model.classify(message, context);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      raw = {
        category: 'needs-review',
        confidence: 0,
        rationale: `the model could not be reached: ${cause.slice(0, 120)}`,
      };
    }
    // A colleague cannot be junked or filed as a newsletter on a model's
    // say-so. Rather than substitute a category of our own, the answer
    // degrades to the honest non-answer: something is off, a person looks.
    const answer: NodeVerdict =
      corporate && isDropped(raw.category)
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
      // A verdict that is already `needs-review` keeps its own reason.
      // Degrading it to `needs-review` adds nothing and would erase why —
      // and the reason that matters most is the one node 6 writes when it
      // could not reach the model at all, which arrives here at confidence 0
      // and would otherwise read as a message nobody could classify.
      rationale:
        settled.verdict.category === 'needs-review'
          ? settled.verdict.rationale
          : 'confidence is below the threshold; left for review',
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
    // A filter score says the message is unwanted; it does not say which of
    // the three unwanted kinds. That costs nothing here, because
    // `phishing-arnaque` and `spam-formulaire-contact` are handled
    // identically — both to Junk, both asking above 0.9 — and the third,
    // cold prospecting, does not usually trip a filter at all. Where the
    // distinction would matter, it is `prospection` that is trashed, and a
    // filter hit is evidence against it being that.
    return {
      category: 'phishing-arnaque',
      confidence: 1,
      rationale: 'spam-filter score is past the junk threshold',
    };
  }
  // Grey (and clean) both decline: the prefilter defers them to be decided
  // later, which is exactly what node 6 exists for.
  return null;
}

/**
 * Node 2b: a route the owner stated settles the message, at confidence 1.
 *
 * Confidence 1 without qualification, which no inferring node is allowed:
 * the owner is not guessing about their own mail. It means node 7 cannot
 * degrade it and the approval floors are all cleared — a stated route is the
 * one path where an owner can arm an automatic action deliberately.
 *
 * A `List-Id` route wins over a sender route for the same message, matching
 * the key `MailStore` stores them under: a list is what has the category, and
 * its messages come from many senders.
 */
function statedRoute(message: MailMessage, context: CascadeContext): NodeVerdict | null {
  if (context.statedRoutes.length === 0) return null;
  const listId = message.listId?.toLowerCase() ?? null;
  const sender = firstFrom(message)?.email.toLowerCase() ?? null;

  const byList = listId === null
    ? undefined
    : context.statedRoutes.find(
        (r) => r.listId !== null && r.listId !== undefined && r.listId.toLowerCase() === listId,
      );
  const hit = byList ?? (sender === null
    ? undefined
    : context.statedRoutes.find((r) => r.sender !== null && r.sender.toLowerCase() === sender));
  if (hit === undefined) return null;

  return {
    category: hit.category,
    confidence: 1,
    rationale: hit.note ?? (byList === undefined
      ? 'the owner routes this sender here'
      : 'the owner routes this mailing list here'),
  };
}

/** Node 3: a learned sender or subject pattern settles the message. */
function learnedPatterns(message: MailMessage, context: CascadeContext): NodeVerdict | null {
  const sender = firstFrom(message)?.email.toLowerCase() ?? '';
  const subject = message.subject.toLowerCase();
  const listId = message.listId?.toLowerCase() ?? null;
  for (const pattern of context.learnedPatterns) {
    // A list id is the strongest of the three: it names a source, where a
    // sender names one participant in it.
    const listHit =
      pattern.listId !== null &&
      pattern.listId !== undefined &&
      listId !== null &&
      listId === pattern.listId.toLowerCase();
    // Full-address equality, per the contract in `types.ts`: a pattern learned
    // for `veille@partenaire.example` must not fire on a crafted address that
    // merely contains it.
    const senderHit = pattern.sender !== null && sender === pattern.sender.toLowerCase();
    const subjectHit = pattern.subjectContains !== null && subject.includes(pattern.subjectContains.toLowerCase());
    if (listHit || senderHit || subjectHit) {
      return {
        category: pattern.category,
        confidence: pattern.confidence,
        rationale: listHit
          ? 'matches a learned mailing list for this owner'
          : 'matches a learned pattern for this owner',
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
      // A VIP is a person the owner answers. Which kind of answer depends on
      // which side of the company they write from, and that is the one thing
      // the address settles on its own.
      return isCorporate(message, context)
        ? { category: 'demande-interne', confidence: 1, rationale: 'sender is a colleague on the VIP list' }
        : { category: 'correspondance-commerciale-client', confidence: 1, rationale: 'sender is on the VIP list' };
    }
  }
  if (hasAnyMarker(message.subject.toLowerCase(), TRANSACTIONAL_MARKERS)) {
    return { category: 'recu-transaction', confidence: 1, rationale: 'a receipt or a code: money that has already moved' };
  }
  // `List-Id` deliberately settles nothing either, and the reason is the same
  // one that removed the rule below it — found the same way, by running it.
  //
  // "A list is a list whatever it carries" is false on real mail. Every bulk
  // sender sets `List-Id`: Mailchimp, Sendinblue, Google Alerts, a company's
  // own `vente@` alias. Measured on 400 messages, 84 carry the header and 19
  // are list traffic — 77% wrong, at confidence 1, where node 7 cannot degrade
  // it and the model never reviews it.
  //
  // Requiring the message to be a reply catches all 19 and cuts the rest to
  // about 18, which is still only half right.
  //
  // What the same measurement says instead: of 36 distinct `List-Id` values,
  // **zero** are sometimes list traffic and sometimes not. Each value is
  // consistently one or the other, which is exactly the condition node 3
  // learns under — it groups by `List-Id` first and requires unanimity. So
  // this is earned per list rather than assumed from the header, and a cold
  // agent simply asks the model until it has seen a list three times.

  // `List-Unsubscribe` deliberately settles nothing, though it is the more
  // common header by far.
  //
  // It proves the message is bulk and stops there, and the two bulk
  // categories it could mean are handled in opposite directions: subscribed
  // editorial content is filed and read, cold prospecting is trashed without
  // asking. Separating them is the question of whether the owner ever asked
  // for it, which no header records — so it goes to node 6, which can read
  // the difference between an editorial and a sales pitch.
  //
  // This costs efficiency and buys correctness. The previous version of this
  // rule guessed a newsletter sub-category from the sender's local part, and
  // on the target inbox 40 of 42 bulk messages matched nothing while the two
  // it did answer were wrong: a mailing list, an OVH support case and a
  // traffic-fine notice, all filed as a technology newsletter at confidence 1,
  // where node 7 cannot degrade them and the model never reviews them.
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
  // Confidence 0.8, deliberately below the 0.9 the policy needs to file
  // anything into Junk. The comparison cannot tell an impersonation from a
  // generic display name on a badly configured relay: `Support` at
  // `zendesk.example` fails it exactly as a lookalike domain does. This node
  // marks and reports; it does not file. Node 2, which reads a filter's score
  // rather than inferring one, answers 1 and does.
  return {
    category: 'phishing-arnaque',
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

/**
 * What a message from a colleague may never be called.
 *
 * The `drops` band is the whole of it: a colleague's mail is not junked, not
 * trashed and not called prospecting, whatever else the cascade thinks. The
 * band is read rather than listed, so a category added to it later is covered
 * without anyone remembering to come back here.
 */
function isDropped(category: MailCategory): boolean {
  return bandOf(category) === 'drops';
}

/** True when a (lowercased) subject carries any of the given markers. */
function hasAnyMarker(subject: string, markers: readonly string[]): boolean {
  return markers.some((marker) => subject.includes(marker));
}
