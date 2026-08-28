# DSH Mail Agent

[![CI](https://github.com/mmaudet/dsh-mail-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/mmaudet/dsh-mail-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) preset that turns a
mailbox into an operational vertical: classification, periodic summaries, reply drafts,
digests, assisted unsubscribe and spam handling.

The agent speaks **JMAP or IMAP+SMTP** through an interchangeable adapter, so it runs against
Apache James, Fastmail or Stalwart over JMAP, and against Gmail, iCloud, Dovecot or any
standard IMAP provider over IMAP. The tools the model sees never know which one is mounted.

## Intent

DSH makes the agent loop itself a mountable plugin. This repository is a full-scale test of
that claim on a domain where a generic loop is a poor fit: mail triage is a cascade, not a
chat turn, and most messages should never reach a model at all.

Three things the project sets out to demonstrate:

1. A specialised mail cascade is portable onto a generic harness without forking it.
2. A parameterised, model-agnostic OpenAI-compatible adapter can be A/B tested on one corpus.
3. The whole thing runs 24/7 on a small VPS, with inference on a sovereign European endpoint
   and no mail content leaving that perimeter.

The full rationale, functional specification and phase plan live in **[docs/PRD.md](docs/PRD.md)**.

## Status

**Phase 0 — bootstrap.** The three bundles are scaffolded, typed and wired into CI. They
intentionally ship no runtime behaviour yet: the mail contract and its adapters land in
Phase 1. See [§6 of the PRD](docs/PRD.md) for the phase plan.

## Layout

| Package | npm name | Role |
|---|---|---|
| `packages/dsh-mail-core` | `@dsh-mail-agent/mail-core` | Mail contract, JMAP and IMAP adapters, auth, cascade loop, tools |
| `packages/dsh-mail-digest` | `@dsh-mail-agent/mail-digest` | Scheduler, daily and weekly digests, inbox triage |
| `packages/dsh-llm-openai` | `@dsh-mail-agent/llm-openai` | OpenAI-compatible LLM adapter, four-tier model router |
| `tooling/lint` | `@dsh-mail-agent/tooling-lint` | Shared ESLint flat config |

A DSH **profile** composes these bundles; a **bundle** is what gets distributed. Operators
override any decision with a `cordis.patch.yml` layered on top, without forking a bundle.

## Getting started

Requires Node 22 (see [`.nvmrc`](.nvmrc)) and pnpm 10.

```bash
pnpm install
pnpm build       # tsc -b across the project references
pnpm lint
pnpm typecheck
pnpm test
```

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements, architecture and phase plan
- [docs/athena-setup.md](docs/athena-setup.md) — provisioning the 24/7 agent host
- [docs/adapters.md](docs/adapters.md) — switching between JMAP and IMAP
- [docs/jmap-oidc-setup.md](docs/jmap-oidc-setup.md) — authorising JMAP access
- [docs/article-notes.md](docs/article-notes.md) — field notes for the public write-up
- [docs/decisions/](docs/decisions/) — architecture decision records
- [CONTRIBUTING.md](CONTRIBUTING.md) — conventions and local workflow

## License

[MIT](LICENSE) © Michel-Marie Maudet
