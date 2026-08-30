import { describe, expect, it } from 'vitest';

import { toMailCategory } from '../types.js';
import { CORPUS, NO_LLM_CASES } from './corpus.js';

describe('the corpus is usable as a calibration target', () => {
  it('labels every case with a category the cascade can assign', () => {
    for (const entry of CORPUS) {
      expect(toMailCategory(entry.expected), entry.message.id).toBe(entry.expected);
    }
  });

  it('covers every category the PRD defines', () => {
    const covered = new Set(CORPUS.map((entry) => entry.expected));
    for (const category of [
      'demande-interne',
      'rapport-compte-rendu-interne',
      'veille-newsletter',
      'veille-newsletter',
      'support-technique-ticket',
      'recu-transaction',
      'phishing-arnaque',
      'phishing-arnaque',
      'needs-review',
    ]) {
      expect(covered, `no case for ${category}`).toContain(category);
    }
  });

  it('says which cascade node should decide each case', () => {
    for (const entry of CORPUS) {
      expect(entry.decidedBy, entry.message.id).toBeTruthy();
      expect(entry.because.length, entry.message.id).toBeGreaterThan(10);
    }
  });

  it('uses distinct ids, so a failure names one case', () => {
    const ids = CORPUS.map((entry) => entry.message.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the corpus contains nothing real', () => {
  it('addresses only example domains', () => {
    for (const entry of CORPUS) {
      const addresses = [...entry.message.from, ...entry.message.to, ...entry.message.cc];
      for (const address of addresses) {
        expect(address.email, entry.message.id).toMatch(/@[a-z0-9.-]*example(\.[a-z]+)?$/);
      }
    }
  });

  it('carries no linagora address, which would mean real mail leaked in', () => {
    const serialised = JSON.stringify(CORPUS);
    expect(serialised).not.toMatch(/linagora|twake|maudet/i);
  });
});

describe('the efficiency KPI has a measurable target', () => {
  it('exercises every node that can settle a message without the model', () => {
    // This replaces a ratio assertion that had been lowered twice, both times
    // for the same good reason: a static rule that guessed was removed after
    // the real mailbox showed it guessing wrong. Lowering it a third time
    // would have made it a record of the number rather than a guard on it.
    //
    // What is worth guarding is that each cheap node still has a case proving
    // it fires. The ratio itself is an artifact of which sixteen cases were
    // written; the number that decides the architecture is measured on the
    // real mailbox, in docs/reviews/.
    const cheap = ['thread-continuity', 'spam-prefilter', 'learned-pattern', 'static-rule', 'brand-spoofing'];
    for (const node of cheap) {
      expect(CORPUS.filter((entry) => entry.decidedBy === node).length).toBeGreaterThan(0);
    }
  });

  it('does not let the cheap nodes become decorative', () => {
    // A floor, not a target. Below this the cascade is a model call with extra
    // steps, and the seven-node design would need re-arguing rather than
    // re-tuning.
    const ratio = NO_LLM_CASES.length / CORPUS.length;
    expect(ratio).toBeGreaterThanOrEqual(0.4);
  });

  it('still leaves cases that genuinely need the model', () => {
    const llmCases = CORPUS.filter((entry) => entry.decidedBy === 'llm');
    expect(llmCases.length).toBeGreaterThanOrEqual(3);
  });

  it('includes a case the model should decline to classify', () => {
    const declined = CORPUS.filter((entry) => entry.expected === 'needs-review');
    expect(declined).not.toHaveLength(0);
  });
});
