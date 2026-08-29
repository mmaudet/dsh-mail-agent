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
      'important',
      'standard',
      'newsletter-tech',
      'newsletter-promo',
      'newsletter-notification',
      'transactional',
      'spam-probable',
      'spam-certain',
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
    // PRD section 3.3: seven messages in eleven avoided the model in the
    // original corpus. This asserts the corpus itself is shaped to measure
    // that, not that a classifier achieves it.
    const ratio = NO_LLM_CASES.length / CORPUS.length;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
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
