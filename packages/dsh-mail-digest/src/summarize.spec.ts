/**
 * The digest, and the section it deliberately does not have.
 *
 * Everything asserted here is arithmetic over headers. That is the point: the
 * PRD's headline section ranks the five most important messages, and the
 * category that would rank them is right about the band 69% of the time. What
 * is left when that is removed still has to be worth reading, and these are
 * the properties that make it so.
 */

import { describe, expect, it } from 'vitest';

import type { Envelope, MailMessage } from '@dsh-mail-agent/mail-core';

import {
  correspondents,
  describeDigest,
  hotThreads,
  summarizePeriod,
  viaLists,
  within,
  type DigestInput,
  type Period,
} from './summarize.js';

const OWNER = 'mmaudet@linagora.com';
const PERIOD: Period = { from: new Date('2026-08-24T00:00:00Z'), to: new Date('2026-08-31T00:00:00Z') };

function msg(over: Partial<MailMessage> & Pick<MailMessage, 'id'>): MailMessage {
  return {
    threadId: null,
    messageId: `${over.id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: null, email: 'someone@example.org' }],
    to: [{ name: null, email: OWNER }],
    cc: [],
    subject: 'Sujet',
    receivedAt: new Date('2026-08-26T09:00:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...over,
  };
}

function reply(to: string, at = '2026-08-26T10:00:00Z'): Envelope {
  return {
    id: `s-${to}`,
    threadId: null,
    messageId: `s-${to}@example.org`,
    inReplyTo: [to],
    references: [],
    from: [{ name: null, email: OWNER }],
    to: [],
    cc: [],
    subject: '',
    receivedAt: new Date(at),
    sentAt: null,
    keywords: [],
    folder: 'Sent',
  };
}

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  messages: [],
  sent: [],
  decisions: [],
  waiting: [],
  ownAddresses: [OWNER],
  ...over,
});

describe('the window has ends, and they are included', () => {
  it('keeps what arrived on the first and last day', () => {
    const kept = [
      msg({ id: 'first', receivedAt: PERIOD.from }),
      msg({ id: 'last', receivedAt: PERIOD.to }),
    ];
    const dropped = [
      msg({ id: 'before', receivedAt: new Date('2026-08-23T23:59:59Z') }),
      msg({ id: 'after', receivedAt: new Date('2026-08-31T00:00:01Z') }),
    ];
    expect(within([...kept, ...dropped], PERIOD).map((m) => m.id)).toStrictEqual(['first', 'last']);
  });
});

describe('what the owner answered is a join, not a guess', () => {
  it('counts a reply only when it answers something in the window', () => {
    const digest = summarizePeriod(
      input({
        messages: [msg({ id: 'a', messageId: 'a@example.org' })],
        sent: [reply('a@example.org'), reply('something-else@example.org')],
      }),
      PERIOD,
    );
    expect(digest.received).toBe(1);
    expect(digest.sent).toBe(2);
    expect(digest.answered).toBe(1);
  });
});

describe('addressed to them, or to a list they are on', () => {
  it('separates the two', () => {
    const digest = summarizePeriod(
      input({
        messages: [
          msg({ id: 'named' }),
          msg({ id: 'via', to: [{ name: null, email: 'vente@linagora.com' }] }),
        ],
      }),
      PERIOD,
    );
    expect(digest.addressedToThem).toBe(1);
  });

  it('counts which alias carried the rest', () => {
    const own = new Set([OWNER]);
    const messages = [
      msg({ id: '1', to: [{ name: null, email: 'vente@linagora.com' }] }),
      msg({ id: '2', to: [{ name: null, email: 'vente@linagora.com' }] }),
      msg({ id: '3', to: [{ name: null, email: 'expertise-libre@linagora.com' }] }),
      msg({ id: '4' }),
    ];
    expect(viaLists(messages, own)).toStrictEqual([
      { address: 'vente@linagora.com', messages: 2 },
      { address: 'expertise-libre@linagora.com', messages: 1 },
    ]);
  });
});

describe('a thread is hot at three messages, not two', () => {
  const three = ['a', 'b', 'c'].map((id) =>
    msg({ id, threadId: 't1', subject: id === 'a' ? 'Re: Le sujet complet du fil' : 'Re: Le sujet' }),
  );

  it('ignores a question and its answer', () => {
    const two = ['x', 'y'].map((id) => msg({ id, threadId: 't2' }));
    expect(hotThreads(two, new Set([OWNER]))).toStrictEqual([]);
  });

  it('keeps the fullest subject, which replies shorten', () => {
    expect(hotThreads(three, new Set([OWNER]))[0]?.subject).toBe('Re: Le sujet complet du fil');
  });

  it('says whether the owner wrote in it', () => {
    expect(hotThreads(three, new Set([OWNER]))[0]?.ownerWrote).toBe(false);
    const withOwner = [...three, msg({ id: 'd', threadId: 't1', from: [{ name: null, email: OWNER }] })];
    expect(hotThreads(withOwner, new Set([OWNER]))[0]?.ownerWrote).toBe(true);
  });

  it('does not thread what the server could not thread', () => {
    expect(hotThreads(['p', 'q', 'r'].map((id) => msg({ id })), new Set([OWNER]))).toStrictEqual([]);
  });
});

describe('who wrote, counted by address', () => {
  it('leaves the owner out of their own inbox', () => {
    const messages = [
      msg({ id: '1', from: [{ name: 'Une Fois', email: 'a@example.org' }] }),
      msg({ id: '2', from: [{ name: 'Autre casse', email: 'A@Example.ORG' }] }),
      msg({ id: '3', from: [{ name: null, email: OWNER }] }),
    ];
    expect(correspondents(messages, new Set([OWNER]))).toStrictEqual([
      { address: 'a@example.org', messages: 2 },
    ]);
  });
});

describe('the counters carry their own accuracy', () => {
  it('reports the bands and how many were settled for free', () => {
    const digest = summarizePeriod(
      input({
        messages: [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })],
        decisions: [
          { messageId: 'a', category: 'demande-interne', usedModel: true, decidedBy: 'llm' },
          { messageId: 'b', category: 'veille-newsletter', usedModel: false, decidedBy: 'learned-pattern' },
          { messageId: 'c', category: 'needs-review', usedModel: true, decidedBy: 'below-threshold' },
        ],
      }),
      PERIOD,
    );
    expect(digest.classified).toBe(2);
    expect(digest.byBand).toStrictEqual({ acts: 1, reads: 1, drops: 0 });
    expect(digest.settledWithoutModel).toBe(1);
    expect(digest.undecided).toBe(1);
  });

  it('says out loud how often the band is right', () => {
    // A digest that reports a classification without its accuracy reads like a
    // fact. This one is right seven times in ten.
    const digest = summarizePeriod(
      input({
        messages: [msg({ id: 'a' })],
        decisions: [{ messageId: 'a', category: 'demande-interne', usedModel: true, decidedBy: 'llm' }],
      }),
      PERIOD,
    );
    expect(describeDigest(digest)).toContain('7 fois sur 10');
  });
});

describe('what still wants the owner', () => {
  it('counts the days it has been waiting', () => {
    const digest = summarizePeriod(
      input({
        waiting: [
          {
            message: msg({ id: 'w', receivedAt: new Date('2026-08-27T00:00:00Z'), subject: 'Devis' }),
            category: 'correspondance-commerciale-client',
          },
        ],
      }),
      PERIOD,
    );
    expect(digest.waiting[0]?.waitingDays).toBe(4);
    expect(describeDigest(digest)).toContain('Devis');
  });

  it('says how many it did not list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      message: msg({ id: `w${String(i)}` }),
      category: 'demande-interne' as const,
    }));
    expect(describeDigest(summarizePeriod(input({ waiting: many }), PERIOD), 6)).toContain(
      'et 3 autres',
    );
  });
});

describe('an empty period says so without inventing sections', () => {
  it('reports the counts and nothing else', () => {
    const text = describeDigest(summarizePeriod(input(), PERIOD));
    expect(text).toContain('0 reçus');
    expect(text).not.toContain('Fils qui ont bougé');
    expect(text).not.toContain("Ce qui t'attend");
  });
});
