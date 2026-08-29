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
