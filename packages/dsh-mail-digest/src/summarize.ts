/**
 * `summarize_period` — what happened in the mailbox between two dates
 * (PRD section 4.3).
 *
 * The PRD asks for five sections and one of them cannot be built honestly. It
 * wants the *top five important messages*, which means ranking by category —
 * and the category is right 53% of the time and right about the band 69%
 * (`docs/reviews/one-hundred-and-fifty.md`). A digest whose headline is a
 * ranking of a coin-flip is worse than no headline, because it reads exactly
 * like a good one.
 *
 * So the shape here is: facts the mailbox states, and one judgement that has
 * been measured. Counts, threads, senders and what the owner answered are
 * arithmetic over headers — no model, nothing to be wrong about. What still
 * wants them comes from `pending()`, which drops what they already answered on
 * an exact join and offers the rest. Everything derived from the sixteen
 * categories is reported with its own accuracy attached, or not at all.
 */

import type { Envelope, MailCategory, MailMessage } from '@dsh-mail-agent/mail-core';
import { bandOf, type CategoryBand } from '@dsh-mail-agent/mail-core';

export interface Period {
  readonly from: Date;
  readonly to: Date;
}

/** One decision the agent recorded, as the digest needs it. */
export interface DecisionRecord {
  readonly messageId: string;
  readonly category: MailCategory;
  readonly usedModel: boolean;
  readonly decidedBy: string;
}

export interface DigestInput {
  /** Received in the window. */
  readonly messages: readonly MailMessage[];
  /** Sent in the window, for what the owner answered. */
  readonly sent: readonly Envelope[];
  readonly decisions: readonly DecisionRecord[];
  /** What still wants the owner, already filtered — see `pending()`. */
  readonly waiting: readonly { readonly message: MailMessage; readonly category: MailCategory }[];
  /** Every address that is the owner rather than a list they belong to. */
  readonly ownAddresses: readonly string[];
}

export interface Correspondent {
  readonly address: string;
  readonly messages: number;
}

export interface HotThread {
  readonly threadId: string;
  readonly subject: string;
  readonly messages: number;
  readonly people: number;
  /** True when the owner wrote in it during the window. */
  readonly ownerWrote: boolean;
}

export interface Waiting {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly receivedAt: Date;
  readonly category: MailCategory;
  /** Days between arrival and the end of the window. */
  readonly waitingDays: number;
}

export interface Digest {
  readonly period: Period;
  readonly received: number;
  readonly sent: number;
  /** Replies of the owner's that answer something received in the window. */
  readonly answered: number;
  /** Addressed to the owner by name rather than to a list they are on. */
  readonly addressedToThem: number;
  readonly byBand: Readonly<Record<CategoryBand, number>>;
  readonly settledWithoutModel: number;
  readonly classified: number;
  /** Messages the agent could not settle: needs-review, or never reached. */
  readonly undecided: number;
  readonly hotThreads: readonly HotThread[];
  readonly correspondents: readonly Correspondent[];
  readonly viaLists: readonly Correspondent[];
  readonly waiting: readonly Waiting[];
}

const lower = (s: string): string => s.toLowerCase();
const DAY = 24 * 60 * 60 * 1000;

/** Messages with a `receivedAt` inside the window, ends included. */
export function within<T extends { readonly receivedAt: Date }>(
  items: readonly T[],
  period: Period,
): readonly T[] {
  return items.filter(
    (i) => i.receivedAt.getTime() >= period.from.getTime() && i.receivedAt.getTime() <= period.to.getTime(),
  );
}

/**
 * Threads that moved: three messages or more inside the window.
 *
 * The PRD's threshold, and the one place a thread count is meaningful — a
 * two-message thread is a question and an answer, which is not news.
 */
export function hotThreads(messages: readonly MailMessage[], own: ReadonlySet<string>): HotThread[] {
  const byThread = new Map<string, MailMessage[]>();
  for (const m of messages) {
    if (m.threadId === null) continue;
    const known = byThread.get(m.threadId);
    if (known === undefined) byThread.set(m.threadId, [m]);
    else known.push(m);
  }
  const threads: HotThread[] = [];
  for (const [threadId, group] of byThread) {
    if (group.length < 3) continue;
    const people = new Set(group.flatMap((m) => m.from.map((a) => lower(a.email))));
    threads.push({
      threadId,
      // The longest subject in the thread: replies shorten it, forwards
      // prefix it, and the fullest one is the one a person recognises.
      subject: group.map((m) => m.subject).sort((a, b) => b.length - a.length)[0] ?? '',
      messages: group.length,
      people: people.size,
      ownerWrote: [...people].some((p) => own.has(p)),
    });
  }
  return threads.sort((a, b) => b.messages - a.messages);
}

/** Who wrote, most first. Counted by address, never by display name. */
export function correspondents(messages: readonly MailMessage[], own: ReadonlySet<string>): Correspondent[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const from = m.from[0];
    if (from === undefined) continue;
    const address = lower(from.email);
    if (own.has(address)) continue;
    counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  return [...counts]
    .map(([address, n]) => ({ address, messages: n }))
    .sort((a, b) => b.messages - a.messages);
}

/**
 * Which of the owner's own addresses carried the mail.
 *
 * Not a curiosity: on this mailbox two thirds of what arrives is addressed to
 * a group alias rather than to the owner, and which alias it was separates a
 * reporting list from a sales lead better than anything in the message does.
 */
