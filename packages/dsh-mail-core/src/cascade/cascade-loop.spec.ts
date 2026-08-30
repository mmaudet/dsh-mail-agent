/**
 * The acceptance criterion for the cascade (PRD section 4.2).
 *
 * Written before the implementation and not by whoever implements it, because
 * every prose criterion this project has used was satisfied by something that
 * did not work. What is asserted here is the contract; how it is met is the
 * implementer's business.
 *
 * The corpus labels each case twice: the category a correct classifier answers,
 * and the node expected to settle it. Both matter. Reaching the model for
 * something a static rule covers is a regression even when the label is right,
 * and that is the only property that makes the cascade worth having.
 */

import { describe, expect, it } from 'vitest';

import { CORPUS, CORPUS_LEARNED_PATTERNS, NO_LLM_CASES } from '../fixtures/corpus.js';
import { bandOf, type MailMessage } from '../types.js';
import { runCascade } from './cascade-loop.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type CascadeContext,
  type ClassifierModel,
  type NodeVerdict,
} from './types.js';

const OWNER = 'owner@example.org';

/** The context the corpus was written against. */
const CONTEXT: CascadeContext = {
  owner: OWNER,
  vipSenders: ['ceo@corp.example.com'],
  corporateDomains: ['corp.example.com'],
  threadCategory: null,
  learnedPatterns: CORPUS_LEARNED_PATTERNS,
};

/** A model that fails the test if it is ever consulted. */
const FORBIDDEN_MODEL: ClassifierModel = {
  classify(): Promise<NodeVerdict> {
    throw new Error('the model was called for a message the cascade should have settled');
  },
};

function modelAnswering(verdict: NodeVerdict): ClassifierModel & { calls: number } {
  const model = {
    calls: 0,
    classify(): Promise<NodeVerdict> {
      model.calls += 1;
      return Promise.resolve(verdict);
    },
  };
  return model;
}

describe('the cascade settles what it can without a model', () => {
  for (const entry of NO_LLM_CASES) {
    it(`${entry.message.id}: ${entry.because}`, async () => {
      const trace = await runCascade(entry.message, {
        context: contextFor(entry.message),
        model: FORBIDDEN_MODEL,
      });

      expect(trace.category).toBe(entry.expected);
      // The node matters as much as the label: this is the cost property.
      expect(trace.decidedBy).toBe(entry.decidedBy);
      expect(trace.usedModel).toBe(false);
    });
  }

  it('never consults the model for any case a cheaper node covers', async () => {
    for (const entry of NO_LLM_CASES) {
      const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 1, rationale: 'x' });
      await runCascade(entry.message, { context: contextFor(entry.message), model });
      expect(model.calls).toBe(0);
    }
  });
});

describe('the cascade reaches the model only when the cheap nodes decline', () => {
  const llmCases = CORPUS.filter((entry) => entry.decidedBy === 'llm');

  for (const entry of llmCases) {
    it(`${entry.message.id}: ${entry.because}`, async () => {
      const model = modelAnswering({
        category: entry.expected,
        confidence: 0.9,
        rationale: 'model answer',
      });

      const trace = await runCascade(entry.message, {
        context: contextFor(entry.message),
        model,
      });

      expect(model.calls).toBe(1);
      expect(trace.decidedBy).toBe('llm');
      expect(trace.category).toBe(entry.expected);
      expect(trace.usedModel).toBe(true);
    });
  }
});

