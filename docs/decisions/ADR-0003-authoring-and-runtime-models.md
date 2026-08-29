# ADR-0003 — The model that writes the agent is not the model that runs it

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes in part:** [ADR-0002](ADR-0002-model-selection.md), which treats
  model choice as one decision

## Context

[ADR-0002](ADR-0002-model-selection.md) picks one model for all four tiers and
implicitly answers a second question it never asks: which model *builds* the
agent. Writing Cordis plugins in Creator mode and classifying a message are
different jobs, and the PRD assumes a single model serves both.

They are not comparable workloads. Measured on this project:

| | Authoring a bundle | Classifying a message |
|---|---|---|
| Steps per task | 35 | 1 |
| Input tokens | 1.2M – 1.9M | 1k – 2k |
| Output | a module, a patch, a manifest | a category and a confidence |
| Demands | multi-file coherence, holding a plan | one label, one number |
| Frequency | a handful of sessions | hundreds a day |
| Sees mail content | **no** | **yes** |

The last two rows are the ones that matter, and they point in opposite
directions.

## Decision

**Treat them as two independent choices.**

The loop model is a profile decision, set on the `agent-default-model` row in a
profile's own `cordis.patch.yml`. The tools' models are bundle routes,
`mail-llm-*`, set in the bundle patch. Nothing couples them, and the
architecture already allowed this before it was named:

```yaml
# profile: who writes the agent
- id: agent-default-model
  config:
    provider: mail-llm-draft        # or an authoring-only route

# bundle: what the agent uses on every message
- id: mail.llm.openai
  config:
    tiers:
      economy: { }                  # classification, the high-volume tier
```

Authoring may use the strongest model available, including one outside the
sovereign perimeter. Classification uses the smallest model that passes
calibration, inside it.

## Why the split is not a compromise

**Sovereignty applies to one side only.** Creator mode reads source files and
writes TypeScript; no message body reaches it. A frontier model authoring a
plugin moves no mail out of the perimeter, and the perimeter argument of
[ADR-0001](ADR-0001-topology.md) is untouched by that choice. Classification
sees whole messages, and that is where the constraint bites.

**Cost runs the other way.** Authoring is rare and expensive per call;
classification is constant and cheap per call. Paying frontier prices for a
handful of sessions and small-model prices for hundreds of daily
classifications is the correct shape, and the single-model assumption gets it
backwards whichever model it picks.

**The evidence points the same way.** A 24B model emitted a correct tool call
against the real `classify_email` schema on the first attempt — the
classification job is within reach of a small model. The same model, on the
authoring job, failed to complete the task in two rounds. One model cannot be
right for both unless the harder job is overpaid for or the easier one is
underserved.

## Consequences

- Two model decisions to keep current instead of one, in two files.
- A benchmark for authoring says nothing about classification, and the reverse.
  They need separate calibration and separate regression tests.
- The sovereign story becomes precise rather than absolute: *mail content never
  leaves the perimeter* is the claim worth defending, and it survives an
  authoring model that does.

## What would make this stronger

An open-weights model small enough to run on one GPU that passes the authoring
benchmark. That would put both halves inside the perimeter and remove the
asymmetry entirely, rather than justifying it. Candidates on the current
gateway are the 27B-dense and 30B-a3b classes; that measurement is open.
