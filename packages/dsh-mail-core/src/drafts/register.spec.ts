/**
 * Read off the message being answered, not learned from the owner.
 *
 * The owner names their correspondent in 71 of 148 replies, which is neither a
 * habit nor its absence. What decides it is whether the correspondent named
 * them first, and that is a fact about one exchange.
 */

import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types.js';
import { describeRegister, greetingOf, registerOf } from './register.js';

function msg(bodyText: string | null, preview = ''): MailMessage {
  return {
    id: 'm1',
    threadId: null,
    messageId: 'm1@example.org',
    inReplyTo: [],
    references: [],
    from: [{ name: 'RINI Mathieu', email: 'rini.m@example.org' }],
    to: [],
    cc: [],
    subject: '',
    receivedAt: new Date('2026-08-29T09:00:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'INBOX',
    preview,
    bodyText,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
  };
}

describe('the greeting is carried verbatim', () => {
  it('keeps the form the correspondent chose', () => {
    // The real one. "M. Forest" is a surname with a title, and a reply that
    // opens "Bonjour Mathieu," to it has read the wrong register.
    expect(greetingOf(msg('Bonjour M. Forest,\n\nMon élu au numérique...'))).toBe('Bonjour M. Forest,');
    expect(greetingOf(msg('Bonjour Christelle,\n\nJe viens...'))).toBe('Bonjour Christelle,');
    expect(greetingOf(msg('Bonjour,\n\nJe me permets...'))).toBe('Bonjour,');
    expect(greetingOf(msg('Hello Michel,\n\nQuick one'))).toBe('Hello Michel,');
  });

  it('skips the blank lines a client puts first', () => {
    expect(greetingOf(msg('\n\n  Bonsoir Damien.\n\nLa suite'))).toBe('Bonsoir Damien.');
  });

  it('reports none when the message opens with content', () => {
    expect(greetingOf(msg('Le devis est en pièce jointe.'))).toBe(null);
  });

  it('does not read a greeting out of the quoted thread', () => {
    expect(greetingOf(msg('Merci !\n\n> Bonjour Michel-Marie,\n> voici le devis'))).toBe(null);
  });

  it('falls back to the preview when there is no text body', () => {
    expect(greetingOf(msg(null, 'Bonjour Alain, une question'))).toBe('Bonjour Alain,');
  });
});

describe('tu or vous, from what they wrote', () => {
  it('reads a familiar message', () => {
    expect(registerOf(msg('Bonjour Tomasz,\n\nPeux-tu me dire ce que tu en penses ? Merci de ta réponse.'))).toBe('tu');
  });

  it('reads a formal one', () => {
    expect(registerOf(msg('Bonjour,\n\nPouvez-vous nous confirmer votre disponibilité ?'))).toBe('vous');
  });

  it('ignores the quoted thread, which is where this goes backwards', () => {
    // A formal exchange forwarded into a familiar one, and the other way round.
    const body = 'Salut, tu peux regarder ?\n\n> Bonjour, pouvez-vous nous confirmer votre\n> disponibilité et vos horaires, avec vos coordonnées ?';
    expect(registerOf(msg(body))).toBe('tu');
  });

  it('says nothing when there is nothing to go on', () => {
    expect(registerOf(msg('Bonjour,\n\nCi-joint le document.'))).toBe(null);
  });

  it('says nothing rather than pick a side on a tie', () => {
    expect(registerOf(msg('tu vous'))).toBe(null);
  });
});

describe('what the prompt is told', () => {
  it('gives the greeting and the register together', () => {
    const text = describeRegister(msg('Bonjour M. Forest,\n\nPouvez-vous prévoir une visio ?')) ?? '';
    expect(text).toContain('They opened with "Bonjour M. Forest,"');
    expect(text).toContain('"vous"');
  });

  it('says nothing at all when the message offers neither', () => {
    expect(describeRegister(msg('Ci-joint.'))).toBe(null);
  });
});
