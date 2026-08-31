/**
 * Drafting, and the one thing that turned it from a demo into a tool.
 *
 * Drafts written from the message alone came back right in style and empty in
 * substance (`docs/reviews/drafts-against-the-answer-key.md`): what to say was
 * never in the message. The owner now supplies it in one line, spoken or
 * typed, and that line is also the only authority a draft has to commit
 * anything — which is what most of this file is about.
 */

import { describe, expect, it } from 'vitest';

import type { MailMessage } from '../types.js';
import type { StyleProfile } from './style-profile.js';
import {
  cleanDraft,
  draftReply,
  draftable,
  renderDraftRequest,
  DRAFT_SYSTEM_PROMPT,
  type DraftModel,
  type DraftRequest,
} from './draft-reply.js';

const STYLE: StyleProfile = {
  medianWords: 42,
  shortWords: 21,
  openings: ['Bonjour'],
  signOff: 'Michel-Marie',
  languages: ['fr'],
  addressesByName: true,
  examples: ['Bonjour, c’est noté, je reviens vers vous demain. Michel-Marie'],
  sampledFrom: 30,
};

function msg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1',
    threadId: null,
    messageId: 'm1@example.org',
    inReplyTo: [],
    references: [],
    from: [{ name: 'Stéphane', email: 'stephane@example.org' }],
    to: [{ name: null, email: 'owner@example.org' }],
    cc: [],
    subject: 'Arrivée mardi',
    receivedAt: new Date('2026-08-29T09:00:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'INBOX',
    preview: 'aperçu',
    bodyText: 'Bonjour, je confirme mon arrivée. À quelle heure dois-je me présenter ?',
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...overrides,
  };
}

function request(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    message: msg(),
    category: 'demande-interne',
    style: STYLE,
    owner: 'owner@example.org',
    ...overrides,
  };
}

const saying = (text: string): DraftModel & { readonly seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    draft(req: DraftRequest): Promise<string> {
      seen.push(renderDraftRequest(req));
      return Promise.resolve(text);
    },
  };
};

describe("the owner's instruction is what to say", () => {
  it('puts it after the message, not before it', () => {
    // A rule stated before four thousand characters of somebody else's prose
    // is held less well than one stated immediately before the writing.
    const rendered = renderDraftRequest(request({ instruction: 'lui dire de venir à 9h' }));
    expect(rendered.indexOf('lui dire de venir à 9h')).toBeGreaterThan(
      rendered.indexOf('À quelle heure'),
    );
    expect(rendered).toContain('The owner says to answer this');
  });

  it('says what the category is when there is no instruction', () => {
    const rendered = renderDraftRequest(request());
    expect(rendered).toContain('classified demande-interne');
    expect(rendered).not.toContain('The owner says to answer this');
  });

  it('treats blank or whitespace as no instruction at all', () => {
    for (const instruction of ['', '   ', '\n']) {
      expect(renderDraftRequest(request({ instruction }))).toContain('classified demande-interne');
    }
  });

  it('carries the owner’s own words through unchanged', () => {
    // Dictated French, with the punctuation speech recognition leaves behind.
    const spoken = 'confirme-lui qu’on est dispo à partir du 8 septembre, et rien de plus';
    expect(renderDraftRequest(request({ instruction: spoken }))).toContain(spoken);
  });
});

describe('the instruction outranks the taxonomy, and only there', () => {
  it('drafts for a category that is not draftable when the owner asked', async () => {
    // The owner has read the message and pressed "répondre". A category is a
    // guess about what is worth offering unprompted; it does not get a veto.
    const draft = await draftReply(
      request({ category: 'veille-newsletter', instruction: 'lui demander le lien' }),
      saying('Bonjour, auriez-vous le lien ? Michel-Marie'),
    );
    expect(draft?.bodyText).toContain('lien');
    expect(draft?.because).toBe('the owner asked for this reply: lui demander le lien');
  });

  it('offers nothing unprompted for a category that warrants none', async () => {
    expect(await draftReply(request({ category: 'veille-newsletter' }), saying('...'))).toBeNull();
  });

  it('still offers a draft unprompted for a category that warrants one', async () => {
    const draft = await draftReply(request(), saying('Bonjour, à 9h. Michel-Marie'));
    expect(draft?.because).toBe('demande-interne: the owner is expected to answer this');
  });
});

