# Task: make `dsh-mail-core` a mountable bundle

You are writing the plugin entry that turns this package from a library into a
harness bundle. When you are done, a session on the `mail-agent-dev` profile has
`ctx.mailbox` and can call `mail_ping`.

Everything the contract needs already exists and is tested. Nothing in
`src/adapters/`, `src/auth/`, `src/mail-service.ts` or `src/types.ts` needs to
change — read them, do not rewrite them.

## What to produce

**1. `src/plugin.ts`** — an ordinary Cordis plugin:

```ts
export const name = '...'
export const inject = [...]
export function apply(ctx: Context, config: Config): void
```

It must:

- build a `JmapTransport` (the interface is in `src/adapters/jmap-adapter.ts`)
  that POSTs to the account's `apiUrl` with a bearer token, and reads that token
  from the stored record;
- construct a `JmapAdapter` with the account and identity from configuration;
- mount `MailboxService` so consumers reach it as `ctx.mailbox`;
- register the `mail_ping` tool, whose `apply` already exists in
  `src/tools/mail-ping.ts` — call it, do not duplicate it.

**2. `cordis.patch.yml`** — one `insert` row mounting this package, with the
configuration the plugin reads. `packages/dsh-llm-openai/cordis.patch.yml` in
this repository is a working example of the exact shape; imitate it.

**3. The `dsh` field in `package.json`** — again, `dsh-llm-openai` shows it.

## Configuration and credentials

Credentials are addressed **by environment-variable name**, never by value. The
harness resolves them; configuration carries the name only. These are already
provisioned in `$DSH_HOME/.env`:

| Variable | Holds |
|---|---|
| `MAIL_SENTINEL_JMAP_SESSION_URL` | JMAP session resource URL |
| `MAIL_SENTINEL_JMAP_ACCOUNT_ID` | account id |
| `MAIL_SENTINEL_JMAP_IDENTITY_ID` | sending identity id |
| `MAIL_SENTINEL_JMAP_TOKENS` | JSON record; `accessToken` is the bearer |

Do not print, log, or echo any of their values. Do not write a credential into
`cordis.patch.yml`.

## How you will know it worked

Three checks, in order. Run them; do not assume.

```bash
cd ~/work/dsh-mail-agent && pnpm run build     # compiles
dsh --profile mail-agent-dev --dump-config | grep -A3 'mail.service'
```

The second must print the row. Then add the bundle back to the profile:

```bash
dsh plugin --profile mail-agent-dev add ~/work/dsh-mail-agent/packages/dsh-mail-core
dsh --profile mail-agent-dev --dump-config | grep '^# =='
```

`# == @dsh-mail-agent/mail-core` must appear as a layer. A bundle without a
`dsh.bundle` declaration fails startup loudly, so if the profile stops booting,
that is the reason.

## Boundaries

- **Do not modify the profile's `package.json` by hand.** Use `dsh plugin add`.
  A profile edited by hand last night listed a bundle that declared no patch and
  a dependency that did not exist, and the profile stopped booting.
- **Do not touch `mail-agent-prod`**, and do not point anything at a real
  mailbox: reads against the owner's own mail wait for Phase 3.
- **Do not add dependencies** beyond what is already in `package.json`.
- If a tool you expect does not exist, say so and stop. Do not improvise with
  shell archaeology — three sessions were lost that way, one of them repeating
  an identical call thirty times.

## Where to look first

- `packages/dsh-llm-openai/src/index.ts` — a plugin of the same shape, working
- `packages/dsh-llm-openai/cordis.patch.yml` — the patch shape, working
- `packages/dsh-mail-core/src/mail-service.ts` — `MailboxService`, the contract
- `packages/dsh-mail-core/src/adapters/jmap-adapter.ts` — `JmapTransport`, the
  interface your transport implements
- `packages/dsh-mail-core/src/tools/mail-ping.ts` — the tool to register