describe('node 7 degrades what the model is not sure about', () => {
  const message = CORPUS.find((entry) => entry.decidedBy === 'llm')?.message;

  it('keeps an answer at or above the threshold', async () => {
    expect(message).toBeDefined();
    const model = modelAnswering({
      category: 'demande-interne',
      confidence: DEFAULT_CONFIDENCE_THRESHOLD,
      rationale: 'exactly at the threshold',
    });

    const trace = await runCascade(message as MailMessage, { context: CONTEXT, model });
    expect(trace.category).toBe('demande-interne');
    expect(trace.decidedBy).toBe('llm');
  });

  it('degrades an answer below the threshold to needs-review', async () => {
    expect(message).toBeDefined();
    const model = modelAnswering({
      category: 'demande-interne',
      confidence: DEFAULT_CONFIDENCE_THRESHOLD - 0.01,
      rationale: 'unsure',
    });

    const trace = await runCascade(message as MailMessage, { context: CONTEXT, model });
    // PRD section 4.2 node 7: marked needs-review and left in place, never
    // acted on automatically.
    expect(trace.category).toBe('needs-review');
    expect(trace.decidedBy).toBe('below-threshold');
  });

  it('honours a threshold the caller sets', async () => {
    expect(message).toBeDefined();
    const model = modelAnswering({
      category: 'demande-interne',
      confidence: 0.5,
      rationale: 'unsure',
    });

    const trace = await runCascade(message as MailMessage, {
      context: CONTEXT,
      model,
      confidenceThreshold: 0.4,
    });
    expect(trace.category).toBe('demande-interne');
  });
});

describe('the cascade degrades to static-only when there is no model', () => {
  it('answers needs-review rather than throwing (PRD section 3.6)', async () => {
    const entry = CORPUS.find((e) => e.decidedBy === 'llm');
    expect(entry).toBeDefined();

    // The gateway health check having failed is not an error the caller has to
    // handle: the cascade runs its cheap nodes and stops.
    const trace = await runCascade(entry?.message as MailMessage, {
      context: CONTEXT,
      model: null,
    });

    expect(trace.category).toBe('needs-review');
    expect(trace.usedModel).toBe(false);
  });
});

describe('every run produces a trace that can be argued with', () => {
  it('records the nodes that ran, in order, including those that declined', async () => {
    const entry = CORPUS.find((e) => e.decidedBy === 'llm');
    expect(entry).toBeDefined();
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(entry?.message as MailMessage, { context: CONTEXT, model });

    expect(trace.messageId).toBe(entry?.message.id);
    expect(trace.steps.length).toBeGreaterThan(1);
    // Declining nodes are recorded, otherwise a trace cannot show what was
    // considered and rejected.
    expect(trace.steps.some((step) => step.verdict === null)).toBe(true);
    expect(trace.steps[trace.steps.length - 1]?.node).toBe('llm');
    expect(trace.startedAt).toBeInstanceOf(Date);
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never puts a message body or a header value in the rationale', async () => {
    for (const entry of NO_LLM_CASES) {
      const trace = await runCascade(entry.message, {
        context: contextFor(entry.message),
        model: FORBIDDEN_MODEL,
      });
      // A trace is exported to CSV and to external observability (PRD 4.6).
      // Content leaving with it is a disclosure nobody signed off on.
      const body = entry.message.bodyText;
      if (body !== null && body.length > 20) {
        expect(trace.rationale).not.toContain(body);
      }
      expect(trace.rationale.length).toBeLessThan(200);
    }
  });
});

describe('thread continuity settles a reply without any other node running', () => {
  it('inherits the thread category and stops at node 1', async () => {
    const entry = CORPUS.find((e) => e.decidedBy === 'thread-continuity');
    expect(entry).toBeDefined();

    const trace = await runCascade(entry?.message as MailMessage, {
      context: { ...CONTEXT, threadCategory: entry?.expected ?? 'demande-interne' },
      model: FORBIDDEN_MODEL,
    });

    expect(trace.decidedBy).toBe('thread-continuity');
    expect(trace.category).toBe(entry?.expected);
    expect(trace.steps).toHaveLength(1);
  });
});

/**
 * The corpus cases carry their own preconditions in `because`; this maps the
 * two that need context beyond the defaults.
 */
function contextFor(message: MailMessage): CascadeContext {
  const threadCase = CORPUS.find(
    (entry) => entry.decidedBy === 'thread-continuity' && entry.message.id === message.id,
  );
  if (threadCase !== undefined) {
    return { ...CONTEXT, threadCategory: threadCase.expected };
  }
  return CONTEXT;
}

// ---------------------------------------------------------------------------
// Round two: the findings a green suite did not see.
//
// Each of these passed the suite above while being wrong, which is the whole
// reason they are written down as tests now. Messages are built here rather
// than added to the corpus: the corpus is the labelled reference set, and
// these are regressions, not cases anyone classifies by hand.
// ---------------------------------------------------------------------------

