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
import { MODEL_UNREACHABLE, runCascade } from './cascade/cascade-loop.js';
import { readCorrections, type CorrectionReport } from './cascade/corrections.js';
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
  /**
   * True when the limit stopped the pass before the changes ran out.
   *
   * The rest are waiting for the next pass, not discarded: the cursor stops
   * where the pass stopped.
   */
  readonly truncated: boolean;
  /**
   * Messages the model could not be asked about.
   *
   * Counted and reported rather than left to be inferred from a pile of
   * `needs-review`: a gateway that is down and a day of unusually ambiguous
   * mail produce the same categories and are not the same problem.
   */
  readonly modelUnreachable: number;
  /** Messages retried because an outage, not the message, produced their verdict. */
  readonly retried: number;
  /**
   * What the owner moved back, or `null` on a server whose ids do not survive
   * a move — there the question cannot be asked rather than answered badly.
   */
  readonly corrections: CorrectionReport | null;
  /**
   * Changed messages the agent had already decided.
   *
   * Mostly its own keyword writes coming back as updates, so a healthy pass
   * has more of these than it classifies once the mailbox is quiet.
   */
  readonly alreadyDecided: number;
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
      alreadyDecided: 0,
      retried: 0,
      corrections: null,
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
  // A message the agent has already decided is not re-decided, and this is not
  // an optimisation.
  //
  // Writing a keyword is an update, and the next poll reports the message as
  // changed — so the agent's own write brings it back to be classified again,
  // every pass, forever. Observed on the first real run: the same newsletter
  // was classified three times in nine minutes, three model calls for one
  // arrival.
  //
  // The exception is a message whose trace says the model could not be
  // reached. Nothing was ever asked about it, so leaving it alone would make a
  // moment's rate limit permanent.
  //
  // An owner moving a message is a correction, and reading that is
  // `readCorrections`'s job, not this one's: re-deciding on the owner's move
  // would silently overwrite the very disagreement worth reading.
  //
  // The limit applies to what is *examined*, not to what is classified, and
  // the cursor then advances to exactly there. An earlier version bounded the
  // classifying and advanced past everything the poll had reported, on the
  // reasoning that a backlog larger than the limit would otherwise be
  // re-polled forever. That reasoning was wrong — each pass advances past what
  // it examined, so each pass makes progress — and what it actually did was
  // discard mail: an agent stopped overnight would meet a backlog of two
  // hundred, classify a hundred, and pass over the rest for good.
  const examined = ids.slice(0, limit);
  const truncated = ids.length > limit;
  const fresh = examined.filter((id) => {
    const seenBefore = store.traceFor(id);
    return seenBefore === null || seenBefore.rationale.startsWith(MODEL_UNREACHABLE);
  });
  const skipped = examined.length - fresh.length;
  const batch = fresh;

  // Messages an outage left unanswered are asked for by name. The poll cannot
  // surface them: it reports what changed, and nothing changes a message that
  // was never successfully classified in the first place.
  const stranded = store
    .unreachable(MODEL_UNREACHABLE, Math.max(0, limit - batch.length))
    .filter((id) => !batch.includes(id));
  const toFetch = [...batch, ...stranded];

  const messages = await mailbox.getMessages(toFetch);
  const byId = new Map(messages.map((m) => [m.id, m]));

  const classified: DecisionTrace[] = [];
  const failures: ExecutionFailure[] = [];
  let performed = 0;
  let proposed = 0;
  let unreachable = 0;

  for (const id of toFetch) {
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
    if (trace.rationale.startsWith(MODEL_UNREACHABLE)) unreachable += 1;
    performed += result.performed.length;
    proposed += result.proposed.length;
    failures.push(...result.failed);
  }

  // The cursor advances to the last change this pass examined, and no further.
  // Everything after it is picked up by the next pass, which is what makes a
  // limit a rate rather than a filter.
  const lastExamined = examined.at(-1);
  const boundary =
    lastExamined === undefined
      ? changes.at(-1)
      : changes.filter((c) => c.id === lastExamined).at(-1);
  if (boundary !== undefined) store.saveCursor(folder, boundary.cursor);

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
    alreadyDecided: skipped,
    retried: stranded.length,
    // Read at the end of the pass, on what this pass has just filed as much as
    // on everything before it. Nobody writes to say the agent was wrong; they
    // move the message, and a pass that never looked would not know.
    corrections: mailbox.capabilities.stableIds ? await readCorrections(store, mailbox) : null,
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
    `${pass.folder}: ${String(pass.seen)} changed, ${String(pass.classified.length)} classified (${mode})` +
      (pass.alreadyDecided > 0 ? `, ${String(pass.alreadyDecided)} already decided` : '') +
      (pass.retried > 0 ? `, ${String(pass.retried)} retried after an outage` : ''),
  ];
  if (pass.truncated) {
    lines.push('  the limit stopped this pass; the rest wait for the next one');
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

  const { corrections } = pass;
  if (corrections !== null && corrections.corrections.length > 0) {
    lines.push(
      `  you moved ${String(corrections.corrections.length)} of ${String(corrections.checked)} filed messages back`,
    );
    for (const route of corrections.disputedRoutes) {
      const source = route.listId ?? route.sender ?? '(unknown)';
      lines.push(
        `    your route ${source} -> ${route.category} sent ${String(route.total)} to ` +
          `${route.filedTo}; you took ${String(route.moved)} back. Only you can change a route.`,
      );
    }
  }
  return lines.join('\n');
}
