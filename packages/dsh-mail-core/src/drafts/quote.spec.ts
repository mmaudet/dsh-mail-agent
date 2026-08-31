/**
 * What a draft looks like when the owner opens it.
 *
 * The first thirteen deposited had no quoted thread at all, so the owner read
 * their own answer with nothing to check it against.
 */

import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types.js';
import { attribution, quoted, withQuotedThread, MAX_QUOTED_CHARS } from './quote.js';

function msg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1',
    threadId: null,
    messageId: 'm1@example.org',
    inReplyTo: [],
    references: [],
    from: [{ name: 'Olivier Catteau', email: 'olivier@example.org' }],
    to: [],
    cc: [],
    subject: 'Sujet',
    receivedAt: new Date('2026-08-29T09:05:00'),
    sentAt: new Date('2026-08-29T09:04:00'),
    keywords: [],
    folder: 'INBOX',
    preview: 'aperçu',
    bodyText: 'Bonjour,\n\nVoici ma question.\n\nCordialement',
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...overrides,
  };
}

describe('the attribution line matches the thread it joins', () => {
  it('writes the French form', () => {
    expect(attribution(msg(), 'fr')).toBe('Le 29 août 2026 à 09:04, Olivier Catteau a écrit :');
  });

  it('writes the English form for an English reply', () => {
    expect(attribution(msg(), 'en')).toBe('On 29 August 2026 at 09:04, Olivier Catteau wrote:');
  });

  it('falls back to the address when the sender has no display name', () => {
    const anonymous = msg({ from: [{ name: null, email: 'olivier@example.org' }] });
    expect(attribution(anonymous, 'fr')).toContain('olivier@example.org');
  });

  it('uses the received time when the sender set no Date header', () => {
    // A sender controls Date and may omit it; the delivery time is the fact.
    expect(attribution(msg({ sentAt: null }), 'fr')).toContain('09:05');
  });
});

describe('the thread is quoted, not summarised', () => {
  it('prefixes every line, blank ones included', () => {
    expect(quoted(msg())).toBe('> Bonjour,\n>\n> Voici ma question.\n>\n> Cordialement');
  });

  it('quotes the preview when there is no text body', () => {
    expect(quoted(msg({ bodyText: null }))).toBe('> aperçu');
  });

  it('cuts a thread that has run away, and says so', () => {
    const long = msg({ bodyText: 'x'.repeat(MAX_QUOTED_CHARS + 500) });
    const out = quoted(long);
    expect(out).toContain('[…]');
    expect(out.length).toBeLessThan(MAX_QUOTED_CHARS + 200);
  });
});

describe('the owner’s text is left exactly as it is', () => {
  it('puts the quote under the reply, after a blank line', () => {
    const body = withQuotedThread('Bonjour,\n\nC’est noté.\n\nMichel-Marie', msg(), 'fr');
    expect(body).toMatch(/^Bonjour,\n\nC’est noté\.\n\nMichel-Marie\n\nLe 29 août/);
    expect(body).toContain('> Voici ma question.');
  });

  it('does not reflow, reword or re-sign what the owner wrote', () => {
    const reply = 'Une   ligne  avec   des espaces\net un retour.\n\nMichel-Marie';
    expect(withQuotedThread(reply, msg(), 'fr')).toContain(reply);
  });

  it('ends with a newline, as a mail body does', () => {
    expect(withQuotedThread('Bonjour.', msg(), 'fr').endsWith('\n')).toBe(true);
  });
});
