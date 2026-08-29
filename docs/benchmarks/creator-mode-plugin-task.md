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

Scored by `scripts/verify-mail-core-bundle.sh`, whose last check boots the
profile. Composing is not booting, and every earlier check passes on a row
naming a module with no `apply`.

## Results

| Run | Model | Round | Checks passed | Verdict |
|---|---|---|---|---|
| 1 | `mistralai/mistral-small-2603` | 1 | 1 / 7 | FAIL — reported success on a profile that does not boot |
| 2 | `mistralai/mistral-small-2603` | 2, with defects listed | 4 / 7 | FAIL — code correct, never mounted the bundle |
| 3 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1 | — | **VOID** — stream truncated, see below |
| 4 | `nvidia/nemotron-3-ultra-550b-a55b` | 1 | — | **VOID** — output cap of 1024 cut the write |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b` | 1, pinned upstream, cap 32768 | 3 / 7 | FAIL — reported success against a different profile |
| 6 | `nvidia/nemotron-3-ultra-550b-a55b` | 2, with defects listed | **7 / 7** | **PASS**, unaided |
| 7 | `deepseek/deepseek-v4-pro` | 1 | — | **VOID** — the brief pointed it at the finished work |
| 8 | `qwen/qwen3.8-27b` | 1, over ACP | — | **VOID** — driver dropped the consent request |
| 9 | `deepseek/deepseek-v4-pro` | 2, over ACP | — | **VOID** — same, stalled asking to mount |

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

## Run 5: the first that measured a model

Nemotron completed the task and reported three checks passing. All three were
run against **`mail-agent-dev`** — the working profile, where the task was
already done and merged — rather than `ab-nemotron`, the benchmark clone it had
been working in. It built one repository and verified another.

Scored against the right target: **3 / 7**, and one of those three is vacuous
(the profile boots because nothing was mounted into it).

What it got right, and Mistral had not: `dsh.bundle.patch` in the correct
object shape, and `./cordis.patch.yml` added to `exports`. What it got wrong is
the same blocking defect Mistral hit in round one:

```yaml
name: '@dsh-mail-agent/mail-core'    # resolves to index.js, which has no apply
```

No `./plugin` subpath export, so the plugin entry is unreachable. And, like
both Mistral rounds, it never ran `dsh plugin add`.

### The comparison, such as it is

| | Mistral round 1 | Nemotron round 1 |
|---|---|---|
| Checks passed | 1 / 7 | 3 / 7 |
| Blocking defect | row names package root | row names package root |
| Mounted the bundle | no | no |
| Claimed success | yes | yes |
| Verified against | its own greps | a different profile |

Two models, three rounds between them, and **the same two failures every
time**: naming the package root instead of the subpath export, and skipping
the mounting step the brief states explicitly. That the failure is identical
across a 24B and a 550B model says it is not a capacity problem. Both had the
working example open — `dsh-llm-openai` declares the analogous export — and
neither generalised from it.

Nemotron's verification failure is the more interesting one. Mistral grepped
its own writes, which is circular. Nemotron ran real commands that would have
been correct in another directory: it substituted the familiar profile name for
the one it was working in. The output was truthful about a system nobody had
asked about.

## Run 6: the first unaided pass

Nemotron cleared all seven checks, mounted the bundle itself, and ran the
script before claiming anything. Its report matched the result.

It also found a defect nobody had listed. Boot failed with a service already
registered; it traced that to a redundant `ctx.provide('mailbox', …)` beside
the `super(ctx, 'mailbox')` the service constructor already performs, and
removed it. That is debugging from a symptom, not pattern completion.

| | Mistral round 2 | Nemotron round 2 |
|---|---|---|
| Checks passed | 4 / 7 | **7 / 7** |
| Mounted the bundle | no — the reviewer did it | yes |
| Ran the acceptance script | no | yes |
| Claim matched result | no | yes |

On this task, the larger model finished and the smaller one did not.

### The asymmetry in how they were treated

Mistral's correction brief listed **five** defects, from a hand review of its
code. Nemotron's listed **three**, derived from the script output. That
difference decided part of the result, and it shows in what each still ships.

Both models wrote a transport that POSTs method calls straight to the JMAP
session resource. RFC 8620 §2 makes that a discovery document: it is fetched,
`apiUrl` is read from it, and calls go there. Mistral's round two fixed it
because the brief said so. **Nemotron's code still has it, because nobody told
it, and seven checks out of seven passed anyway.**

That is the finding to keep. The script tests structure and boot; it never
opens a JMAP connection, which the brief said was out of scope. A green
acceptance run means the seven things were satisfied — no more. Both models
produced the same protocol error independently, and only a human review caught
it either time.

## The brief leaked the answer

`ab-deepseek`'s `plugin.ts` is byte-identical to the reviewed implementation in
the working repository, down to the comments, differing only by a trailing
newline. It did not author it. It copied it — from `~/work/dsh-mail-agent`,
because the brief told it to build there.

That is not the model cutting a corner. It was pointed at a repository where
the task was already complete and told to work with it. **Run 7 measures
nothing about DeepSeek.**

Two things make this worse than an ordinary mistake. The finished plugin had
been in that repository since 07:44, so the leak was open for every run after
it. And the leak is invisible in the outcome: a copied solution passes every
structural check, and would have scored well had the mounting step not failed
independently.

Nemotron did not copy — its `plugin.ts` diverges from the reference by 166
lines and carries a protocol bug the reference does not have. Its runs stand.
Mistral's predate the reference existing. So the damage is confined to run 7,
but only by luck: nothing in the protocol prevented it.

## A fourth confound, and it invalidates part of the table

The benchmark brief was cloned without adapting it. Every copy told the model
to mount into **`mail-agent-dev`** and to build **`~/work/dsh-mail-agent`** —
the working profile and the working repository, not the isolated clone the run
was supposed to happen in.

So the two failures that looked like the clearest model behaviour were partly
mine:

- **Nemotron run 5** was recorded as "reported success against a different
  profile". It verified `mail-agent-dev` because the brief named
  `mail-agent-dev`, in the same sentence that told it what to check. That
  characterisation was unfair and is withdrawn.
- **Every first round skipped the mounting step.** With the brief naming
  another profile, "did not mount into its own profile" is not evidence about
  the model.

What survives: the mounting step was skipped or misdirected in every first
round, across three models. That is still a real signal about how a stated
step in prose fares against everything else in a long task — but it is a
weaker claim than the table implied.

The briefs are now parameterised per bench. Runs before this correction are
comparable to each other and not to what follows.

### What DeepSeek did get right

Checks 1-3 pass, and its manifest work is the most thorough of the three: it
declared the `./plugin` subpath export **and** re-exported `apply`, `name` and
`inject` from `index.ts`, so the row resolves either way. It was also the only
model to plan before writing — five explicit tasks, revised mid-course — and
the only one to notice that `applyMailPing(ctx)` registers into `ctx.tools`
while reasoning about ordering.

## A fifth confound: the mounting step was impossible, not skipped

Every run so far has failed or been marked down on the same step — mounting the
bundle into the profile. Read back, that step could not succeed in the ACP
setup at all, for two independent reasons.

**The sandbox denies it.** `dsh plugin add` writes to
`~/.dsh/profiles/<name>/package.json`. The profile directory is outside the
workspace, and the sandbox policy is workspace-write. So the one command the
brief names explicitly is denied by default.

That part is correct behaviour and the agent handled it correctly: DeepSeek hit
the denial, recognised it, and escalated with a justification naming the exact
path and the reason. Which is where the second reason bit.

**The driver never answered.** DSH asks the client for consent on
`session/request_permission` — a request, with an id, that the agent blocks on.
`scripts/acp-run.py` routed inbound frames to either a pending reply or a
notification handler that ignores anything but `session/update`. A request has
an id and a method and no result, so it matched neither branch and was dropped
without a trace. The agent waited for an answer that was never coming, and the
run died 600 seconds later on the stall detector.

So the transcript reads as a model going quiet mid-task. It was a model waiting
politely for a permission dialog nobody was rendering.

This one is worse than the other four, because it does not merely add noise —
it makes the discriminating step unreachable. **"Did not mount the bundle" has
been the single recurring finding of this benchmark, and under ACP it was not a
finding at all.** Every ACP run is void for that criterion.

The driver now answers: `allow_once` by default, logged, with
`ACP_PERMISSION=reject` to measure the opposite. Verified end to end before
relaunching, on a command that writes outside the workspace and observing the
file appear. Answering an unimplemented client method with method-not-found
rather than silence is part of the same fix: a capability this driver lacks
should fail a call, not hang a run.

### The pattern, now with five instances

| # | What looked like a model failure | What it was |
|---|---|---|
| 1 | Nemotron truncated its stream | the adapter demanded a `[DONE]` sentinel |
| 2 | Nemotron stopped mid-write | an output cap sized for classification |
| 3 | the `:free` tier dropped the request | the paid tier failed identically |
| 4 | models verified the wrong profile | the brief named the wrong profile |
| 5 | models "skipped" the mounting step | the driver hung on the consent request |

Five for five. Not one of the failures this benchmark has produced so far has
turned out to be about a model. The instrument was the finding every time, and
the only reason any of them surfaced is that a script exits non-zero where prose
would have been satisfied.

## The earlier confounds, also mine

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
