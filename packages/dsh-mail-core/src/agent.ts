/**
 * The loop. Everything else in this package is machinery it drives.
 *
 * Until this existed, `learn`, `readCorrections`, `executePlan` and
 * `planActions` had no caller outside their own files, and `runCascade` ran
 * only when a model asked `classify_email` about one message. The store was
 * empty in production, so the learning pass had nothing to learn from and the
 * correction pass had nothing to read.
 *
 * One pass does: resume, poll, classify, plan, act, record, save. It is
 * deliberately not a service — Phase 4 owns the scheduler — so that the first
 * real run against a real mailbox is something a person starts and watches.
 *
 * Writing is off unless asked for. `executePlan` already defaults that way and
 * this passes the choice through rather than deciding it, because the whole
 * point of the approval policy is that what runs unattended is a decision the
 * owner made and can read.
 */

import { DEFAULT_POLICY, type ApprovalPolicy } from './actions/approval.js';
import { executePlan, type ExecutionFailure } from './actions/execute.js';
import { planActions } from './actions/plan.js';
import { runCascade } from './cascade/cascade-loop.js';
import type { CascadeContext, ClassifierModel, DecisionTrace } from './cascade/types.js';
import type { MailService } from './mail-service.js';
import type { MailStore } from './store/mail-store.js';
import type { MailCategory, MailMessage } from './types.js';

export interface AgentOptions {
  readonly mailbox: MailService;
  readonly store: MailStore;
  /** What the deterministic nodes know that does not change between messages. */
  readonly context: CascadeContext;
  /** Node 6, or `null` for a static-only pass (PRD section 3.6). */
  readonly model: ClassifierModel | null;
  readonly policy?: ApprovalPolicy | undefined;
  readonly folder?: string | undefined;
  /** Writes nothing unless this is explicitly false. */
  readonly dryRun?: boolean | undefined;
  /**
   * Most messages to handle in one pass.
   *
   * A bound rather than a tuning knob: this mailbox takes two hundred messages
   * a day, and a first real run that meets a weekend's backlog should stop
   * somewhere a person can still read.
   */
  readonly limit?: number | undefined;
  readonly confidenceThreshold?: number | undefined;
}

export interface AgentPass {
  readonly folder: string;
  /** True when the folder had no stored cursor and this pass started from now. */
  readonly coldStart: boolean;
  readonly seen: number;
  readonly classified: readonly DecisionTrace[];
  readonly performed: number;
  readonly proposed: number;
  readonly failures: readonly ExecutionFailure[];
  readonly dryRun: boolean;
  /** True when the limit stopped the pass before the changes ran out. */
  readonly truncated: boolean;
  /**
   * Messages the model could not be asked about.
   *
   * Counted and reported rather than left to be inferred from a pile of
   * `needs-review`: a gateway that is down and a day of unusually ambiguous
   * mail produce the same categories and are not the same problem.
   */
  readonly modelUnreachable: number;
}

/**
 * One pass over what has changed since the last one.
 *
 * A cold start reads the folder's current position and stores it without
 * classifying anything. That is the honest behaviour for a contract that
 * cannot enumerate a mailbox: the alternative is to classify whatever the
 * first poll happens to return, which on a mailbox with history means
 * classifying an arbitrary slice of the past and calling it "new".
 */
