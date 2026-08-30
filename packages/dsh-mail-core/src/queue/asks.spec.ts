/**
 * The judgement the queue rests on.
 *
 * What is testable here is the envelope: what leaves the perimeter, how an
 * answer is read, and what happens when there is no answer to read. Whether
 * the prompt is any good is measured against the owner's annotations, by
 * `scripts/measure-dispositions.mjs`, and cannot be asserted in a unit test.
 */

import { describe, expect, it } from 'vitest';

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

import type { MailMessage } from '../types.js';
import { ASKS_SYSTEM_PROMPT, asksOfOwner, readVerdict, renderForAsk } from './asks.js';

function msg(overrides: Partial<MailMessage> & Pick<MailMessage, 'id'>): MailMessage {
  return {
    threadId: null,
    messageId: `${overrides.id}@example.org`,
    inReplyTo: [],
    references: [],
    from: [{ name: 'Une Collègue', email: 'colleague@example.org' }],
    to: [{ name: null, email: 'owner@example.org' }],
    cc: [],
    subject: 'Sujet',
    receivedAt: new Date('2026-08-29T09:00:00Z'),
    sentAt: null,
    keywords: [],
    folder: 'INBOX',
    preview: 'aperçu',
    bodyText: null,
    bodyHtml: null,
    hasAttachments: false,
    spamHeaders: {},
    listUnsubscribe: [],
    listId: null,
    ...overrides,
  };
}

function llmSaying(text: string): {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  readonly seen: GenerateOptions[];
} {
  const seen: GenerateOptions[] = [];
  return {
    seen,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options);
      return (async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        // A reasoning model emits its thinking on a different channel, and
        // folding that in would read thinking as a verdict.
        yield { type: 'reasoning-delta', index: 0, text: 'NO wait, actually yes' };
        // In pieces, because a real stream arrives in pieces and a reader that
        // only works on one chunk works only in a test.
        for (const piece of text.match(/.{1,3}/gs) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

const call = { provider: 'mail-llm-economy', model: 'm' };

describe('the verdict is the last word, not the first character', () => {
  it('reads a bare answer', () => {
    expect(readVerdict('YES')).toBe(true);
    expect(readVerdict('no')).toBe(false);
  });

  it('reads the answer a model reasons its way to', () => {
    // The failure that scored a model at 0%: it opens by restating the
    // question, and only the closing word is the verdict.
    expect(readVerdict('The question is whether NO applies here. Answer: YES')).toBe(true);
    expect(readVerdict('This could be YES, but a colleague is asked. NO')).toBe(false);
  });

  it('does not find a verdict inside another word', () => {
    expect(readVerdict('This is a NOTIFICATION about YESTERDAY')).toBe(null);
  });

  it('reports no answer rather than inventing one', () => {
    expect(readVerdict('')).toBe(null);
    expect(readVerdict('I cannot determine this.')).toBe(null);
  });
});

describe('an unreadable answer is offered, never dropped', () => {
  it('offers the message when the model said nothing usable', async () => {
    // A queue that hides mail the owner had to answer fails in the direction
    // that costs them; one that shows a message too many does not.
    expect(await asksOfOwner(msg({ id: 'm1' }), 'personal', { ...call, llm: llmSaying('') })).toBe(true);
  });

  it('still says no when the model did answer no', async () => {
    expect(await asksOfOwner(msg({ id: 'm1' }), 'list', { ...call, llm: llmSaying('NO') })).toBe(false);
  });

  it('ignores reasoning and reads only the visible answer', async () => {
    const llm = llmSaying('NO');
    expect(await asksOfOwner(msg({ id: 'm1' }), 'personal', { ...call, llm })).toBe(false);
  });
});

describe('what leaves the perimeter', () => {
  it('tells the model how the message was addressed, which it cannot see', () => {
    // Whether `vente@` is the owner or a team they sit on is a fact about the
    // company, not about the headers.
    const viaList = msg({ id: 'm1', to: [{ name: null, email: 'vente@example.org' }] });
    expect(renderForAsk(viaList, 'list')).toContain('Addressed: to a list the owner is on');
    expect(renderForAsk(viaList, 'personal')).toContain('Addressed: to the owner');
  });

  it('sends a bounded excerpt rather than a whole thread', () => {
    const long = msg({ id: 'm1', bodyText: 'x'.repeat(5000) });
    expect(renderForAsk(long, 'personal')).toHaveLength(
      renderForAsk(msg({ id: 'm1', bodyText: '' }), 'personal').length + 1200,
    );
  });

  it('falls back to the preview when there is no text body', () => {
    expect(renderForAsk(msg({ id: 'm1', bodyText: null }), 'personal')).toContain('aperçu');
  });

  it('omits the Cc line rather than sending an empty one', () => {
    expect(renderForAsk(msg({ id: 'm1' }), 'personal')).not.toContain('Cc:');
    const cc = msg({ id: 'm1', cc: [{ name: null, email: 'other@example.org' }] });
    expect(renderForAsk(cc, 'personal')).toContain('Cc: other@example.org');
  });

  it('asks deterministically and leaves a reasoning model room to answer', async () => {
    const llm = llmSaying('YES');
    await asksOfOwner(msg({ id: 'm1' }), 'personal', { ...call, llm });
    expect(llm.seen[0]?.temperature).toBe(0);
    expect(llm.seen[0]?.maxTokens).toBe(600);
    expect(llm.seen[0]?.system).toBe(ASKS_SYSTEM_PROMPT);
  });
});

describe('the prompt states the base rate', () => {
  it('says most of the mailbox asks nothing', () => {
    // Without this line the same model on the same messages offered fourteen
    // instead of ten, and found no more of them.
    expect(ASKS_SYSTEM_PROMPT).toContain('Most mail in this inbox is NO');
  });
});
