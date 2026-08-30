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

import { categoryFallback } from '../mail-service.js';
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
  const folder = destinationFor(category, capabilities, fallback.folder);
  if (folder !== null) {
    planned.push({
      messageId,
      action: 'move',
      folder,
      approval: approvalFor(policy, category, 'move', confidence),
      because: `${category} belongs in ${folder}`,
    });
  }

  return planned;
}

/**
 * Where a category's mail goes, or `null` when it stays where it is.
 *
 * `important`, `standard` and `needs-review` have no destination by design:
 * the first two are the owner's to read where they left them, and the third is
 * the cascade saying it does not know, which is not a reason to move anything.
 */
function destinationFor(
  category: MailCategory,
  capabilities: Capabilities,
  fallbackFolder: string | null,
): string | null {
  switch (category) {
    case 'newsletter-tech':
      return 'Newsletters/Tech';
    case 'newsletter-promo':
      return 'Newsletters/Promo';
    case 'newsletter-notification':
      return 'Newsletters/Notifications';
    case 'spam-certain':
    case 'spam-probable':
      return 'Junk';
    case 'transactional':
      // PRD 4.5 keeps it in the inbox for a day and archives it after. The
      // delay belongs to the scheduler; what is planned here is the
      // destination, and a server with no archive folder — Gmail — has none to
      // offer.
      return capabilities.customKeywords ? 'Archives/Transactions' : fallbackFolder;
    default:
      return null;
  }
}

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
