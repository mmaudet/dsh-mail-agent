/**
 * The `classify_email` tool (PRD sections 4.2 and 3.6).
 *
 * Runs one message through the whole cascade and reports the decision trace,
 * not just the answer. The trace is the point: which node settled it, what the
 * earlier nodes said, and whether the model was consulted at all. That last
 * number is the architecture's own claim about cost, and this is where it
 * becomes observable per message.
 *
 * Writes nothing. Classification and action are separate phases on purpose
 * (PRD section 6): this tool tells you what the agent thinks, and Phase 3
 * decides whether it may act on it.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type {
  CascadeContext,
  ClassifierModel,
  DecisionTrace,
  LearnedPattern,
  RoutingRule,
} from '../cascade/types.js';
import type { MailCategory, MailMessage } from '../types.js';
import { runCascade } from '../cascade/cascade-loop.js';

export const name = 'classify-email';
export const inject = ['tools', 'mailbox'];

/**
 * The per-owner state three of the seven nodes need, read fresh each call.
 *
 * A narrow port rather than `MailStore` itself, so the tool does not depend on
 * `node:sqlite` and a test can hand it three functions.
 */
export interface OwnerState {
  /** Routes the owner stated, for node 2b. */
  loadRoutes(): readonly RoutingRule[];
  /** Patterns the agent learned, for node 3. */
  loadPatterns(): readonly LearnedPattern[];
  /** The category already assigned to a thread the owner acted in, for node 1. */
  threadCategory(threadId: string): MailCategory | null;
}

export interface ClassifyEmailOptions {
  /**
   * What the deterministic nodes know that does not change between messages:
   * the owner, their VIPs, their domains.
   */
  readonly context: CascadeContext;
  /**
   * Where the parts that *do* change come from.
   *
   * Read on every call rather than captured at mount, and that is the whole
   * point: a route added at runtime has to take effect without a restart, or
   * the store is a slower copy of the profile. Three SQLite reads per message
   * against a local file, on a mailbox taking two hundred a day.
   *
   * Absent means nodes 1, 2b and 3 have nothing and decline — which is what
   * they did unconditionally before this existed.
   */
  readonly state?: OwnerState | undefined;
  /**
   * Node 6. `null` when the gateway health check has failed: the cascade then
   * runs static-only and answers `needs-review` rather than throwing
   * (PRD section 3.6).
   */
  readonly model: ClassifierModel | null;
  readonly confidenceThreshold?: number | undefined;
}

/**
 * What the tool answers. A trace, flattened for a schema.
 *
 * Mutable rather than `readonly`: the tool schema describes a JSON value the
 * harness owns once it is returned, and a readonly shape does not satisfy it.
 */
export interface ClassifyEmailResult {
  messageId: string;
  category: string;
  confidence: number;
  decidedBy: string;
  rationale: string;
  usedModel: boolean;
  durationMs: number;
  steps: { node: string; settled: boolean }[];
}

/**
 * The context for one message: the static facts, plus what the store holds now.
 *
 * Without a state source this returns the static context unchanged, which
 * leaves `threadCategory` null and both lists empty — nodes 1, 2b and 3 then
 * decline, exactly as they did when nothing was wired.
 */
export function contextFor(
  message: MailMessage,
  options: ClassifyEmailOptions,
): CascadeContext {
  const { state } = options;
  if (state === undefined) return options.context;
  return {
    ...options.context,
    statedRoutes: state.loadRoutes(),
    learnedPatterns: state.loadPatterns(),
    threadCategory: message.threadId === null ? null : state.threadCategory(message.threadId),
  };
}

export function toResult(trace: DecisionTrace): ClassifyEmailResult {
  return {
    messageId: trace.messageId,
    category: trace.category,
    confidence: trace.confidence,
    decidedBy: trace.decidedBy,
    rationale: trace.rationale,
    usedModel: trace.usedModel,
    durationMs: trace.durationMs,
    steps: trace.steps.map((step) => ({ node: step.node, settled: step.verdict !== null })),
  };
}

export function describe(result: ClassifyEmailResult): string {
  const cost = result.usedModel ? 'model consulted' : 'no model call';
  return (
    `${result.category} (${result.confidence.toFixed(2)}) ` +
    `by ${result.decidedBy}, ${cost}, ${String(result.durationMs)} ms\n` +
    `  ${result.rationale}`
  );
}

export function apply(ctx: Context, options: ClassifyEmailOptions): void {
  ctx.tools.register(
    defineTool({
      name: 'classify_email',
      description:
        'Classify one message with the seven-node cascade and report the decision ' +
        'trace: the category, the confidence, which node settled it, and whether ' +
        'the model was consulted. Writes nothing.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'The message id, as listFolders and queryChanges report it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            messageId: { type: 'string', required: true },
            category: { type: 'string', required: true },
            confidence: { type: 'number', required: true },
            decidedBy: { type: 'string', required: true },
            rationale: { type: 'string', required: true },
            usedModel: { type: 'boolean', required: true },
            durationMs: { type: 'number', required: true },
            steps: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  node: { type: 'string', required: true },
                  settled: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: describe(value) }],
      },
      async execute(args, exec) {
        const [message] = await ctx.mailbox.getMessages([args.id]);
        exec.signal.throwIfAborted();
        // A missing message is an ordinary outcome — it was moved, or expunged
        // between the poll and the call — and the caller needs to hear which.
        if (message === undefined) throw new Error(`No such message: ${args.id}`);

        const trace = await runCascade(message, {
          context: contextFor(message, options),
          model: options.model,
          confidenceThreshold: options.confidenceThreshold,
        });
        return toResult(trace);
      },
    }),
  );
}
