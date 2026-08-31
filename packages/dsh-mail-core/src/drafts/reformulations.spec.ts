/**
 * The one thing that has never been refuted on this mailbox is a fact the
 * owner stated, and a rewritten draft is the densest one there is.
 */

import { describe, expect, it } from 'vitest';

import { describeReformulations, MAX_REFORMULATIONS } from './reformulations.js';

const REAL = {
  subject: 'RE: RDV 16/07',
  drafted:
    'Bonjour Monsieur Rini,\n\nMerci pour votre message. Je vous confirme avoir bien reçu votre demande.',
  wanted:
    'Bonjour,\n\nJe vous remercie de votre message et vous confirme sa bonne réception.\n\nJe reste à votre disposition si besoin.',
};

describe('the pair is shown, not summarised', () => {
  it('carries both halves verbatim', () => {
    const text = describeReformulations([REAL]) ?? '';
    expect(text).toContain('Bonjour Monsieur Rini,');
    expect(text).toContain('Je vous remercie de votre message et vous confirme sa bonne réception.');
    expect(text).toContain('RE: RDV 16/07');
  });

  it('warns against copying what the example was about', () => {
    expect(describeReformulations([REAL])).toContain('do not copy their subject matter');
  });
});

describe('how many, and which', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...REAL, subject: `sujet ${String(i)}` }));

  it('carries three, so the message being answered stays most of the prompt', () => {
    const text = describeReformulations(many) ?? '';
    expect(text).toContain('sujet 0');
    expect(text).toContain('sujet 2');
    expect(text).not.toContain('sujet 3');
    expect(MAX_REFORMULATIONS).toBe(3);
  });

  it('takes them in the order given', () => {
    const text = describeReformulations([{ ...REAL, subject: 'récent' }, ...many], 1) ?? '';
    expect(text).toContain('récent');
    expect(text).not.toContain('sujet 0');
  });
});

describe('nothing to show is nothing said', () => {
  it('reports none for an empty list', () => {
    expect(describeReformulations([])).toBe(null);
  });

  it('ignores a correction with no replacement in it', () => {
    expect(describeReformulations([{ ...REAL, wanted: '   ' }])).toBe(null);
  });

  it('still fills the quota from the ones that do have a replacement', () => {
    const list = [
      { ...REAL, subject: 'vide', wanted: '' },
      { ...REAL, subject: 'plein' },
    ];
    expect(describeReformulations(list, 1)).toContain('plein');
  });
});