function msg(overrides: Partial<MailMessage> & Pick<MailMessage, 'id'>): MailMessage {
  return {
    threadId: null,
    messageId: `${overrides.id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: 'Someone', email: 'someone@example.org' }],
    to: [{ name: null, email: OWNER }],
    cc: [],
    subject: '',
    receivedAt: new Date('2026-08-29T09:00:00Z'),
    sentAt: new Date('2026-08-29T08:59:00Z'),
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...overrides,
  };
}

describe('brand spoofing compares the display name to the domain', () => {
  it('catches a brand nobody put on a list', async () => {
    // PRD 4.2 node 5 asks for display-name versus domain similarity. A fixed
    // list of well-known brands only catches impersonations somebody thought
    // of; a regional bank, a supplier or the owner's own employer walk past it.
    const message = msg({
      id: 'r1',
      from: [{ name: 'Banque Populaire', email: 'securite@client-verif.attacker.test' }],
      subject: 'Vérification requise',
      spamHeaders: { 'x-spam-score': '2.4', 'x-spam-dmarc': 'fail', 'x-spam-spf': 'fail' },
    });

    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.decidedBy).toBe('brand-spoofing');
    expect(trace.category).toBe('phishing-arnaque');
  });

  it('never settles as spam-certain, whatever the mismatch', async () => {
    // The node cannot tell an impersonation from a generic display name on a
    // misconfigured relay: `Support` at `zendesk.example` fails the comparison
    // exactly as `PayPal` at `paypa1-secure.example` does. `spam-certain` is
    // junk with no review path, so this node is not entitled to it.
    for (const [name, email] of [
      ['PayPal', 'service@paypa1-secure.example'],
      ['Support', 'noreply@zendesk.example'],
      ['Newsletter', 'news@mailing.acme.example'],
    ] as const) {
      const message = msg({
        id: `r7-${name}`,
        from: [{ name, email }],
        subject: 'Sujet',
        spamHeaders: { 'x-spam-score': '2.0', 'x-spam-dmarc': 'fail' },
      });
      const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
      if (trace.decidedBy === 'brand-spoofing') {
        expect(trace.category).toBe('phishing-arnaque');
      }
    }
  });

  it('does not accuse a sender whose display name matches its own domain', async () => {
    // Authentication can fail for dull reasons — a forwarder, a misconfigured
    // relay. Without a name/domain mismatch there is no impersonation claim.
    const message = msg({
      id: 'r2',
      from: [{ name: 'Boutique', email: 'orders@boutique.example' }],
      subject: 'Votre commande',
      spamHeaders: { 'x-spam-score': '1.1', 'x-spam-dmarc': 'fail' },
    });

    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });
    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).not.toBe('brand-spoofing');
  });
});

describe('a learned pattern matches an address, not a substring of one', () => {
  it('refuses an address that merely contains the learned one', async () => {
    // Learned patterns accumulate from observed traffic, so an attacker who can
    // guess a trusted sender can craft an address that contains it. The VIP
    // rule in the same file already compares for equality.
    const message = msg({
      id: 'r3',
      from: [{ name: 'Veille', email: 'x-veille@partenaire.example.attacker.test' }],
      subject: 'Revue hebdo des publications',
    });

    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });
    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).not.toBe('learned-pattern');
  });

  it('still matches the address it learned', async () => {
    const message = msg({
      id: 'r4',
      from: [{ name: 'Veille Interne', email: 'veille@partenaire.example' }],
      subject: 'Revue hebdo des publications',
    });

    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.decidedBy).toBe('learned-pattern');
    expect(trace.category).toBe('veille-newsletter');
  });
});

describe('a corporate domain is a legitimacy signal, not a category', () => {
  it('does not settle an internal message as standard on the domain alone', async () => {
    // Settling here at confidence 1 means node 7 cannot degrade it and the
    // model never sees it: every message from a colleague reads as
    // informational, and an urgent internal request is filed like a company
    // newsletter. Legitimacy and category are two judgements.
    const message = msg({
      id: 'r5',
      from: [{ name: 'Collègue', email: 'collegue@corp.example.com' }],
      subject: 'Peux-tu valider le budget avant 17h ?',
      bodyText: 'Il me faut ton accord aujourd hui.',
    });

    const model = modelAnswering({ category: 'demande-interne', confidence: 0.9, rationale: 'r' });
    const trace = await runCascade(message, { context: CONTEXT, model });

    expect(model.calls).toBe(1);
    expect(trace.decidedBy).toBe('llm');
    expect(trace.category).toBe('demande-interne');
  });

  it('still recognises a transactional message from a corporate domain', async () => {
    // PRD 4.5 treats transactional specially — never digested, archived after a
    // day — so misfiling it as standard has consequences downstream.
    const message = msg({
      id: 'r6',
      from: [{ name: 'IT', email: 'noreply@corp.example.com' }],
      subject: 'Votre code de connexion : 774213',
    });

    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.category).toBe('recu-transaction');
    expect(trace.decidedBy).toBe('static-rule');
  });
});

describe('a corporate domain excludes the bulk categories without settling one', () => {
  const COLLEAGUE = { name: 'Collègue', email: 'collegue@corp.example.com' };

  it('never lets a colleague be filed as spam, whatever the model answers', async () => {
    // The purpose of the corporate list at node 4 (PRD section 4.2): a
    // guarantee of legitimacy, not a judgement of content. A message from
    // inside the company cannot end up in Junk on a model's say-so.
    const model = modelAnswering({ category: 'phishing-arnaque', confidence: 0.95, rationale: 'r' });
    const message = msg({ id: 'r8', from: [COLLEAGUE], subject: 'Offre exceptionnelle' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.category).not.toBe('phishing-arnaque');
    expect(trace.category).not.toBe('phishing-arnaque');
  });

  it('never lets a colleague be trashed as cold prospecting', async () => {
    // The exclusion narrowed with the vocabulary, and narrowed to the part
    // that can hurt. A colleague's internal newsletter landing in `Veille` is
    // a filing mistake the owner can undo; a colleague's mail landing in the
    // trash because the model read it as a sales pitch is the one that matters,
    // and it is now the only automatic destructive action there is.
    const model = modelAnswering({
      category: 'prospection-commerciale-non-sollicitee',
      confidence: 0.95,
      rationale: 'r',
    });
    const message = msg({ id: 'r9', from: [COLLEAGUE], subject: 'Notre nouvelle offre' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.category).not.toBe('prospection-commerciale-non-sollicitee');
    expect(bandOf(trace.category)).not.toBe('drops');
  });

  it('is not accused of spoofing, since its legitimacy is already established', async () => {
    // A generic display name from a known corporate domain is the exact shape
    // node 5 mistakes for an impersonation.
    const message = msg({
      id: 'r10',
      from: [{ name: 'Équipe Sécurité', email: 'securite@corp.example.com' }],
      subject: 'Rappel: mise à jour',
      spamHeaders: { 'x-spam-score': '1.0', 'x-spam-dmarc': 'fail' },
    });
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).not.toBe('brand-spoofing');
  });

  it('still lets the model answer a non-bulk category', async () => {
    // Excluding bulk is not deciding: the model still settles the message.
    const model = modelAnswering({ category: 'demande-interne', confidence: 0.9, rationale: 'r' });
    const message = msg({ id: 'r11', from: [COLLEAGUE], subject: 'Peux-tu valider avant 17h ?' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).toBe('llm');
    expect(trace.category).toBe('demande-interne');
  });
});

describe('authentication is read as servers actually write it', () => {
  function withHeaders(id: string, spamHeaders: Record<string, string>): MailMessage {
    return msg({
      id,
      from: [{ name: 'PayPal', email: 'service@paypa1-secure.example' }],
      subject: 'Votre compte',
      spamHeaders,
    });
  }

  it('reads a hard failure out of an RFC 8601 Authentication-Results', async () => {
    // The real shape, qualifiers and all. An equality test against `fail`
    // matches none of this, which is how a node that passes on a fixture reads
    // nothing at all on the wire.
    const message = withHeaders('r12', {
      'authentication-results':
        'mx.example.com; dmarc=fail (p=reject dis=none) header.from=paypal.com; dkim=none',
    });

    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.decidedBy).toBe('brand-spoofing');
  });

  it('does not read softfail, neutral or none as forgery', async () => {
    // A forwarder breaks SPF routinely. Treating that as an impersonation is
    // how a mailing list ends up in Junk.
    for (const results of [
      'mx.example.com; spf=softfail smtp.mailfrom=example.com',
      'mx.example.com; dmarc=none; dkim=neutral',
      'mx.example.com; spf=temperror',
    ]) {
      const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });
      const trace = await runCascade(withHeaders('r13', { 'authentication-results': results }), {
        context: CONTEXT,
        model,
      });
      expect(trace.decidedBy).not.toBe('brand-spoofing');
    }
  });

  it('still reads a filter that stamps one verdict per header', async () => {
    const trace = await runCascade(withHeaders('r14', { 'x-spam-dmarc': 'fail (p=reject)' }), {
      context: CONTEXT,
      model: FORBIDDEN_MODEL,
    });
    expect(trace.decidedBy).toBe('brand-spoofing');
  });

  it('does not read a per-header softfail as forgery either', async () => {
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });
    const trace = await runCascade(withHeaders('r15', { 'x-spam-spf': 'softfail' }), {
      context: CONTEXT,
      model,
    });
    expect(trace.decidedBy).not.toBe('brand-spoofing');
  });
});

describe('the prefilter reads the filter the server actually runs', () => {
  it('reads James rspamd status, and the threshold it states', async () => {
    // The account this project targets stamps this, and nothing matching
    // `x-spam-score` at all. The PRD assumes the other convention.
    const message = msg({
      id: 'r16',
      subject: 'Vous avez gagné',
      spamHeaders: {
        'org.apache.james.rspamd.flag': 'YES',
        'org.apache.james.rspamd.status': 'Yes, actions=reject score=22.4 requiredScore=15.0',
      },
    });

    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.decidedBy).toBe('spam-prefilter');
    expect(trace.category).toBe('phishing-arnaque');
  });

  it('honours a threshold above the documented default', async () => {
    // 12 is junk under rspamd's documented 10 and clean under this server's
    // stated 15. Hardcoding the default would junk it.
    const message = msg({
      id: 'r17',
      spamHeaders: {
        'org.apache.james.rspamd.status': 'No, actions=no action score=12.0 requiredScore=15.0',
      },
    });
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).not.toBe('spam-prefilter');
  });

  it('falls back to the documented default when the filter states none', async () => {
    const message = msg({ id: 'r18', spamHeaders: { 'x-spam-score': '11.2' } });
    const trace = await runCascade(message, { context: CONTEXT, model: FORBIDDEN_MODEL });
    expect(trace.decidedBy).toBe('spam-prefilter');
  });

  it('lets a negative score through, which is what most mail carries', async () => {
    const message = msg({
      id: 'r19',
      spamHeaders: {
        'org.apache.james.rspamd.status': 'No, actions=no action score=-1.307155 requiredScore=15.0',
      },
    });
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).not.toBe('spam-prefilter');
  });
});

describe('bulk mail with no sub-category signal is not guessed at', () => {
  it('declines rather than defaulting a mailing list to a tech newsletter', async () => {
    // Measured on the target inbox: 40 of 42 bulk messages matched no
    // sub-category signal, and the default was filing a mailing list, a
    // support case and a traffic-fine notice as a technology newsletter — at
    // confidence 1, which node 7 cannot degrade and the model never reviews.
    const message = msg({
      id: 'r20',
      from: [{ name: 'License Review', email: 'license-review@lists.example' }],
      subject: 'Re: [License-review] For Approval: OpenMDW License Agreement',
      listUnsubscribe: ['https://lists.example/unsub'],
    });
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(message, { context: CONTEXT, model });
    expect(trace.decidedBy).toBe('llm');
    expect(trace.category).toBe('rapport-compte-rendu-interne');
  });

  it('sends bulk to the model rather than guessing which bulk it is', async () => {
    // The rule this replaces read the sender's local part and the subject for
    // a newsletter sub-category. On the target inbox 40 of 42 bulk messages
    // matched nothing, and the two it answered were wrong.
    //
    // What makes declining necessary rather than merely honest: the two bulk
    // categories are handled in opposite directions. Subscribed editorial is
    // filed; cold prospecting is trashed unattended. `List-Unsubscribe` is on
    // both, and the question that separates them — did the owner ask for it —
    // is not in any header.
    for (const subject of ['Weekly digest #42', '-40% ce week-end', 'Alerte sur votre dépôt']) {
      const message = msg({
        id: `r21-${subject}`,
        from: [{ name: 'Bulk', email: 'hello@bulk.example' }],
        subject,
        listUnsubscribe: ['https://bulk.example/u'],
      });
      const model = modelAnswering({ category: 'veille-newsletter', confidence: 0.9, rationale: 'r' });
      const trace = await runCascade(message, { context: CONTEXT, model });
      expect(trace.decidedBy).toBe('llm');
    }
  });

  it('sends a List-Id to the model too, rather than assuming it is a list', () => {
    // Measured on 400 real messages: 84 carry `List-Id` and 19 are list
    // traffic. Every bulk sender sets the header, including a company's own
    // `vente@` alias.
    return runCascade(
      msg({ id: 'r22', listId: 'campaign.list-id.mailin.fr', subject: 'Notre offre du mois' }),
      {
        context: CONTEXT,
        model: modelAnswering({ category: 'veille-newsletter', confidence: 0.9, rationale: 'r' }),
      },
    ).then((trace) => {
      expect(trace.decidedBy).toBe('llm');
    });
  });

  it('settles a list it has learned, which is where List-Id belongs', () => {
    // Of 36 distinct `List-Id` values in that sample, zero were sometimes list
    // traffic and sometimes not. Consistency per value is what node 3 learns
    // under, so the header earns its answer instead of asserting one.
    return runCascade(
      msg({ id: 'r22b', listId: 'discuss.lists.example', subject: 'Re: a thread' }),
      {
        context: {
          ...CONTEXT,
          learnedPatterns: [
            { listId: 'discuss.lists.example', sender: null, subjectContains: null, category: 'liste-diffusion', confidence: 0.9 },
          ],
        },
        model: FORBIDDEN_MODEL,
      },
    ).then((trace) => {
      expect(trace.decidedBy).toBe('learned-pattern');
      expect(trace.category).toBe('liste-diffusion');
    });
  });
});

describe('node 3 recognises a mailing list', () => {
  const LIST = 'license-review.lists.example';

  it('settles a list posting whoever sent it', async () => {
    const message = msg({
      id: 'r22',
      from: [{ name: 'Someone New', email: 'never-seen@example.org' }],
      subject: 'Re: For Approval',
      listId: LIST,
    });

    const trace = await runCascade(message, {
      context: {
        ...CONTEXT,
        learnedPatterns: [
          { listId: LIST, sender: null, subjectContains: null, category: 'rapport-compte-rendu-interne', confidence: 0.9 },
        ],
      },
      model: FORBIDDEN_MODEL,
    });

    expect(trace.decidedBy).toBe('learned-pattern');
    expect(trace.category).toBe('rapport-compte-rendu-interne');
  });

  it('does not settle a message from another list', async () => {
    const message = msg({ id: 'r23', listId: 'other.lists.example', subject: 'Hello' });
    const model = modelAnswering({ category: 'rapport-compte-rendu-interne', confidence: 0.9, rationale: 'r' });

    const trace = await runCascade(message, {
      context: {
        ...CONTEXT,
        learnedPatterns: [
          { listId: LIST, sender: null, subjectContains: null, category: 'demande-interne', confidence: 0.9 },
        ],
      },
      model,
    });

    // Nothing has been learned about this list, and no static rule claims it,
    // so it reaches the model. What matters is that the pattern learned for
    // one list did not leak onto another.
    expect(trace.decidedBy).toBe('llm');
  });
});
