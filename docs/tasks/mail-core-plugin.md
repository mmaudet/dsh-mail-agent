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

---

# Correction round

A first attempt reported success. The profile does not boot. Five defects, in
the order they matter.

**The acceptance check is now a script.** Run it; it exits non-zero until the
task is done:

```bash
bash ~/work/dsh-mail-agent/scripts/verify-mail-core-bundle.sh
```

Do not report success on any other basis. A `grep` that matches a line you
just wrote is not a verification — that is how the first attempt concluded it
had finished.

## 1. Blocking: the row names the package root

`name: '@dsh-mail-agent/mail-core'` resolves to `dist/index.js`, which exports
types and values but no `apply`. The harness says so:

```
invalid plugin, expect function or object with an "apply" method, received object
```

Declare a subpath export for the plugin and name **that** in the row.
`@deepseek-ai/dsh-headless` in the harness repository does exactly this with
its `./startup` export; copy the shape.

## 2. The bundle was never mounted

The row was inserted into the **profile's** `cordis.patch.yml` instead. That
bypasses the bundle mechanism entirely and leaves the package's own
`cordis.patch.yml` unread — dead code. The task is to make the package a
mountable bundle: `dsh plugin --profile mail-agent-dev add <path>`, so
`# == @dsh-mail-agent/mail-core` appears as a layer in `--dump-config`.

Leave the profile's own patch alone. It carries the operator's model choice.

## 3. `dsh.bundle` has the wrong shape

`{"bundle": true}` is not it. The correct shape is in
`packages/dsh-llm-openai/package.json`, one directory away:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

## 4. The configuration is decorative

`cordis.patch.yml` declares `accountIdEnv`, `identityIdEnv` and
`sessionUrlEnv`; `apply(ctx)` takes no config parameter and reads
`process.env.MAIL_SENTINEL_*` by hard-coded name. Changing the configuration
therefore changes nothing, which defeats its purpose.

Take `apply(ctx, config)` and read the variable names from `config`.

## 5. The transport POSTs to the wrong URL

`MAIL_SENTINEL_JMAP_SESSION_URL` is the JMAP **session resource**: you `GET` it
to discover `apiUrl`, and you `POST` method calls to that `apiUrl` (RFC 8620
§2). The code POSTs to the session URL. Its own comment says "POSTs to the
account's apiUrl", which is what it should do and does not.

Fetch the session once, read `apiUrl` from it, and post there.

## Not in scope for this round

Token refresh. The stored access token has expired, so a live JMAP call will
return 401 even once the above is correct. `verify-mail-core-bundle.sh` does
not make a live call, and neither should you: the profile booting is the goal.
