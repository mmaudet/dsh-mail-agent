# Benchmark: authoring a Cordis bundle in Creator mode

One task, one binary outcome, one variable. Started 2026-08-29 because a
first attempt raised the question of how much of its failure was the model's.

## The task

`docs/tasks/mail-core-plugin.md` — turn `dsh-mail-core` into a mountable
bundle: a plugin entry, a bundle patch, a manifest field, and the profile
mounting it. Real work with real references in the repository, not a puzzle.

## Protocol

Comparability is the whole point, so each run gets the same starting state:

- **Isolated clone** at `29ab741`, the commit before any attempt: no
  `plugin.ts`, no `cordis.patch.yml`, no `dsh` field.
- **Isolated profile**, so a run cannot inherit another's mounting.
- **The correction round is stripped** from the clone's copy of the brief. It
  lists the five defects found in round one; leaving it in would hand later
  runs the answers the first had to find.
- **The acceptance script is stripped** too. The first run did not have it, so
  no other run does either. It stays with the reviewer as the judge.
- **Same prompt, verbatim**, pointing at the brief.

Scored by `scripts/verify-mail-core-bundle.sh`, whose seventh check boots the
profile. Composing is not booting, and every earlier check passes on a row
naming a module with no `apply`.

## Results

| Run | Model | Round | Checks passed | Verdict |
|---|---|---|---|---|
| 1 | `mistralai/mistral-small-2603` | 1 | 1 / 7 | FAIL — reported success on a profile that does not boot |
| 2 | `mistralai/mistral-small-2603` | 2, with defects listed | 4 / 7 | FAIL — code correct, never mounted the bundle |
| 3 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1 | — | **VOID** — stream truncated, see below |
| 4 | `nvidia/nemotron-3-ultra-550b-a55b` | 1 | — | **VOID** — output cap of 1024 cut the write |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b` | 1, cap 16384 | pending | pending |

Run 2 reached PASS only after the reviewer ran `dsh plugin add` by hand. Both
Mistral rounds stopped short of the mounting step the brief named explicitly.

## Run 3 is void, and why that matters

It failed with `STREAM_CLOSED` — the adapter's own error, raised when an SSE
stream ends without the `[DONE]` sentinel. Three checks placed the cause:

- both models send `[DONE]` correctly on a short request, so the adapter is not
  simply too strict;
- the account is not rate limited (`is_free_tier: false`, no limits, $0.19
  used);
- the `:free` variant is served on best-effort capacity and dropped a 293k-token
  request.

**That is a statement about a serving tier, not about a model.** Recording it as
"Nemotron failed" would be false, which is exactly why it is recorded as void
and rerun on the paid variant at the same 262k context as the Mistral runs.

Observation worth keeping from the voided run: before truncating, it read
`index.ts`, `mail-service.ts`, `jmap-adapter.ts`, `mail-ping.ts`, then the
reference plugin and its patch — the files the brief named, in order, before
writing anything. Mistral began writing earlier.

## Three confounds, all mine

Every Nemotron run so far measured this project's own code rather than the
model. Recorded because the pattern is the finding.

**1. `[DONE]` required.** The adapter treated a stream ending without the
sentinel as truncation. Nemotron's provider omits it after delivering a finish
reason, so complete responses were discarded. Fixed: a stream that has said why
generation stopped is complete; one that has not is still truncation.

**2. A cap sized for a different job.** The per-tier output caps — 512, 1024,
2048 — come from PRD §3.6, where they size a call that returns a category and a
confidence. An agent writing a TypeScript module needs an order of magnitude
more. The run died on `Output token limit reached`.

The second is the more instructive, because it did not fail loudly for
everybody. Mistral is terser and fitted under 1024 per step; Nemotron did not.
**A cap that one model clears and another does not measures the cap.** The
benchmark routes now use 16384 on every tier — Nemotron's own ceiling, so
neither model is advantaged.

**3. Attributing run 3 to the free tier.** Three checks supported that reading
and it was still wrong: the paid variant failed identically. The evidence was
consistent with a hypothesis that happened to be false, which is the ordinary
way of being wrong with data in hand.

The honest summary so far: **no run has yet measured Nemotron.** Two measured
the adapter's stream policy, one measured an output cap. That is worth more to
the article than a table of scores would have been, because it is the failure
mode of every casual model comparison — the harness is a variable, and it is
usually invisible.

## Speed, which the outcome does not capture

| Model | tok/s | TTFT |
|---|---|---|
| `mistral-small-2603` | 135–233 | 0.7–0.8 s |
| `nemotron-3-ultra-550b` | 22 | 5.2 s |

A ten-fold difference in throughput matters for a 35-step agent loop even when
the larger model reasons better. A run that succeeds in one round at 22 tok/s
and one that needs three at 200 tok/s are not obviously ordered.

## What this cannot settle

The first run's failure was as much the brief's fault as the model's:
acceptance criteria written in prose invite substitution, and two of three were
satisfied with greps matching the agent's own writes. Replacing them with a
script that exits non-zero changed the outcome for the same model. Any model
comparison here measures behaviour **under an executable criterion**, which is
the only condition worth measuring — but it means the numbers say nothing about
how these models behave under a vaguer brief, which is how most people will
actually use them.
