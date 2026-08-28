# ADR-0002 — One model for all four tiers, and no reasoning model

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** [PRD §3.6](../PRD.md), measured against the live gateway

## Context

[ADR-0001](ADR-0001-topology.md) puts inference on the LINAGORA gateway so that
mail content never leaves the European perimeter. That constraint decides the
model question before preference does: the choice is among what the gateway
serves, not among what exists.

Interrogating the gateway on 2026-08-28 returned seven models:

| Model | Kind |
|---|---|
| `Mistral-Small-3.2-24B-Instruct-2506-FP8` | instruct, 24B |
| `Luciole-23B-Instruct-1.1-FP8` | instruct, 23B |
| `lucie-7b-instruct-v1.1` | instruct, 7B |
| `Qwen3-VL-8B-Instruct-FP8` | vision |
| `Qwen3-Embedding-0.6B` | embedding |
| `gte-multilingual-reranker-base` | reranker |
| `moss-transcribe-diarize` | transcription |

**There is no reasoning model among them.** No R1, no Magistral, no QwQ.

One capability decides the rest. The harness agent loop calls tools, so a model
that cannot emit a tool call cannot drive it. Probing all three chat models with
a real `classify_email` schema:

```
Mistral-Small-3.2-24B → tool call: {"category":"newsletter-tech","confidence":0.95}
Luciole-23B-Instruct  → HTTP 400: "auto" tool choice requires --enable-auto-tool-choice
lucie-7b-instruct     → HTTP 400: same
```

Measured latency for a short completion: 1.7 s to 2.8 s.

## Decision

**Use `Mistral-Small-3.2-24B-Instruct-2506-FP8` for all four tiers**, and ship
no reasoning model in V1.

The tiers — `economy`, `default`, `chat`, `draft` — stay four distinct provider
routes even though they name one model. They differ only in what a call may
spend (512 / 1024 / 2048 / 2048 output tokens). The routing exists before the
models do: repointing a tier at a different model is a configuration edit, and
no consumer changes.

The adapter implements the seam's reasoning-effort surface even though nothing
uses it. A route may declare its selectable levels and how each reaches the
wire; absent that declaration, asking for reasoning is refused rather than
silently ignored. The wire spelling is configuration because there is no single
convention — OpenAI sends `reasoning_effort`, vLLM sends `chat_template_kwargs`
— and hard-coding one would make the adapter wrong for the endpoints it exists
to be generic over.

## Why no reasoning model is the right answer here, not a concession

Classifying a message is short-context labelling, not multi-hop deduction. A
reasoning model pays a thinking-token tax on *every* call, and the cascade's
whole design is about not calling a model at all: seven messages in eleven are
decided before node 6 is reached. At 1.7-2.8 s per call on a mailbox seeing
hundreds of messages a day, that tax is the dominant cost.

The two nodes that look like they want reasoning do not. Brand-spoofing
detection (PRD §4.2 node 5) rests on SPF, DKIM and DMARC, which are
deterministic checks. The learned-pattern health check runs weekly, where
latency is irrelevant.

Where one would genuinely help is `summarize_period` (§4.3), which is
multi-document synthesis, and `draft_reply` on `important` mail, where the PRD
already asks for the premium tier. Both are served by the tier structure the
moment a suitable model appears.

## Consequences

Good:

- One model to operate, one credential, one behaviour to calibrate against.
- Tool calling verified against the real schema the cascade will use.
- A reasoning model becomes a configuration change, not an adapter change.

Costs, accepted knowingly:

- **No fallback model.** Mistral is the only route on the gateway that can
  drive a loop, so an outage degrades the agent to the static cascade with no
  second sovereign option. ADR-0001 already accepts that no non-sovereign
  provider is used as a fallback.
- **Phase 7 has nothing to compare.** The PRD plans A/B testing across models
  on this gateway; today exactly one model qualifies, so the phase is blocked
  on the gateway, not on us.
- **Latency is an order of magnitude above the PRD estimate.** §3.7 anticipates
  100-300 ms; measurement says 1.7-2.8 s. The topology holds, but the cascade's
  hit rate stops being an efficiency metric and becomes the feature.

## What would change this

Ask the gateway operators to start Luciole-23B with `--enable-auto-tool-choice`
and `--tool-call-parser`. That is a server flag, not a model limitation. It
would yield a second sovereign tool-calling model, give Phase 7 something to
compare against, and remove the single point of failure above.

## Alternatives considered

**Luciole-23B as the primary model.** Rejected on measurement: it cannot emit a
tool call as currently served, so it cannot drive the loop.

**A non-sovereign reasoning model for the draft and summary tiers.** Rejected on
ADR-0001's perimeter: those tiers see full message bodies, which is precisely
the content that must not leave.
