/**
 * The critique loop, turned around.
 *
 * It found fifteen unanswered questions and fixed none, because the answers
 * were never in the owner's instruction. Asking before the draft exists puts
 * the same question to the person who has the answer.
 */

import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types.js';
import { ASKED_SYSTEM_PROMPT, MAX_ASKS, parseAsks, renderAsked } from './asked.js';

function msg(bodyText: string | null, preview = ''): MailMessage {
  return {
    id: 'm1',
    threadId: null,
    messageId: 'm1@example.org',
    inReplyTo: [],
    references: [],
    from: [{ name: 'ESPOSITO Eric', email: 'eric@example.org' }],
    to: [],
    cc: [],
    subject: 'Reprise ?',
    receivedAt: new Date('2026-08-24T20:36:00Z'),
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

describe('the list is short and bounded', () => {
  it('keeps what was asked', () => {
    expect(parseAsks('{"asks":["si les modules ont été testés","si l\'espace de démos est utilisé"]}')).toStrictEqual([
      'si les modules ont été testés',
      "si l'espace de démos est utilisé",
    ]);
  });

  it('stops at four, because beyond that it is a document', () => {
    const many = JSON.stringify({ asks: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(parseAsks(many)).toHaveLength(MAX_ASKS);
  });

  it('drops blanks rather than showing an empty bullet', () => {
    expect(parseAsks('{"asks":["une visio","","   "]}')).toStrictEqual(['une visio']);
  });

  it('finds the object inside the prose a model wraps it in', () => {
    expect(parseAsks('Voici :\n```json\n{"asks":["signer le devis"]}\n```')).toStrictEqual(['signer le devis']);
  });
});

describe('a message that asks nothing says so', () => {
  it('reads an empty list as an empty list', () => {
    expect(parseAsks('{"asks":[]}')).toStrictEqual([]);
  });

  it('reads an unreadable answer as nothing asked', () => {
    // Showing the owner an invented question is worse than showing none.
    for (const raw of ['', 'rien de particulier', '{oops', '{"asks":"beaucoup"}']) {
      expect(parseAsks(raw)).toStrictEqual([]);
    }
  });

  it('tells the model that nothing is the common case', () => {
    expect(ASKED_SYSTEM_PROMPT).toContain('which is the common case');
    expect(ASKED_SYSTEM_PROMPT).toContain('Do not invent an implied request');
  });
});

describe('what the model reads', () => {
  it('is what the correspondent wrote, not the thread they quoted', () => {
    const text = renderAsked(msg('Peux-tu me dire si les modules ont été testés ?\n\n> Bonjour, voici le point\n> précédent sur le sujet'));
    expect(text).toContain('les modules ont été testés');
    expect(text).not.toContain('point');
  });

  it('falls back to the whole body when there is no covering note', () => {
    // A bare forward is the thread, and the request is inside it.
    expect(renderAsked(msg('-----Original Message-----\nPouvez-vous signer ?'))).toContain('signer');
  });

  it('falls back to the preview when there is no text body', () => {
    expect(renderAsked(msg(null, 'Merci de confirmer la date'))).toContain('confirmer la date');
  });
});
