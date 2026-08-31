/**
 * The critic exists because the owner asked for a loop. What is tested here is
 * the part of their proposal that was changed: the loop stops on an absence of
 * faults, not on two models agreeing, and the critic cannot introduce content.
 */

import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types.js';
import {
  CRITIQUE_SYSTEM_PROMPT,
  parseFindings,
  renderCritique,
  renderRevision,
} from './critique.js';

function msg(bodyText: string): MailMessage {
  return {
    id: 'm1',
    threadId: null,
    messageId: 'm1@example.org',
    inReplyTo: [],
    references: [],
    from: [{ name: 'Eric', email: 'eric@example.org' }],
    to: [],
    cc: [],
    subject: 'Reprise ?',
    receivedAt: new Date('2026-08-24T20:36:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
  };
}

describe('only three faults exist', () => {
  it('keeps the ones it knows', () => {
    const raw = '{"findings":[{"kind":"unanswered","detail":"la question sur les modules"},{"kind":"unsupported","detail":"promet un retour lundi"}]}';
    expect(parseFindings(raw)).toStrictEqual([
      { kind: 'unanswered', detail: 'la question sur les modules' },
      { kind: 'unsupported', detail: 'promet un retour lundi' },
    ]);
  });

  it('drops a fault it was not asked for', () => {
    // A critic inventing categories is a critic proposing content.
    expect(parseFindings('{"findings":[{"kind":"tone","detail":"trop sec"}]}')).toStrictEqual([]);
    expect(parseFindings('{"findings":[{"kind":"unanswered","detail":""}]}')).toStrictEqual([]);
  });

  it('finds the object inside the prose a model wraps it in', () => {
    expect(parseFindings('Voici :\n```json\n{"findings":[]}\n```\nVoilà.')).toStrictEqual([]);
  });
});

describe('a broken critic cannot hold a draft hostage', () => {
  it('reads no findings out of an unreadable answer', () => {
    // The loop improves a draft; a critic that cannot answer must not be able
    // to stop one being delivered.
    for (const raw of ['', 'je ne sais pas', '{oops', '{"findings": "beaucoup"}']) {
      expect(parseFindings(raw)).toStrictEqual([]);
    }
  });
});

describe('the critic may not add', () => {
  it('says so in its own prompt', () => {
    expect(CRITIQUE_SYSTEM_PROMPT).toContain('you do not suggest');
    expect(CRITIQUE_SYSTEM_PROMPT).toContain('A draft that is short is not a fault');
  });

  it('tells the reviser not to invent its way out of a fault', () => {
    const text = renderRevision('Bonsoir Eric,\n\nRien.', [
      { kind: 'unanswered', detail: 'les modules' },
    ]);
    expect(text).toContain('Do not');
    expect(text).toContain('add facts, dates, names or commitments to satisfy a fault');
    expect(text).toContain('- unanswered: les modules');
  });

  it('refuses to treat agreement as the goal', () => {
    // The owner's proposal was "loop until the models agree". Agreement is not
    // in the prompt anywhere, and the empty list is what stops the loop.
    expect(CRITIQUE_SYSTEM_PROMPT).not.toMatch(/agree/i);
    expect(CRITIQUE_SYSTEM_PROMPT).toContain('An empty list means the draft is sound');
    expect(CRITIQUE_SYSTEM_PROMPT).toContain('rather than inventing a');
  });
});

describe('what the critic is shown', () => {
  it('carries the message, the instruction and the draft', () => {
    const text = renderCritique(msg('Les modules ont-ils été testés ?'), 'lui dire quon attend la commission', 'Bonsoir Eric,');
    expect(text).toContain('Les modules ont-ils été testés ?');
    expect(text).toContain('lui dire quon attend la commission');
    expect(text).toContain('Bonsoir Eric,');
  });

  it('says plainly when there was no instruction', () => {
    expect(renderCritique(msg('Bonjour'), '  ', 'Bonjour')).toContain('they only asked for a reply');
  });
});
