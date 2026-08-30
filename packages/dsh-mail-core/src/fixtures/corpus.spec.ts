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
  it('most cases are decided before any model call', () => {
    // PRD section 3.3 wants seven in eleven settled before the model. The
    // corpus reached 0.6 when a static rule guessed a newsletter sub-category
    // from the sender's local part; removing that rule — it was wrong on the
    // real mailbox 40 times out of 42 — cost real efficiency, and the honest
    // record of that is a lower number here rather than a rule that guesses.
    //
    // This asserts the corpus is shaped to measure the ratio, not that any
    // classifier achieves it. The number that decides the architecture is the
    // one from the real mailbox, in docs/reviews/.
    const ratio = NO_LLM_CASES.length / CORPUS.length;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
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
