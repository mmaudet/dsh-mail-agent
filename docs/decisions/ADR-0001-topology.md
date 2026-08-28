# ADR-0001 — Distributed topology: DSH on Athena, inference on the LINAGORA gateway

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** [PRD §3.7](../PRD.md)

## Context

The agent is not request-driven. A daily and a weekly scheduler, a delta poll, a persistent
IMAP `IDLE` and a JMAP `PushSubscription` all have to keep running whether or not a laptop is
open. Anything that lives on the development machine stops being a service the moment the lid
closes.

Two other constraints shape the answer. Mail content must stay inside a European perimeter,
which rules out routing inference through a non-sovereign provider. And the operator is one
person, so anything with more moving parts than necessary will rot.

## Decision

Run DSH centrally on **Athena** (Debian VPS, systemd, Tailscale) and push inference out to the
**LINAGORA OpenAI-compatible gateway** on OVH infrastructure. The MacBook becomes a pure
development workstation.

```
 +---------------------------------------------+     +--------------------------------+
 |  Athena VPS (Debian, systemd, Tailscale)    |     |  MacBook Pro (macOS, Tailscale)|
 |                                             |     |                                |
 |  * dsh --profile mail-agent (systemd svc)   |     |  * Claude Code (dev)           |
 |  * internal cron scheduler                  |     |  * SSH client to Athena        |
 |  * IMAP IDLE / JMAP PushSubscription        |     |  * browser -> DSH web UI       |
 |  * decision traces (SQLite)                 |     |    via ssh -L or tailscale     |
 |  * web UI bound to 127.0.0.1:3080           |     |                                |
 +---------------------------------------------+     +--------------------------------+
              |                    |
              v                    v
       mail server          HTTPS bearer
      (JMAP or IMAP)                |
                                    v
                +---------------------------------------+
                |  LINAGORA LLM gateway (OVH)           |
                |  chat.lucie.ovh.linagora.com/v1/      |
                |  Mistral-Small-3.2-24B-Instruct-FP8   |
                +---------------------------------------+
```

**On Athena:** Node 22, pnpm, DSH cloned and built (`0.1.2-alpha.1`), the `mail-agent-dev` and
`mail-agent-prod` profiles, a `dsh-mail-agent.service` unit with `Restart=always`, SQLite for
decision traces, cursors, learned patterns and the style profile, and
`MAIL_SENTINEL_API_KEY` held encrypted in `dsh-secrets`. No local model, no `llama.cpp`, no
`mlx_lm.server`: inference leaves over HTTPS with a bearer token.

**On the MacBook:** Claude Code, `gh`, an SSH client and a browser. Nothing the service depends
on.

**Network posture:** DSH binds `127.0.0.1`, never `0.0.0.0`. Nothing listens on the public
internet; admin access is SSH or Tailscale. Outbound calls are restricted to an allow-list
(`trusted_endpoints_only`). The web UI is reached with `ssh -L 3080:127.0.0.1:3080 athena` or
with `tailscale serve`.

**Profile split:** `mail-agent-dev` for Creator mode, `mail-agent-prod` for the 24/7 systemd
service. Creator mode is treated as shell access and never runs against the prod profile.

## Consequences

Good:

- The scheduler, IDLE and push run continuously without the laptop.
- Mail content moves only between a sovereign VPS and a LINAGORA/OVH endpoint.
- No local models to download, serve or keep current.
- One credential to manage, already provisioned.
- Dev and prod share a host but not a profile.

Costs, accepted knowingly:

- **Network dependency.** If the gateway or Athena's egress is down, the agent degrades to the
  static cascade and makes no model calls. No non-sovereign provider is used as a fallback,
  by design.
- **Latency.** Roughly 100-300 ms per call. Acceptable for mail, which is not real-time.
- **Interactive OAuth bootstrap.** The IdP callback has to reach Athena, so initial auth needs a
  one-off `ssh -L 8765:127.0.0.1:8765 athena`. Once the refresh token is encrypted at rest, the
  tunnel is no longer needed.
- **No "runs entirely on my laptop" demo.** Apple Silicon local inference is deferred to an
  optional V2 (PRD §9.2).

## Superseded in part

The sovereignty claim above held while every tier fit inside the gateway. It no
longer describes the deployment: the gateway caps a request at 16 384 tokens
total, so the summary, chat and draft tiers now run on OpenRouter.
[ADR-0002](ADR-0002-model-selection.md) records what moved, what stayed, and
what it costs. The topology — the agent on Athena, no local models, nothing
listening publicly — is unchanged.

## Alternatives considered

**Inference local to the MacBook** (MLX or `llama.cpp`), with DSH on the laptop. Rejected: the
service would only run while the laptop is open, and it adds model files, a served endpoint and
primary/fallback logic to maintain for one operator.

**DSH on Athena with a non-sovereign model provider.** Rejected on the sovereignty constraint:
mail content would leave the European perimeter.