describe('the reply language is stated, not left to a rule', () => {
  it('names the language of an English message even when the instruction is French', () => {
    // The defect the owner found: two of thirteen real drafts came back in
    // French because the French instruction is the last thing before the
    // answer, and a rule five lines up loses to it.
    const english = msg({
      bodyText: 'Hello Michel-Marie, thanks for your message. Could you please confirm the slot with your team?',
    });
    const rendered = renderDraftRequest(
      request({ message: english, instruction: 'lui dire que Christelle proposera un créneau' }),
    );
    expect(rendered).toContain('Write the reply in English.');
    expect(rendered).toContain('not necessarily in English; the reply must be.');
  });

  it('names French for a French message', () => {
    expect(renderDraftRequest(request({ instruction: 'confirmer' }))).toContain(
      'Write the reply in French.',
    );
  });

  it('names nothing when the message is too short to tell', () => {
    // Silence restores the general rule; a confident wrong answer overrides it.
    const rendered = renderDraftRequest(request({ message: msg({ bodyText: 'ok', preview: 'ok' }) }));
    expect(rendered).not.toContain('Write the reply in');
  });

  it('tells the model the instruction may be in another language', () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain('never the language it says it in');
    expect(DRAFT_SYSTEM_PROMPT).toContain('When a language is named below');
  });
});

describe('what the draft may commit to', () => {
  it('permits committing only what the instruction says', () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain('only thing you may commit to on their behalf');
    expect(DRAFT_SYSTEM_PROMPT).toContain('Say that and stop');
  });

  it('still forbids inventing a fact, instruction or not', () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain('Never invent a fact');
  });

  it('withholds every commitment when nobody instructed anything', () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain('With no instruction');
    expect(DRAFT_SYSTEM_PROMPT).toContain('may not accept, commit, quote a price');
  });
});

describe('a model told to write bare prose does not', () => {
  it('unwraps a fenced draft', () => {
    expect(cleanDraft('```\nBonjour,\n\nÀ 9h.\n```')).toBe('Bonjour,\n\nÀ 9h.');
    expect(cleanDraft('```text\nBonjour.\n```')).toBe('Bonjour.');
  });

  it('drops a subject line that was asked for and not wanted', () => {
    expect(cleanDraft('Objet : Re: Arrivée\n\nBonjour.')).toBe('Bonjour.');
    expect(cleanDraft('Subject: Re: Arrival\n\nHello.')).toBe('Hello.');
  });

  it('leaves an ordinary draft alone', () => {
    expect(cleanDraft('  Bonjour,\n\nÀ 9h.\n\nMichel-Marie  ')).toBe(
      'Bonjour,\n\nÀ 9h.\n\nMichel-Marie',
    );
  });

  it('reports nothing rather than an empty draft', async () => {
    // An empty proposal sitting in Drafts is worse than no proposal.
    expect(await draftReply(request(), saying('   \n  '))).toBeNull();
    expect(await draftReply(request({ instruction: 'réponds' }), saying('```\n\n```'))).toBeNull();
  });
});

describe('which categories are offered a draft unprompted', () => {
  it('offers one where the owner must answer', () => {
    expect(draftable('correspondance-commerciale-client')).toBe(true);
    expect(draftable('demande-interne')).toBe(true);
  });

  it('offers none for what asks nothing, and none for an escalation', () => {
    expect(draftable('veille-newsletter')).toBe(false);
    expect(draftable('incident-securite')).toBe(false);
  });
});
