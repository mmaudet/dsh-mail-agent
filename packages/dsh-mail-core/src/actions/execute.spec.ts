/**
 * The step where a classification becomes a change to somebody's mailbox.
 *
 * Everything asserted here is a safety property, and each was learned the
 * hard way somewhere in this project: dry run by default, the record written
 * before the write, tag before move, and one failure not taking the batch
 * down with it.
 */

import { describe, expect, it } from 'vitest';

import type { DecisionTrace } from '../cascade/types.js';
import { MailStore } from '../store/mail-store.js';
import type { MailService } from '../mail-service.js';
import type { Capabilities, MailFolder, MailMessage, MailChange, DraftMessage } from '../types.js';
import { DEFAULT_POLICY } from './approval.js';
import { describeResult, executePlan } from './execute.js';
import { planActions } from './plan.js';

const JMAP_LIKE: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
};

/** Records what it was asked to do, and can be told to refuse. */
class RecordingMailbox implements MailService {
  readonly calls: string[] = [];
  readonly capabilities = JMAP_LIKE;
  constructor(private readonly failOn: string | null = null) {}

  setKeywords(id: string, keywords: string[]): Promise<void> {
    this.calls.push(`keywords:${id}:${keywords.join(',')}`);
    return this.failOn === 'keywords' ? Promise.reject(new Error('nope')) : Promise.resolve();
  }
  moveMessage(id: string, folder: string): Promise<void> {
    this.calls.push(`move:${id}:${folder}`);
    return this.failOn === 'move'
      ? Promise.reject(new Error('Newsletters/Tech does not exist'))
      : Promise.resolve();
  }
  listFolders(): Promise<MailFolder[]> {
    return Promise.resolve([]);
  }
  currentCursor(): Promise<string> {
    return Promise.resolve('');
  }
  queryChanges(): Promise<MailChange[]> {
    return Promise.resolve([]);
  }
  getMessages(): Promise<MailMessage[]> {
    return Promise.resolve([]);
  }
  watchInbox(): AsyncDisposable {
    return { [Symbol.asyncDispose]: () => Promise.resolve() };
  }
  createDraft(msg: DraftMessage): Promise<string> {
    this.calls.push(`draft:${msg.subject}`);
    return Promise.resolve('d1');
  }
  submitDraft(): Promise<void> {
    return Promise.resolve();
  }
}

function trace(category: DecisionTrace['category'], confidence = 1): DecisionTrace {
  return {
    messageId: 'm1',
    decidedBy: 'llm',
    category,
    confidence,
    rationale: 'r',
    steps: [],
    usedModel: true,
    startedAt: new Date('2026-08-30T08:00:00.000Z'),
    durationMs: 1,
  };
}

describe('dry run is the default', () => {
  it('touches nothing unless told to', async () => {
    const mailbox = new RecordingMailbox();
    const store = new MailStore(':memory:');
    const t = trace('newsletter-tech');

    const result = await executePlan(t, planActions(t, JMAP_LIKE, DEFAULT_POLICY), mailbox, store);

    expect(result.dryRun).toBe(true);
    expect(mailbox.calls).toStrictEqual([]);
    // And says what it would have done, which is the point of running it.
    expect(result.performed.map((p) => p.action)).toStrictEqual(['keyword']);
    expect(result.proposed.map((p) => p.action)).toStrictEqual(['move']);
    store.close();
  });

  it('writes to the mailbox only when asked', async () => {
    const mailbox = new RecordingMailbox();
    const store = new MailStore(':memory:');
    const t = trace('newsletter-tech');

    await executePlan(t, planActions(t, JMAP_LIKE, DEFAULT_POLICY), mailbox, store, {
      dryRun: false,
    });

    // Only the tag: no move runs unattended under the shipped policy.
    expect(mailbox.calls).toStrictEqual(['keywords:m1:$twaky-newsletter-tech']);
    store.close();
  });
});

