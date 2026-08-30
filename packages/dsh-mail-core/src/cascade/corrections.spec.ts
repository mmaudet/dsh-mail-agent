/**
 * Reading the owner moving mail back, which is the only feedback there is.
 */

import { describe, expect, it } from 'vitest';

import { MailStore } from '../store/mail-store.js';
import type { MailService } from '../mail-service.js';
import type { CascadeNode, DecisionTrace } from './types.js';
import type { Capabilities, MailCategory } from '../types.js';
import { readCorrections, describeCorrections } from './corrections.js';

const CAPS: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
  stableIds: true,
};

function mailbox(placed: Record<string, string[]>, caps: Capabilities = CAPS): MailService {
  return {
    capabilities: caps,
    locate: (ids: readonly string[]) => {
      const out = new Map<string, string[]>();
      for (const id of ids) if (placed[id] !== undefined) out.set(id, placed[id]);
      return Promise.resolve(out);
    },
  } as unknown as MailService;
}

function file(
  store: MailStore,
  messageId: string,
  folder: string,
  decidedBy: CascadeNode,
  over: Partial<{ sender: string; listId: string; category: MailCategory }> = {},
): void {
  const t: DecisionTrace = {
    messageId,
    decidedBy,
    category: over.category ?? ('spam-formulaire-contact' as MailCategory),
    confidence: 1,
    rationale: 'r',
    steps: [],
    usedModel: decidedBy === 'llm',
    startedAt: new Date(),
    durationMs: 0,
  };
  store.recordTrace(t, { sender: over.sender ?? 'nple@linagora.com', listId: over.listId ?? null });
  store.recordFiled(messageId, folder);
}

describe('the owner moving mail back is the correction', () => {
  it('counts what stayed put and what came back', async () => {
    const store = new MailStore(':memory:');
    file(store, 'a', 'Junk', 'llm');
    file(store, 'b', 'Junk', 'llm');
    const report = await readCorrections(store, mailbox({ a: ['Junk'], b: ['INBOX'] }));

    expect(report.checked).toBe(2);
    expect(report.agreed).toBe(1);
    expect(report.corrections.map((c) => c.messageId)).toStrictEqual(['b']);
    store.close();
  });

  it('does not read a deletion as disagreement', async () => {
    // The owner deleting something the agent junked is agreement about where
    // it did not belong. Counting it as a correction teaches the opposite of
    // what happened.
    const store = new MailStore(':memory:');
    file(store, 'a', 'Junk', 'llm');
    const report = await readCorrections(store, mailbox({}));

    expect(report.corrections).toStrictEqual([]);
    expect(report.agreed).toBe(0);
    store.close();
  });

  it('sees a message that is still there among other labels', async () => {
    // On Gmail a label is a mailbox and a message is in several at once.
    const store = new MailStore(':memory:');
    file(store, 'a', 'Junk', 'llm');
    const report = await readCorrections(store, mailbox({ a: ['All Mail', 'Junk'] }));

    expect(report.agreed).toBe(1);
    store.close();
  });

  it('refuses on a server that reassigns ids when mail moves', async () => {
    // There a successful filing and an owner's correction look identical, so
    // every filing would read as a correction and the loop would unlearn
    // everything it ever got right.
    const store = new MailStore(':memory:');
    file(store, 'a', 'Junk', 'llm');
    await expect(
      readCorrections(store, mailbox({}, { ...CAPS, stableIds: false })),
    ).rejects.toThrow(/stable message ids/);
    store.close();
  });
});

describe('a correction against a route needs a person', () => {
  it('surfaces the route with its total, not just its failures', async () => {
    // Three corrections out of four is a route to retire; three out of ninety
    // is a route working as intended.
    const store = new MailStore(':memory:');
    for (const id of ['a', 'b', 'c', 'd']) file(store, id, 'Junk', 'stated-route');
    const report = await readCorrections(
      store,
      mailbox({ a: ['Junk'], b: ['Junk'], c: ['INBOX'], d: ['INBOX'] }),
    );

    expect(report.disputedRoutes).toHaveLength(1);
    expect(report.disputedRoutes[0]?.moved).toBe(2);
    expect(report.disputedRoutes[0]?.total).toBe(4);
    expect(report.disputedRoutes[0]?.sender).toBe('nple@linagora.com');
    store.close();
  });

  it('leaves a learned pattern to the ordinary learning path', async () => {
    // Counter-evidence against something inferred is absorbed by the
    // dominance rule; nothing here needs to intervene, and a second mechanism
    // deciding the same thing is how a rule nobody can explain appears.
    const store = new MailStore(':memory:');
    file(store, 'a', 'Junk', 'learned-pattern');
    const report = await readCorrections(store, mailbox({ a: ['INBOX'] }));

    expect(report.corrections).toHaveLength(1);
    expect(report.disputedRoutes).toStrictEqual([]);
    store.close();
  });

  it('tells the owner that only they can change it', async () => {
    const store = new MailStore(':memory:');
    for (const id of ['a', 'b']) file(store, id, 'Junk', 'stated-route');
    const text = describeCorrections(
      await readCorrections(store, mailbox({ a: ['Junk'], b: ['INBOX'] })),
    );

    expect(text).toContain('1 of 2 filed messages are still where the agent put them');
    expect(text).toContain('Only you can change a route.');
    store.close();
  });
});
