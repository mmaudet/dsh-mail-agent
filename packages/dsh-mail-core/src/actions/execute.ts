/**
 * Doing what the plan says, and only the part the owner already agreed to.
 *
 * Three properties this is arranged around, each of them learned rather than
 * assumed:
 *
 * - **The trace is written before the mailbox is.** An action without a
 *   recorded reason is one nobody can argue with afterwards, and a write that
 *   succeeds while its explanation is lost is worse than one that fails.
 * - **Tag before move.** On IMAP a move assigns a new UID, so the id the plan
 *   was made against stops resolving the moment the message leaves. Anything
 *   addressed to the old id has to happen first.
 * - **One failure does not stop the batch.** A poll covers a hundred messages;
 *   a folder that cannot be created is one message's problem, and abandoning
 *   the other ninety-nine is not a safer outcome.
 */

import type { MailService } from '../mail-service.js';
import type { DecisionTrace } from '../cascade/types.js';
import type { MailStore, TraceSource } from '../store/mail-store.js';
import type { PlannedAction } from './plan.js';

export interface ExecuteOptions {
  /**
   * Where the classified message came from, recorded beside its verdict.
   *
   * Optional because a caller that only wants the actions performed should not
   * have to assemble it — but a caller that omits it is writing a trace node 3
   * cannot learn from.
   */
  readonly source?: TraceSource | undefined;
  /**
   * Default. Nothing reaches the mailbox, and the result says what would have.
   *
   * Every destructive step this project has taken was preceded by one of
   * these, and the one time a dry run was skipped it was because a helper did
   * not exist yet — which the dry run then caught.
   */
  readonly dryRun?: boolean | undefined;
}

export interface ExecutionFailure {
  readonly action: PlannedAction;
  readonly error: string;
}

export interface ExecutionResult {
  /** Performed, or would have been under `dryRun`. */
  readonly performed: readonly PlannedAction[];
  /** Waiting on the owner. */
  readonly proposed: readonly PlannedAction[];
  /** Not offered by the policy at all. */
  readonly refused: readonly PlannedAction[];
  readonly failed: readonly ExecutionFailure[];
  readonly dryRun: boolean;
}

/**
 * Applies the automatic part of a plan.
 *
 * The trace is recorded first and unconditionally: it is the record of what
 * the agent decided, which is true whether or not the mailbox accepted the
 * consequence.
 */
export async function executePlan(
  trace: DecisionTrace,
  plan: readonly PlannedAction[],
  mailbox: MailService,
  store: MailStore,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const dryRun = options.dryRun ?? true;

  // Before anything is written, and in a dry run too: a plan that was
  // considered and not applied is still a decision worth having a record of.
  //
  // The source goes in with it. A verdict without the sender that produced it
  // is a decision node 3 can never learn from, which is the state the store was
  // in while its learning functions sat unused.
  store.recordTrace(trace, options.source ?? {});

  const performed: PlannedAction[] = [];
  const failed: ExecutionFailure[] = [];

  // Tag first, then move. The plan is already in that order; sorting here
  // makes it a property of execution rather than of whoever built the list.
  const automatic = plan
    .filter((p) => p.approval === 'auto')
    .sort((a, b) => rank(a) - rank(b));

  for (const action of automatic) {
    if (dryRun) {
      // Recorded as would-have-done, and deliberately not as filed: a dry run
      // touches no mailbox, so claiming the agent put the message somewhere
      // would manufacture a correction the moment anyone looked for one.
      performed.push(action);
      continue;
    }
    try {
      await perform(action, mailbox);
      performed.push(action);
      // A move that ran is the agent's claim on record. Where the message is
      // later is then either agreement or a correction, and without this the
      // two are indistinguishable from a message whose move was never
      // approved.
      if (action.action === 'move' && action.folder !== undefined) {
        store.recordFiled(action.messageId, action.folder);
      }
    } catch (err: unknown) {
      // A folder that cannot be created is one message's problem.
      failed.push({ action, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    performed,
    proposed: plan.filter((p) => p.approval === 'ask'),
    refused: plan.filter((p) => p.approval === 'never'),
    failed,
    dryRun,
  };
}

/** Tag before move: a moved message no longer answers to the id in the plan. */
function rank(action: PlannedAction): number {
  return action.action === 'move' ? 1 : 0;
}

async function perform(action: PlannedAction, mailbox: MailService): Promise<void> {
  switch (action.action) {
    case 'keyword':
      await mailbox.setKeywords(action.messageId, [...(action.keywords ?? [])]);
      return;
    case 'move':
      if (action.folder === undefined) throw new TypeError('a move with no destination');
      await mailbox.moveMessage(action.messageId, action.folder);
      return;
    default:
      // `trash`, `draft` and `send` are never automatic under any policy this
      // project ships, so reaching here means a policy granted something the
      // executor cannot do — which is a configuration error worth hearing
      // about rather than a no-op to swallow.
      throw new TypeError(`${action.action} cannot run unattended`);
  }
}

/** Renders a result for an operator, with no message content in it. */
export function describeResult(result: ExecutionResult): string {
  const lines = [
    result.dryRun ? 'dry run — nothing was changed' : 'applied',
    `  performed : ${String(result.performed.length)}`,
    `  proposed  : ${String(result.proposed.length)} awaiting the owner`,
    `  refused   : ${String(result.refused.length)} not offered by the policy`,
  ];
  if (result.failed.length > 0) {
    lines.push(`  failed    : ${String(result.failed.length)}`);
    for (const f of result.failed.slice(0, 5)) {
      lines.push(`    ${f.action.action} — ${f.error.slice(0, 90)}`);
    }
  }
  return lines.join('\n');
}
