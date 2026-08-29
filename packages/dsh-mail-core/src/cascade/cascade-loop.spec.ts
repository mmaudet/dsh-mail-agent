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
import type { MailMessage } from '../types.js';
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
      const model = modelAnswering({ category: 'standard', confidence: 1, rationale: 'x' });
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
      category: 'important',
      confidence: DEFAULT_CONFIDENCE_THRESHOLD,
      rationale: 'exactly at the threshold',
    });

    const trace = await runCascade(message as MailMessage, { context: CONTEXT, model });
    expect(trace.category).toBe('important');
    expect(trace.decidedBy).toBe('llm');
  });

  it('degrades an answer below the threshold to needs-review', async () => {
    expect(message).toBeDefined();
    const model = modelAnswering({
      category: 'important',
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
      category: 'important',
      confidence: 0.5,
      rationale: 'unsure',
    });

    const trace = await runCascade(message as MailMessage, {
      context: CONTEXT,
      model,
      confidenceThreshold: 0.4,
    });
    expect(trace.category).toBe('important');
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
    const model = modelAnswering({ category: 'standard', confidence: 0.9, rationale: 'r' });

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
      context: { ...CONTEXT, threadCategory: entry?.expected ?? 'important' },
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
    expect(trace.category).toBe('spam-certain');
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

    const model = modelAnswering({ category: 'standard', confidence: 0.9, rationale: 'r' });
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

    const model = modelAnswering({ category: 'standard', confidence: 0.9, rationale: 'r' });
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
    expect(trace.category).toBe('newsletter-tech');
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

    const model = modelAnswering({ category: 'important', confidence: 0.9, rationale: 'r' });
    const trace = await runCascade(message, { context: CONTEXT, model });

    expect(model.calls).toBe(1);
    expect(trace.decidedBy).toBe('llm');
    expect(trace.category).toBe('important');
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
    expect(trace.category).toBe('transactional');
    expect(trace.decidedBy).toBe('static-rule');
  });
});