describe('the record comes before the write', () => {
  it('stores the trace even in a dry run', async () => {
    // A plan considered and not applied is still a decision worth a record.
    const store = new MailStore(':memory:');
    const t = trace('important');
    await executePlan(t, planActions(t, JMAP_LIKE, DEFAULT_POLICY), new RecordingMailbox(), store);

    expect(store.traceFor('m1')?.category).toBe('important');
    store.close();
  });

  it('stores the trace even when every write fails', async () => {
    // A write that succeeds while its explanation is lost is worse than one
    // that fails.
    const store = new MailStore(':memory:');
    const t = trace('newsletter-tech');
    const result = await executePlan(
      t,
      planActions(t, JMAP_LIKE, DEFAULT_POLICY),
      new RecordingMailbox('keywords'),
      store,
      { dryRun: false },
    );

    expect(result.failed.length).toBeGreaterThan(0);
    expect(store.traceFor('m1')).not.toBeNull();
    store.close();
  });
});

describe('ordering', () => {
  it('tags before it moves', async () => {
    // On IMAP a move assigns a new UID, so the id the plan was made against
    // stops resolving the moment the message leaves.
    const mailbox = new RecordingMailbox();
    const store = new MailStore(':memory:');
    const t = trace('spam-certain');
    const plan = planActions(t, JMAP_LIKE, DEFAULT_POLICY);

    // Handed in the wrong order on purpose: execution must not depend on the
    // caller having sorted it.
    // Both marked automatic here, because the ordering property is about
    // execution and not about which rules the shipped policy happens to grant.
    const both = plan.map((p) => ({ ...p, approval: 'auto' as const }));
    await executePlan(t, [...both].reverse(), mailbox, store, { dryRun: false });

    expect(mailbox.calls[0]).toContain('keywords:');
    expect(mailbox.calls[1]).toContain('move:');
    store.close();
  });
});

describe('one failure is one message', () => {
  it('reports the failure and keeps the rest', async () => {
    const mailbox = new RecordingMailbox('move');
    const store = new MailStore(':memory:');
    const t = trace('newsletter-tech');
    const plan = planActions(t, JMAP_LIKE, DEFAULT_POLICY).map((p) => ({
      ...p,
      approval: 'auto' as const,
    }));

    const result = await executePlan(t, plan, mailbox, store, { dryRun: false });

    expect(result.performed.map((p) => p.action)).toStrictEqual(['keyword']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain('does not exist');
    store.close();
  });
});

describe('the policy is the boundary', () => {
  it('performs nothing the policy did not mark automatic', async () => {
    const mailbox = new RecordingMailbox();
    const store = new MailStore(':memory:');
    const t = trace('spam-certain', 0.86); // below the junking floor

    const result = await executePlan(t, planActions(t, JMAP_LIKE, DEFAULT_POLICY), mailbox, store, {
      dryRun: false,
    });

    expect(mailbox.calls).toStrictEqual(['keywords:m1:$twaky-spam-certain']);
    expect(result.proposed.map((p) => p.action)).toStrictEqual(['move']);
    store.close();
  });

  it('refuses to run an action it cannot perform, rather than passing over it', async () => {
    // Reaching here means a policy granted something the executor has no way
    // to do, which is a configuration error worth hearing about.
    const mailbox = new RecordingMailbox();
    const store = new MailStore(':memory:');
    const t = trace('important');

    const result = await executePlan(
      t,
      [{ messageId: 'm1', action: 'send', approval: 'auto', because: 'misconfigured' }],
      mailbox,
      store,
      { dryRun: false },
    );

    expect(result.performed).toHaveLength(0);
    expect(result.failed[0]?.error).toContain('cannot run unattended');
    expect(mailbox.calls).toStrictEqual([]);
    store.close();
  });
});

describe('a result can be read', () => {
  it('summarises without quoting anything', async () => {
    const store = new MailStore(':memory:');
    const t = trace('newsletter-promo');
    const described = describeResult(
      await executePlan(t, planActions(t, JMAP_LIKE, DEFAULT_POLICY), new RecordingMailbox(), store),
    );

    expect(described).toContain('dry run — nothing was changed');
    expect(described).toContain('performed : 1');
    expect(described).toContain('proposed  : 1');
    store.close();
  });
});
