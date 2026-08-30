/**
 * Reading the owner's corrections, which are the only feedback a mail agent
 * gets.
 *
 * Nobody writes to tell it that it was wrong. They move the message back, and
 * until this existed nothing looked: the store held every verdict and every
 * filing, and never asked where any of it had ended up.
 *
 * What a correction means depends entirely on what decided the message, and
 * that asymmetry is the point:
 *
 * - Against a **learned pattern** it is counter-evidence, and the ordinary
 *   learning path absorbs it. Nothing here needs to intervene.
 * - Against a **stated route** it may not be absorbed at all. A route is the
 *   owner asserting a fact about their own mail; an agent that quietly
 *   overrode one after three disagreements would be taking back the authority
 *   the provenance rule exists to withhold. Those are surfaced, and only the
 *   owner changes them.
 */

import type { MailService } from '../mail-service.js';
import type { FiledMessage, MailStore } from '../store/mail-store.js';
import type { MailCategory } from '../types.js';
import type { CascadeNode } from './types.js';

export interface Correction {
  readonly messageId: string;
  /** Where the agent put it. */
  readonly filedTo: string;
  /** Where the owner has it now, or `null` when it no longer resolves. */
  readonly foundIn: readonly string[] | null;
  readonly category: MailCategory;
  readonly decidedBy: CascadeNode;
  readonly sender: string | null;
  readonly listId: string | null;
}

export interface CorrectionReport {
  /** How many filed messages were checked. */
  readonly checked: number;
  /** Still where the agent put them. */
  readonly agreed: number;
  readonly corrections: readonly Correction[];
  /**
   * Corrections against something the owner stated, grouped by the route that
   * caused them. These are the ones that need a person.
   */
  readonly disputedRoutes: readonly DisputedRoute[];
}

export interface DisputedRoute {
  readonly sender: string | null;
  readonly listId: string | null;
  readonly category: MailCategory;
  readonly filedTo: string;
  readonly moved: number;
  readonly total: number;
}

/**
 * Compares what the agent filed against where the mail is now.
 *
 * Refuses on a mailbox whose ids do not survive a move. There, a message the
 * agent filed successfully and one the owner took back look identical — every
 * filing would read as a correction, and a feedback loop wrong in that
 * direction would unlearn everything it ever got right.
 */
export async function readCorrections(
  store: MailStore,
  mailbox: MailService,
): Promise<CorrectionReport> {
  if (!mailbox.capabilities.stableIds) {
    throw new Error(
      'corrections need stable message ids; this server reassigns them on a move',
    );
  }

  const filed = store.filed();
  if (filed.length === 0) {
    return { checked: 0, agreed: 0, corrections: [], disputedRoutes: [] };
  }

  const where = await mailbox.locate(filed.map((f) => f.messageId));
  const corrections: Correction[] = [];
  let agreed = 0;

  for (const f of filed) {
    const found = where.get(f.messageId) ?? null;
    // Gone entirely is not a correction. The owner deleting something the
    // agent filed is agreement about where it did not belong, and reading it
    // as a disagreement would teach the opposite of what happened.
    if (found === null) continue;
    if (found.includes(f.filedTo)) {
      agreed += 1;
      continue;
    }
    corrections.push({ ...f, filedTo: f.filedTo, foundIn: found });
  }

  return {
    checked: filed.length,
    agreed,
    corrections,
    disputedRoutes: disputedRoutes(filed, corrections),
  };
}

/**
 * The stated routes the owner keeps overruling.
 *
 * Reported with the total, because three corrections out of four is a route to
 * retire and three out of ninety is a route working as intended.
 */
function disputedRoutes(
  filed: readonly FiledMessage[],
  corrections: readonly Correction[],
): DisputedRoute[] {
  const key = (f: { sender: string | null; listId: string | null }): string =>
    f.listId !== null ? `list:${f.listId}` : `from:${f.sender ?? ''}`;

  const totals = new Map<string, number>();
  for (const f of filed) {
    if (f.decidedBy !== 'stated-route') continue;
    totals.set(key(f), (totals.get(key(f)) ?? 0) + 1);
  }

  const moved = new Map<string, { correction: Correction; count: number }>();
  for (const c of corrections) {
    if (c.decidedBy !== 'stated-route') continue;
    const entry = moved.get(key(c));
    if (entry === undefined) moved.set(key(c), { correction: c, count: 1 });
    else entry.count += 1;
  }

  return [...moved.entries()]
    .map(([k, { correction, count }]) => ({
      sender: correction.sender,
      listId: correction.listId,
      category: correction.category,
      filedTo: correction.filedTo,
      moved: count,
      total: totals.get(k) ?? count,
    }))
    .sort((a, b) => b.moved - a.moved);
}

/** What to tell the owner, naming only what needs them. */
export function describeCorrections(report: CorrectionReport): string {
  if (report.checked === 0) return 'nothing has been filed yet';
  const lines = [
    `${String(report.agreed)} of ${String(report.checked)} filed messages are still where the agent put them`,
  ];
  if (report.corrections.length > 0) {
    lines.push(`${String(report.corrections.length)} were moved back`);
  }
  for (const r of report.disputedRoutes) {
    const source = r.listId !== null ? r.listId : (r.sender ?? '(unknown)');
    lines.push(
      `  your route ${source} -> ${r.category} sent ${String(r.total)} to ${r.filedTo};` +
        ` you took ${String(r.moved)} back. Only you can change a route.`,
    );
  }
  return lines.join('\n');
}