export async function runAgent(options: AgentOptions): Promise<AgentPass> {
  const folder = options.folder ?? 'INBOX';
  const policy = options.policy ?? DEFAULT_POLICY;
  const dryRun = options.dryRun ?? true;
  const limit = options.limit ?? 100;
  const { mailbox, store } = options;

  const stored = store.loadCursor(folder);
  if (stored === null) {
    store.saveCursor(folder, await mailbox.currentCursor(folder));
    return {
      folder,
      coldStart: true,
      seen: 0,
      classified: [],
      performed: 0,
      proposed: 0,
      failures: [],
      dryRun,
      truncated: false,
      modelUnreachable: 0,
    };
  }

  const changes = await mailbox.queryChanges(folder, stored);
  // A message can be reported more than once in a batch — created then
  // updated — and classifying it twice would write two traces for one arrival
  // and count it twice in every measurement built on them.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.kind === 'destroyed') continue;
    if (seen.has(change.id)) continue;
    seen.add(change.id);
    ids.push(change.id);
  }
  const truncated = ids.length > limit;
  const batch = ids.slice(0, limit);

  const messages = await mailbox.getMessages(batch);
  const byId = new Map(messages.map((m) => [m.id, m]));

  const classified: DecisionTrace[] = [];
  const failures: ExecutionFailure[] = [];
  let performed = 0;
  let proposed = 0;
  let unreachable = 0;

  for (const id of batch) {
    const message = byId.get(id);
    // Moved or expunged between the poll and the fetch. Ordinary, and not a
    // reason to stop the pass.
    if (message === undefined) continue;

    const trace = await runCascade(message, {
      context: contextFor(message, options),
      model: options.model,
      confidenceThreshold: options.confidenceThreshold,
    });
    const result = await executePlan(
      trace,
      planActions(trace, mailbox.capabilities, policy),
      mailbox,
      store,
      { dryRun, source: sourceOf(message) },
    );

    classified.push(trace);
    if (trace.rationale.startsWith('the model could not be reached')) unreachable += 1;
    performed += result.performed.length;
    proposed += result.proposed.length;
    failures.push(...result.failed);
  }

  // The cursor advances over everything the poll reported, including what the
  // limit deferred — otherwise a backlog larger than the limit is re-polled
  // forever and the pass never reaches the present.
  //
  // What that costs is named rather than hidden: `truncated` says the deferred
  // messages were passed over, and they are not coming back.
  const last = changes.at(-1);
  if (last !== undefined) store.saveCursor(folder, last.cursor);

  return {
    folder,
    coldStart: false,
    seen: ids.length,
    classified,
    performed,
    proposed,
    failures,
    dryRun,
    truncated,
    modelUnreachable: unreachable,
  };
}

/** The live half of the context, read per message rather than captured. */
function contextFor(message: MailMessage, options: AgentOptions): CascadeContext {
  const { store } = options;
  return {
    ...options.context,
    statedRoutes: store.loadRoutes(),
    learnedPatterns: store.loadPatterns(),
    threadCategory: message.threadId === null ? null : store.threadCategory(message.threadId),
  };
}

/** What the trace needs to be learnable from, which the trace does not carry. */
function sourceOf(message: MailMessage): {
  threadId: string | null;
  sender: string | null;
  listId: string | null;
} {
  return {
    threadId: message.threadId,
    sender: message.from[0]?.email ?? null,
    listId: message.listId,
  };
}

/** What a pass did, for someone watching the first real one. */
export function describePass(pass: AgentPass): string {
  if (pass.coldStart) {
    return (
      `${pass.folder}: cold start, cursor stored at the current position.\n` +
      '  Nothing classified: the contract cannot enumerate a mailbox, so a first\n' +
      '  pass starts from now and the next one sees what arrives after it.'
    );
  }

  const mode = pass.dryRun ? 'dry run — nothing was written' : 'writing';
  const lines = [
    `${pass.folder}: ${String(pass.seen)} changed, ${String(pass.classified.length)} classified (${mode})`,
  ];
  if (pass.truncated) {
    lines.push(`  the limit stopped this pass; the rest were passed over, not deferred`);
  }
  lines.push(`  performed ${String(pass.performed)}   proposed ${String(pass.proposed)}   failed ${String(pass.failures.length)}`);

  const byCategory = new Map<MailCategory, number>();
  const byNode = new Map<string, number>();
  for (const t of pass.classified) {
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
    byNode.set(t.decidedBy, (byNode.get(t.decidedBy) ?? 0) + 1);
  }
  const free = pass.classified.filter((t) => !t.usedModel).length;
  if (pass.classified.length > 0) {
    lines.push(`  settled without the model: ${String(free)}/${String(pass.classified.length)}`);
    for (const [node, n] of [...byNode.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(n).padStart(4)}  ${node}`);
    }
    for (const [category, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(n).padStart(4)}  ${category}`);
    }
  }
  if (pass.modelUnreachable > 0) {
    lines.push(
      `  the model could not be reached for ${String(pass.modelUnreachable)} of them —` +
        ' those are `needs-review` because nothing asked, not because nothing was clear',
    );
  }
  for (const f of pass.failures) lines.push(`  failed: ${f.action.action} ${f.error}`);
  return lines.join('\n');
}