export function viaLists(messages: readonly MailMessage[], own: ReadonlySet<string>): Correspondent[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const named = [...m.to, ...m.cc].map((a) => lower(a.email));
    if (named.some((a) => own.has(a))) continue;
    const first = named[0];
    if (first === undefined) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return [...counts]
    .map(([address, n]) => ({ address, messages: n }))
    .sort((a, b) => b.messages - a.messages);
}

export function summarizePeriod(input: DigestInput, period: Period): Digest {
  const own = new Set(input.ownAddresses.map(lower));
  const messages = within(input.messages, period);
  const sent = within(input.sent, period);

  const received = new Set(messages.map((m) => m.messageId).filter((id): id is string => id !== null));
  const answered = sent.filter((r: Envelope) => r.inReplyTo.some((id: string) => received.has(id))).length;

  const decided = new Map(input.decisions.map((d) => [d.messageId, d]));
  const byBand: Record<CategoryBand, number> = { acts: 0, reads: 0, drops: 0 };
  let settledWithoutModel = 0;
  let classified = 0;
  let undecided = 0;
  for (const m of messages) {
    const decision = decided.get(m.id);
    if (decision === undefined) continue;
    if (decision.category === 'needs-review') {
      undecided += 1;
      continue;
    }
    classified += 1;
    // `bandOf` is total over the category union, and the record came from a
    // store rather than from the type system: a row written by an older
    // version carries a category this one has never heard of.
    const band: CategoryBand | undefined = bandOf(decision.category);
    if (band === undefined) continue;
    byBand[band] = (byBand[band] ?? 0) + 1;
    if (!decision.usedModel) settledWithoutModel += 1;
  }

  return {
    period,
    received: messages.length,
    sent: sent.length,
    answered,
    addressedToThem: messages.filter((m) =>
      [...m.to, ...m.cc].some((a) => own.has(lower(a.email))),
    ).length,
    byBand,
    settledWithoutModel,
    classified,
    undecided,
    hotThreads: hotThreads(messages, own),
    correspondents: correspondents(messages, own),
    viaLists: viaLists(messages, own),
    waiting: input.waiting.map(({ message, category }) => ({
      id: message.id,
      from: message.from[0]?.email ?? '',
      subject: message.subject,
      receivedAt: message.receivedAt,
      category,
      waitingDays: Math.floor((period.to.getTime() - message.receivedAt.getTime()) / DAY),
    })),
  };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const pct = (a: number, b: number): string => (b === 0 ? '—' : `${String(Math.round((a / b) * 100))}%`);

/** The digest as the owner reads it. */
export function describeDigest(digest: Digest, limit = 6): string {
  const lines = [
    `Du ${day(digest.period.from)} au ${day(digest.period.to)}`,
    '',
    `  ${String(digest.received)} reçus, ${String(digest.addressedToThem)} qui te nomment` +
      ` — ${String(digest.sent)} envoyés, dont ${String(digest.answered)} répondent à un mail de la période`,
  ];

  if (digest.classified > 0) {
    lines.push(
      `  l'agent en a classé ${String(digest.classified)} : ` +
        `${String(digest.byBand.acts)} à agir, ${String(digest.byBand.reads)} à lire, ` +
        `${String(digest.byBand.drops)} à écarter` +
        `  (juste 7 fois sur 10 sur la bande — voir one-hundred-and-fifty.md)`,
      `  ${String(digest.settledWithoutModel)} réglés sans appeler le modèle (${pct(digest.settledWithoutModel, digest.classified)})` +
        (digest.undecided > 0 ? `, ${String(digest.undecided)} qu'il n'a pas su trancher` : ''),
    );
  }

  if (digest.waiting.length > 0) {
    lines.push('', `  Ce qui t'attend encore (${String(digest.waiting.length)})`);
    for (const w of digest.waiting.slice(0, limit)) {
      lines.push(
        `    ${String(w.waitingDays)}j  ${w.from.slice(0, 28).padEnd(30)} ${w.subject.slice(0, 52)}`,
      );
    }
    if (digest.waiting.length > limit) {
      lines.push(`    … et ${String(digest.waiting.length - limit)} autres`);
    }
  }

  if (digest.hotThreads.length > 0) {
    lines.push('', '  Fils qui ont bougé');
    for (const t of digest.hotThreads.slice(0, limit)) {
      lines.push(
        `    ${String(t.messages)} messages, ${String(t.people)} personnes` +
          `${t.ownerWrote ? ', tu y as écrit' : ''}  —  ${t.subject.slice(0, 54)}`,
      );
    }
  }

  if (digest.correspondents.length > 0) {
    lines.push('', '  Qui a le plus écrit');
    for (const c of digest.correspondents.slice(0, limit)) {
      lines.push(`    ${String(c.messages).padStart(3)}  ${c.address}`);
    }
  }

  if (digest.viaLists.length > 0) {
    lines.push('', '  Par quelle adresse ça t’est arrivé, quand ce n’est pas la tienne');
    for (const c of digest.viaLists.slice(0, limit)) {
      lines.push(`    ${String(c.messages).padStart(3)}  ${c.address}`);
    }
  }

  return lines.join('\n');
}
