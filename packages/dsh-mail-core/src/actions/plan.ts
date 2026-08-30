/**
 * What the agent proposes to do about a classified message, and what it is
 * allowed to do without asking (PRD sections 4.5 and 3.5).
 *
 * Planning is separate from doing, and both are separate from deciding. The
 * cascade says what a message is; this says what would follow; the approval
 * table says which of that runs unattended. Keeping the three apart is what
 * makes a dry run possible at all — and every destructive step this project
 * has taken so far was preceded by one.
 */

import { categoryFallback, destinationFor } from '../mail-service.js';
import { sentinelKeyword, type Capabilities, type MailCategory } from '../types.js';
import type { DecisionTrace } from '../cascade/types.js';
import { approvalFor, type Approval, type ApprovalPolicy, type MailAction } from './approval.js';

export interface PlannedAction {
  readonly messageId: string;
  readonly action: MailAction;
  /** Destination folder, for a move. */
  readonly folder?: string | undefined;
  /** Keywords to add, for a tagging action. */
  readonly keywords?: readonly string[] | undefined;
  readonly approval: Approval;
  /** One line an operator can read in a dry run. Never message content. */
  readonly because: string;
}

/**
 * Turns one decision into the actions that follow from it.
 *
 * Everything a category implies is planned, including what the policy forbids:
 * a plan the owner cannot see is a plan they cannot refuse, and the `ask` and
 * `never` rows are the ones worth reading.
 */
export function planActions(
  trace: DecisionTrace,
  capabilities: Capabilities,
  policy: ApprovalPolicy,
): PlannedAction[] {
  const planned: PlannedAction[] = [];
  const { category, confidence, messageId } = trace;

  // Tagging always follows a classification: it is what the classification
  // *is*, on a server that can store it.
  const fallback = categoryFallback(category);
  const keywords = capabilities.customKeywords
    ? [sentinelKeyword(category)]
    : // A server without custom keywords carries the category in flags and a
      // folder instead (PRD 4.5), which is why the fallback table exists.
      fallback.flags;

  if (keywords.length > 0) {
    planned.push({
      messageId,
      action: 'keyword',
      keywords,
      approval: approvalFor(policy, category, 'keyword', confidence),
      because: capabilities.customKeywords
        ? `tag as ${category}`
        : `no custom keywords on this server; flag as ${category}`,
    });
  }

  // Moving, where the category names a destination (PRD 4.5).
  const folder = destinationFor(category);
  if (folder !== null) {
    planned.push({
      messageId,
      action: 'move',
      folder,
      approval: approvalFor(policy, category, 'move', confidence),
      because: `${category} belongs in ${folder}`,
    });
  }

  // Trashing, where the category is mail the owner does not want at all.
  //
  // Planned rather than moved because the two are not the same act: a move
  // files something the owner keeps, and the trash empties on a timer. Spam
  // still goes to Junk, which is where an owner looks for a false positive.
  if (TRASHED.has(category)) {
    planned.push({
      messageId,
      action: 'trash',
      approval: approvalFor(policy, category, 'trash', confidence),
      because: `${category} is mail the owner does not want`,
    });
  }

  return planned;
}

/**
 * The categories whose mail is trashed rather than filed.
 *
 * One, so far, and it is the largest category in the target mailbox: cold
 * prospecting is 16% of it, ahead of the owner's client correspondence. The
 * owner asked for it to leave without being asked each time.
 */
const TRASHED: ReadonlySet<MailCategory> = new Set(['prospection-commerciale-non-sollicitee']);

/** The subset a caller may perform without asking anyone. */
export function automatic(planned: readonly PlannedAction[]): PlannedAction[] {
  return planned.filter((p) => p.approval === 'auto');
}

/** The subset worth showing an owner, because the agent wants permission. */
export function proposed(planned: readonly PlannedAction[]): PlannedAction[] {
  return planned.filter((p) => p.approval === 'ask');
}

/** Renders a plan for a dry run, one line each, with no message content. */
export function describePlan(planned: readonly PlannedAction[]): string {
  return planned
    .map((p) => {
      const what =
        p.action === 'move' ? `move -> ${p.folder ?? '?'}` : `${p.action} ${(p.keywords ?? []).join(' ')}`;
      return `  ${p.approval.padEnd(5)} ${what.padEnd(38)} ${p.because}`;
    })
    .join('\n');
}
