# Task: implement the seven-node classification cascade

Phase 2 of the PRD, first slice. The contract and the acceptance criterion are
already in the repository, written before this brief. Your job is the
implementation between them.

## What exists

- **`src/cascade/types.ts`** — the whole vocabulary: `CascadeNode`,
  `NodeVerdict`, `CascadeStage`, `CascadeContext`, `LearnedPattern`,
  `DecisionTrace`, `TraceStep`, `ClassifierModel`, `CascadeOptions`,
  `DEFAULT_CONFIDENCE_THRESHOLD`. Read it first. Do not change it.
- **`src/cascade/cascade-loop.ts`** — a stub that rejects. Replace it.
- **`src/cascade/cascade-loop.spec.ts`** — 21 tests, all failing. This is the
  criterion. **Do not edit it.** If you believe a test is wrong, say so in your
  report and leave it failing; a passing suite you rewrote proves nothing.
- **`src/fixtures/corpus.ts`** — 14 labelled cases. Each names the category a
  correct classifier answers *and* the node expected to settle it, plus one
  line saying why. `CORPUS_LEARNED_PATTERNS` holds the patterns case `c14`
  depends on.

## What to produce

`export function runCascade(message, options): Promise<DecisionTrace>` in
`src/cascade/cascade-loop.ts`, running seven nodes in this order (PRD 4.2):

1. **Thread continuity** — when `context.threadCategory` is set, inherit it and
   stop. Zero cost, and it must be first.
2. **Spam prefilter** — read `message.spamHeaders` (`x-spam-*`, lowercased
   keys). Three zones: clean passes through, junk settles as `spam-certain`,
   grey passes through to be decided later. The corpus case `c5` carries a
   score past the junk threshold; read what it actually contains rather than
   assuming a header name.
3. **Learned patterns** — match `context.learnedPatterns` on sender or subject
   substring, case-insensitively. Runs *before* the static rules on purpose.
4. **Static rules** — VIP senders, corporate domains, `List-Unsubscribe`
   (RFC 2369) for the three newsletter sub-categories, and the transactional
   markers the corpus shows. Six cases depend on this node.
5. **Brand spoofing** — a display name claiming a brand while authentication
   fails. The signals are in the headers of case `c7`; read them.
6. **The model** — `options.model`, when it is not `null`. This is the only node
   that leaves the process, and it must not be reached for anything the six
   others settle.
7. **Confidence threshold** — below `options.confidenceThreshold`
   (default `DEFAULT_CONFIDENCE_THRESHOLD`), the answer degrades to
   `needs-review` and `decidedBy` becomes `below-threshold`.

Every run returns a `DecisionTrace` recording every node that ran, in order,
including the ones that declined.

## Constraints

- **TypeScript strict.** No `any`, no `@ts-ignore`, no non-null assertions.
  Named exports only. `private`, never `#`, on anything reached through a
  Cordis service proxy — that is not a style rule, it is a runtime failure.
- **No network, no new dependency.** Node 6 is behind `ClassifierModel`; the
  cascade never constructs an HTTP client.
- **Nothing from a message body or a header value in `rationale`.** Traces are
  exported to CSV and to external observability. A rationale is a short
  sentence about *why*, not a quote of the evidence. Under 200 characters.
- **No credential, ever**, in code, config or trace.
- Comment the *why* where it is not obvious. The house style is in the files
  you are reading; match it.

## How you will know it worked

```bash
cd ~/work/dsh-mail-agent && pnpm run build && pnpm run lint && pnpm run test
```

All three must pass, and `pnpm run test` must report **zero failures across the
whole package**, not only your file. 172 tests passed before this task; the 21
cascade tests are the ones you are adding to that.

Run it. Do not report success without having run it.

## Boundaries

- **Do not edit `cascade-loop.spec.ts`, `types.ts`, or `corpus.ts`.**
- Do not touch the adapters, the auth module, or anything under
  `src/adapters/` and `src/auth/`.
- Do not run `pnpm run test:integration`: it needs mail servers and says
  nothing about this work.
- Do not add a dependency.

## Do not boot the profile you are running in

You are running inside an ACP profile. Do not start it: `dsh --profile <name>`
and `--dump-config` against it can block on a session already holding that
profile. Nothing in this task needs the profile booted — the three commands
above are the whole criterion.
