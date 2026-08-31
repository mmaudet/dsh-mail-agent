/**
 * The detector exists because a rule lost to a sentence.
 *
 * What matters here is not accuracy on hard cases — it is that the answer is
 * `null` whenever it would otherwise be a guess, since `null` restores the
 * behaviour that was there before and a wrong answer overrides it.
 */

import { describe, expect, it } from 'vitest';

import { detectLanguage, languageName, unquoted } from './language.js';

describe('the two languages this mailbox contains', () => {
  it('reads a French message', () => {
    expect(
      detectLanguage('Bonjour, je vous confirme que nous sommes disponibles pour la réunion.'),
    ).toBe('fr');
  });

  it('reads an English message', () => {
    // The real one it got wrong: a partner writing about a collaboration.
    expect(
      detectLanguage('Hello, thanks for your message. We would like to discuss the platform with you.'),
    ).toBe('en');
  });

  it('is not fooled by product names and shared vocabulary', () => {
    // "collaboration", "platform", "notification" and every product name cross
    // both languages in this corpus, which is why only function words count.
    expect(
      detectLanguage(
        'Bonjour, la collaboration sur la platform Twake Visio et les notifications sont dans le scope.',
      ),
    ).toBe('fr');
  });
});

describe('it says nothing rather than guessing', () => {
  it('declines on a signature block', () => {
    expect(detectLanguage('Michel-Marie MAUDET\nLINAGORA\n+33 1 46 96 63 63')).toBe(null);
  });

  it('declines on an empty or tiny body', () => {
    expect(detectLanguage('')).toBe(null);
    expect(detectLanguage('ok')).toBe(null);
    expect(detectLanguage('Merci')).toBe(null);
  });

  it('declines on a tie rather than picking one', () => {
    expect(detectLanguage('the and for le la des')).toBe(null);
  });

  it('declines on a language it does not know', () => {
    expect(detectLanguage('Guten Tag, wir möchten über die Zusammenarbeit sprechen bitte.')).toBe(null);
  });
});

describe('only what the correspondent wrote is read', () => {
  const english = 'the and for with this that your our are is will we you from have '.repeat(60);

  it('ignores a quoted English thread under a French reply', () => {
    // Threads here accumulate for weeks, so the quoted part is routinely
    // longer than the message and often in the other language.
    const message = 'Bonjour, je vous confirme que nous sommes bien disponibles pour cette date.';
    for (const marker of ['> ', 'On Monday, someone wrote:\n', '-----Original Message-----\n', 'De : someone\n']) {
      expect(detectLanguage(`${message}\n\n${marker}${english}`)).toBe('fr');
    }
  });

  it('reads the thread when there is no covering note at all', () => {
    // A bare forward is the thread, and answering it in the thread's language
    // is right.
    expect(detectLanguage(`-----Original Message-----\n${english}`)).toBe('en');
  });

  it('keeps what was written above the quote and nothing below', () => {
    expect(unquoted('Bonjour,\n\nC’est noté.\n\n> the previous message\n> more of it')).toBe(
      'Bonjour,\n\nC’est noté.',
    );
  });
});

describe('the name goes into an English prompt', () => {
  it('names both', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('en')).toBe('English');
  });
});
