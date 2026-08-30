/**
 * The queue, against the corrections that produced it.
 *
 * Every case here is a message that really was queued: the owner's own reply
 * offered back to them, a mail they had answered three days earlier, a status
 * report to a distribution list ranked above a direct question.
 */

import { describe, expect, it } from 'vitest';

import type { Envelope, MailMessage } from '../types.js';
import { addressingOf, answered, describeQueue, ownMessage, pending, summarise } from './pending.js';

const OWNER = 'mmaudet@linagora.com';
const OWN = [OWNER, 'dg@linagora.com'];

function msg(overrides: Partial<MailMessage> & Pick<MailMessage, 'id'>): MailMessage {
  return {
    threadId: null,
    messageId: `${overrides.id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: 'Someone', email: 'someone@example.org' }],
    to: [{ name: null, email: OWNER }],
    cc: [],
    subject: '',
    receivedAt: new Date('2026-08-29T09:00:00Z'),
    sentAt: new Date('2026-08-29T08:59:00Z'),
    keywords: [],
    folder: 'INBOX',
    preview: '',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...overrides,
  };
}

function reply(to: string): Envelope {
  return {
    id: `sent-${to}`,
    threadId: null,
    messageId: `sent-${to}@example.org`,
    inReplyTo: [to],
    references: [],
    from: [{ name: null, email: OWNER }],
    to: [],
    cc: [],
    subject: '',
    receivedAt: new Date('2026-08-29T10:00:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'Sent',
  };
}

const candidate = (message: MailMessage) => ({ message, category: 'demande-interne' as const });

describe('a message the owner already answered is finished with', () => {
  it('drops it on the Message-ID join', () => {
    const message = msg({ id: 'm1', messageId: 'req-2026-8118@interieur.gouv.fr' });
    expect(answered(message, [reply('req-2026-8118@interieur.gouv.fr')])).toBe(true);
    expect(pending([candidate(message)], { ownAddresses: OWN, sent: [reply('req-2026-8118@interieur.gouv.fr')] })).toStrictEqual([]);
  });

  it('matches the id whatever case the reply wrote it in', () => {
    // Message-ID comparison is case-sensitive in the RFC and case-insensitive
    // in practice, and a queue that shows an answered message back to the
    // owner is worse than one that hides an unanswered one by mistake.
    const message = msg({ id: 'm1', messageId: 'ABC@Example.ORG' });
    expect(answered(message, [reply('abc@example.org')])).toBe(true);
  });

  it('keeps a message the owner wrote in the same thread but did not answer', () => {
    // Thread membership over-matched on the real forty: the owner writes to one
    // person in a thread and is copied on four other messages in it.
    const message = msg({ id: 'm1', threadId: 't1', messageId: 'unanswered@example.org' });
    expect(answered(message, [{ ...reply('something-else@example.org'), threadId: 't1' }])).toBe(false);
  });

  it('cannot drop a message with no Message-ID rather than guessing', () => {
    expect(answered(msg({ id: 'm1', messageId: null }), [reply('anything')])).toBe(false);
  });
});

describe("the owner's own mail is not a request to the owner", () => {
  it('drops a reply of theirs delivered back into the inbox', () => {
    // This happened: their own acknowledgement to a judicial requisition came
    // back through the dg@ alias and the agent queued it as needing an answer.
    const message = msg({ id: 'm1', from: [{ name: 'Michel-Marie', email: OWNER }] });
    expect(ownMessage(message, OWN)).toBe(true);
    expect(pending([candidate(message)], { ownAddresses: OWN, sent: [] })).toStrictEqual([]);
  });

  it('counts a role address as the owner when they said it is one', () => {
    expect(ownMessage(msg({ id: 'm1', from: [{ name: null, email: 'dg@linagora.com' }] }), OWN)).toBe(true);
    expect(ownMessage(msg({ id: 'm1', from: [{ name: null, email: 'vente@linagora.com' }] }), OWN)).toBe(false);
  });
});

describe('addressing is read from every named recipient, not from To alone', () => {
  it('calls it personal when the owner is in Cc', () => {
    const message = msg({ id: 'm1', to: [{ name: null, email: 'other@example.org' }], cc: [{ name: null, email: OWNER }] });
    expect(addressingOf(message, OWN)).toBe('personal');
  });

  it('calls it a list when the message went to a team alias', () => {
    // Twenty of the forty arrived this way, with a populated To naming
    // vente@ or expertise-libre@ and the owner nowhere in the headers.
    const message = msg({ id: 'm1', to: [{ name: null, email: 'expertise-libre@linagora.com' }], cc: [] });
    expect(addressingOf(message, OWN)).toBe('list');
  });
});

describe('addressing orders the queue and never shortens it', () => {
  const direct = msg({ id: 'direct', receivedAt: new Date('2026-08-25T09:00:00Z') });
  const viaList = msg({
    id: 'list',
    to: [{ name: null, email: 'canut-libre@linagora.com' }],
    receivedAt: new Date('2026-08-28T09:00:00Z'),
  });

  it('puts what was addressed to the owner first, newer though the list mail is', () => {
    const queue = pending([candidate(viaList), candidate(direct)], { ownAddresses: OWN, sent: [] });
    expect(queue.map((item) => item.message.id)).toStrictEqual(['direct', 'list']);
  });

  it('still offers the list mail', () => {
    // The subcontracting question reached the owner through canut-libre@ and
    // needed an answer. A filter on addressing would have hidden it.
    const queue = pending([candidate(viaList)], { ownAddresses: OWN, sent: [] });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.addressing).toBe('list');
  });

  it('orders newest first within a group', () => {
    const older = msg({ id: 'older', receivedAt: new Date('2026-08-20T09:00:00Z') });
    const queue = pending([candidate(older), candidate(direct)], { ownAddresses: OWN, sent: [] });
    expect(queue.map((item) => item.message.id)).toStrictEqual(['direct', 'older']);
  });
});

describe('the summary says what was removed', () => {
  it('reports each reason separately', () => {
    const candidates = [
      candidate(msg({ id: 'answered', messageId: 'a@example.org' })),
      candidate(msg({ id: 'mine', from: [{ name: null, email: OWNER }] })),
      candidate(msg({ id: 'open' })),
      candidate(msg({ id: 'via', to: [{ name: null, email: 'vente@linagora.com' }] })),
    ];
    const options = { ownAddresses: OWN, sent: [reply('a@example.org')] };
    const queue = pending(candidates, options);
    const summary = summarise(candidates, options, queue);

    expect(summary).toStrictEqual({
      offered: 2,
      dropped: 2,
      answeredAlready: 1,
      ownMessages: 1,
      personal: 1,
    });
    expect(describeQueue(summary)).toBe(
      '2 waiting on the owner, 1 addressed to them directly\n' +
        '  dropped 2: 1 already answered, 1 sent by the owner',
    );
  });
});
