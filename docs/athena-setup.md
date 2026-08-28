# Provisioning the agent host

How the 24/7 host is set up, so that rebuilding it is a procedure rather than a
memory. Everything here runs as an ordinary user: no `sudo`, nothing installed
system-wide, nothing listening on a public interface.

The host in this deployment is `athena`; substitute your own.

## Prerequisites

Node 22 (`^22.19.0`), git, and outbound HTTPS. pnpm is not installed
system-wide — corepack provides the version the harness pins.

```bash
mkdir -p ~/.npm-global/bin ~/work
corepack enable --install-directory ~/.npm-global/bin
```

`~/.npm-global/bin` is on the login-shell PATH only, so anything non-interactive
(a systemd unit, a cron entry) must use absolute paths.

## The harness

```bash
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness ~/work/dsh
cd ~/work/dsh && pnpm install && pnpm run build
ln -sf ~/work/dsh/apps/cli/lib/bin.js ~/.npm-global/bin/dsh
dsh --version        # 0.1.2-alpha.1
```

`--depth 1` is enough to run it. Drop it if you want history for Creator-mode
work inside the harness itself.

## This repository

```bash
git clone https://github.com/mmaudet/dsh-mail-agent ~/work/dsh-mail-agent
cd ~/work/dsh-mail-agent && pnpm install && pnpm run build
```

## Credentials

Values live in `$DSH_HOME/.env` (default `~/.dsh/.env`), mode `600`, and are
referenced from configuration by environment-variable name — the convention the
harness credential seam uses. Nothing sensitive belongs in a profile, in
`cordis.patch.yml`, or in this repository.

```
MAIL_SENTINEL_API_KEY              bearer for the LLM gateway
MAIL_SENTINEL_API_BASE             gateway base URL
MAIL_SENTINEL_OIDC_CLIENT_ID       JMAP OAuth client
MAIL_SENTINEL_OIDC_CLIENT_SECRET   JMAP OAuth client secret (confidential client)
MAIL_SENTINEL_OIDC_ISSUER          identity provider, not secret
```

Check one is present without printing it:

```bash
grep -c '^MAIL_SENTINEL_API_KEY=' ~/.dsh/.env
```

## Profiles

Two, as [PRD §5.4](PRD.md) requires: Creator mode never runs against the
profile the service uses.

```bash
dsh plugin --profile mail-agent-dev  --version    # creates it
dsh plugin --profile mail-agent-prod --version
```

`mail-agent-dev` keeps `patchReload: live` so a patch edit recomposes without a
restart. Set `mail-agent-prod` to `patchReload: startup`: replacing a running
service's dependencies after it owns work invalidates that lifecycle.

Mount this repository's bundles into a profile:

```bash
dsh plugin --profile mail-agent-dev add ~/work/dsh-mail-agent/packages/dsh-llm-openai
```

A package without a `dsh.bundle` declaration installs as a plain dependency and
the harness says so; it becomes a profile layer once it declares one.

Point the agent at a route the bundle registers, in the profile's own
`cordis.patch.yml` — which model the loop uses is an operator decision, not a
bundle one:

```yaml
- id: agent-default-model
  config:
    provider: mail-llm-default
    model: Mistral-Small-3.2-24B-Instruct-2506-FP8
```

## Checking it works

Composition, without booting anything:

```bash
dsh --profile mail-agent-dev --dump-config | grep '^# =='
# == @deepseek-ai/dsh-base
# == @dsh-mail-agent/llm-openai
```

End to end, through the real agent loop, needs a one-shot application layer.
Build a throwaway profile rather than adding one to `mail-agent-dev`:

```bash
dsh plugin --profile mail-agent-smoke --version
# set bundles to [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless] in
# ~/.dsh/profiles/mail-agent-smoke/package.json, then:
cp ~/.dsh/profiles/mail-agent-dev/cordis.patch.yml ~/.dsh/profiles/mail-agent-smoke/
dsh plugin --profile mail-agent-smoke add ~/work/dsh-mail-agent/packages/dsh-llm-openai

dsh --profile mail-agent-smoke "En une phrase et en français : bonjour ?"
rm -rf ~/.dsh/profiles/mail-agent-smoke
```

A French answer in a few seconds means the harness, the adapter, the credential
and the gateway are all correct together.

## The service

`~/.config/systemd/user/dsh-mail-agent.service` runs `mail-agent-prod`. It is a
**user** unit, so it needs no root, and it ships disabled.

```bash
systemctl --user daemon-reload
loginctl enable-linger "$USER"        # survive logout; required for 24/7
systemctl --user enable --now dsh-mail-agent
```

Leave it disabled until the profile it boots does something worth running.

## Reaching the web UI

The harness binds `127.0.0.1` and nothing is exposed publicly. Either forward it:

```bash
ssh -L 3080:127.0.0.1:3080 athena
```

or serve it on the tailnet:

```bash
tailscale serve --https=443 --set-path=/dsh http://127.0.0.1:3080
```
