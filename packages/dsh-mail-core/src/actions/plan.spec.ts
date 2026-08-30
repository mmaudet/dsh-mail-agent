/**
 * What follows from a classification, and what the owner has to be asked.
 *
 * The planner is where a category becomes a change to somebody's mailbox, so
 * most of what is asserted here is that something does *not* happen.
 */

import { describe, expect, it } from 'vitest';

import type { DecisionTrace } from '../cascade/types.js';
import type { Capabilities, MailCategory } from '../types.js';
import { DEFAULT_POLICY } from './approval.js';
import { automatic, describePlan, planActions, proposed } from './plan.js';

const JMAP_LIKE: Capabilities = {
  push: 'jmap-push-subscription',
  customKeywords: true,
  threadNative: true,
  spamHeaders: true,
  stableIds: true,
};

const IMAP_LIKE: Capabilities = {
  push: 'imap-idle',
  customKeywords: false,
  threadNative: false,
  spamHeaders: true,
  stableIds: true,
};

function trace(category: MailCategory, confidence = 1): DecisionTrace {
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

describe('what a category implies', () => {
  it('tags and files a newsletter', () => {
    const plan = planActions(trace('veille-newsletter'), JMAP_LIKE, DEFAULT_POLICY);

    expect(plan.map((p) => p.action)).toStrictEqual(['keyword', 'move']);
    expect(plan[1]?.folder).toBe('Veille');
    // Tagged unattended, filed only with the owner's say-so: the first dry run
    // over a real mailbox moved a bounce and a sales enquiry out of the inbox.
    expect(automatic(plan).map((p) => p.action)).toStrictEqual(['keyword']);
    expect(proposed(plan).map((p) => p.action)).toStrictEqual(['move']);
  });

  it('tags what it will not move', () => {
    // `important` is the mail the owner is expected to act on. It is marked so
    // they can find it, and left exactly where they left it.
    const plan = planActions(trace('demande-interne'), JMAP_LIKE, DEFAULT_POLICY);

    expect(plan.map((p) => p.action)).toStrictEqual(['keyword']);
    expect(automatic(plan).map((p) => p.action)).toStrictEqual(['keyword']);
  });

  it('plans nothing to move for a message it could not classify', () => {
    const plan = planActions(trace('needs-review'), JMAP_LIKE, DEFAULT_POLICY);
    expect(plan.some((p) => p.action === 'move')).toBe(false);
  });
});

describe('what the owner is asked about', () => {
  it('proposes rather than performs a junking it is unsure of', () => {
    // 0.86 is above node 7's threshold and below the floor junking carries,
    // and the difference between those two numbers is this test.
    const plan = planActions(trace('phishing-arnaque', 0.86), JMAP_LIKE, DEFAULT_POLICY);
    const move = plan.find((p) => p.action === 'move');

    expect(move?.approval).toBe('ask');
    expect(automatic(plan).some((p) => p.action === 'move')).toBe(false);
    expect(proposed(plan).map((p) => p.action)).toStrictEqual(['move']);
  });

  it('proposes the same junking even when it is sure', () => {
    // The floor is not what holds it back any more: no move runs unattended
    // until a category's own traces earn it.
    const plan = planActions(trace('phishing-arnaque', 0.95), JMAP_LIKE, DEFAULT_POLICY);
    expect(automatic(plan).map((p) => p.action)).toStrictEqual(['keyword']);
    expect(proposed(plan).map((p) => p.action)).toStrictEqual(['move']);
  });

  it('still plans an action the policy refuses, so it can be seen', () => {
    // A plan the owner cannot see is a plan they cannot refuse. `never` rows
    // are the ones worth reading.
    const refuse = { rules: [] };
    const plan = planActions(trace('veille-newsletter'), JMAP_LIKE, refuse);

    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.approval === 'never')).toBe(true);
    expect(automatic(plan)).toHaveLength(0);
  });
});

describe('a server without custom keywords', () => {
  it('carries the category in flags instead of a tag', () => {
    // PRD 4.5: the fallback is not a lesser version, it is how the category is
    // expressed where a keyword cannot be stored.
    const plan = planActions(trace('demande-interne'), IMAP_LIKE, DEFAULT_POLICY);
    const tag = plan.find((p) => p.action === 'keyword');

    expect(tag?.keywords).toStrictEqual(['\\Flagged']);
    expect(tag?.because).toContain('no custom keywords');
  });

  it('plans the same destination whatever the server can store', () => {
    // The fallback table is now the only place a destination is written, so a
    // server that cannot tag still files to the same folder — the difference
    // between JMAP and IMAP is what marks the message, not where it lands.
    const degraded = planActions(trace('recu-transaction'), IMAP_LIKE, DEFAULT_POLICY);
    const rich = planActions(trace('recu-transaction'), JMAP_LIKE, DEFAULT_POLICY);
    expect(degraded.find((p) => p.action === 'move')?.folder).toBe('Archives/Comptabilite');
    expect(rich.find((p) => p.action === 'move')?.folder).toBe('Archives/Comptabilite');
  });
});

describe('a plan can be read before it is run', () => {
  it('says what would happen without quoting the message', () => {
    const described = describePlan(planActions(trace('phishing-arnaque'), JMAP_LIKE, DEFAULT_POLICY));

    expect(described).toContain('move -> Junk');
    expect(described).toContain('auto');
    // A dry run is exported and read by people; message content has no place
    // in it, and neither does anything a rationale might have carried.
    expect(described).not.toContain('m1');
  });
});
