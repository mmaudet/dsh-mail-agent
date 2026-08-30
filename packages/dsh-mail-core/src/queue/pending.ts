/**
 * The queue of messages still waiting on the owner.
 *
 * The first version of this was a filter with two clauses — classified as
 * needing the owner, still in the inbox — and it produced forty items of which
 * four wanted a reply (`docs/reviews/forty-dispositions.md`). Everything here
 * is a correction the owner's own annotations paid for, and nothing here is a
 * heuristic: each rule either drops a message the owner has demonstrably
 * finished with, or it changes the order.
 *
 * The rule that is deliberately absent is the tempting one. Recipient position
 * separates 67% of what wants something from 71% of what does not, which sounds
 * usable and is not: applied as a filter it hides the subcontracting question
 * and the renewal notice. It sorts. It never drops.
 */

import type { Envelope, MailCategory, MailMessage } from '../types.js';

/**
 * How the message reached the owner.
 *
 * Not `to` versus `cc`, which was the obvious reading and is wrong on this
 * mailbox: of twenty messages the owner described as "je suis en copie", three
 * were in `Cc`. The rest were addressed to a group alias — `vente@`,
 * `expertise-libre@` — and arrived through `Delivered-To`.
 */
export type Addressing =
  /** The owner, or one of their own addresses, is named. */
  | 'personal'
  /** Named recipients exist and none of them is the owner. */
  | 'list';

export interface PendingItem {
  readonly message: MailMessage;
  readonly category: MailCategory;
  readonly addressing: Addressing;
}

export interface PendingOptions {
  /**
   * Every address that *is* the owner rather than a group they belong to.
   *
   * A distinction only the owner can draw: `dg@` is a role that reaches one
   * person, `vente@` is a team. Nothing in a message says which.
   */
  readonly ownAddresses: readonly string[];
  /**
   * Recent messages from the Sent folder, for the answered check.
   *
   * Envelopes are enough — the check reads `inReplyTo` and nothing else — so a
   * caller does not have to fetch bodies for a folder it never displays.
   */
  readonly sent: readonly Envelope[];
}

export interface Candidate {
  readonly message: MailMessage;
  readonly category: MailCategory;
}

const lower = (value: string): string => value.toLowerCase();

/**
 * Whether the owner has already replied to this message.
 *
 * A join on `Message-ID`, not a guess: their reply carries the original's id in
 * `In-Reply-To` (RFC 5322 section 3.6.4). Ten of the forty queued messages had
 * been answered days earlier, because this owner replies without filing and the
 * queue took "still in the inbox" to mean "still open".
 *
 * Thread membership is not used. The owner having written *somewhere* in a
 * thread does not mean they answered *this* message, and on the same forty it
 * over-matched.
 */
export function answered(message: MailMessage, sent: readonly Envelope[]): boolean {
  if (message.messageId === null) return false;
  const id = lower(message.messageId);
  return sent.some((reply) => reply.inReplyTo.some((target) => lower(target) === id));
}

/** Whether the owner sent it themselves. One of their own replies was queued. */
export function ownMessage(message: MailMessage, ownAddresses: readonly string[]): boolean {
  const own = new Set(ownAddresses.map(lower));
  return message.from.some((address) => own.has(lower(address.email)));
}

export function addressingOf(message: MailMessage, ownAddresses: readonly string[]): Addressing {
  const own = new Set(ownAddresses.map(lower));
  const named = [...message.to, ...message.cc];
  return named.some((address) => own.has(lower(address.email))) ? 'personal' : 'list';
}

/**
 * The queue, in the order the owner should work it.
 *
 * Newest first within each group, because the two things that separated
 * anything on this mailbox — who it was addressed to, and how recent it is —
 * are both facts about delivery rather than readings of the text.
 */
export function pending(
  candidates: readonly Candidate[],
  options: PendingOptions,
): readonly PendingItem[] {
  const { ownAddresses, sent } = options;
  return candidates
    .filter(({ message }) => !ownMessage(message, ownAddresses) && !answered(message, sent))
    .map(({ message, category }) => ({
      message,
      category,
      addressing: addressingOf(message, ownAddresses),
    }))
    .sort((a, b) => {
      if (a.addressing !== b.addressing) return a.addressing === 'personal' ? -1 : 1;
      return b.message.receivedAt.getTime() - a.message.receivedAt.getTime();
    });
}

export interface QueueSummary {
  readonly offered: number;
  readonly dropped: number;
  readonly answeredAlready: number;
  readonly ownMessages: number;
  readonly personal: number;
}

/** What the filters removed, so a caller can say it rather than imply it. */
export function summarise(
  candidates: readonly Candidate[],
  options: PendingOptions,
  offered: readonly PendingItem[],
): QueueSummary {
  const answeredAlready = candidates.filter(({ message }) =>
    answered(message, options.sent),
  ).length;
  const ownMessages = candidates.filter(({ message }) =>
    ownMessage(message, options.ownAddresses),
  ).length;
  return {
    offered: offered.length,
    dropped: candidates.length - offered.length,
    answeredAlready,
    ownMessages,
    personal: offered.filter((item) => item.addressing === 'personal').length,
  };
}

export function describeQueue(summary: QueueSummary): string {
  return (
    `${String(summary.offered)} waiting on the owner, ` +
    `${String(summary.personal)} addressed to them directly\n` +
    `  dropped ${String(summary.dropped)}: ` +
    `${String(summary.answeredAlready)} already answered, ` +
    `${String(summary.ownMessages)} sent by the owner`
  );
}
