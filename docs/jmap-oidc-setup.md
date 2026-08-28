# Authorising JMAP access

The agent reaches a JMAP mailbox with an OAuth access token obtained through
OIDC. Getting the *first* token is a one-off interactive step; everything after
that is an unattended refresh.

## What the identity provider decides

Three values come from the OAuth client registered at your issuer. The harness
credential seam addresses secrets **by environment-variable name**, not by a URI
scheme: configuration carries the name, and the local provider owns the value in
`$DSH_HOME/.env`.

| Value | Reference | Secret? |
|---|---|---|
| `client_id` | `MAIL_SENTINEL_OIDC_CLIENT_ID` | yes, by project convention |
| `client_secret` (confidential clients only) | `MAIL_SENTINEL_OIDC_CLIENT_SECRET` | yes |
| `issuer` | `MAIL_SENTINEL_OIDC_ISSUER` | no, public metadata |
| `redirect_uri` | `MAIL_SENTINEL_OIDC_REDIRECT_URI` | no, public metadata |
| stored tokens | `MAIL_SENTINEL_JMAP_TOKENS` | yes |

```yaml
- id: jmap.auth
  name: '@dsh-mail-agent/mail-core'
  config:
    oidc:
      issuerEnv: MAIL_SENTINEL_OIDC_ISSUER
      clientIdEnv: MAIL_SENTINEL_OIDC_CLIENT_ID
      clientSecretEnv: MAIL_SENTINEL_OIDC_CLIENT_SECRET
      redirectUriEnv: MAIL_SENTINEL_OIDC_REDIRECT_URI
      scopes: [openid, profile, email, offline_access]
    tokensEnv: MAIL_SENTINEL_JMAP_TOKENS
```

`offline_access` is what earns a refresh token. Without it the agent has to be
re-authorised by hand whenever the access token expires, which defeats running
unattended.

`redirect_uri` is configuration rather than a constant because it **must match a
value already registered for your client**. This is the detail that decides
which bootstrap route below applies to you: check what the client has
registered before assuming.

## The bootstrap is a deployment choice

The agent runs on a server; the browser that authorises it does not. Three
routes bridge that gap, and the code supports all three — none of them is baked
in.

### Route A — the client has a `localhost` redirect registered

The simplest case. Start the agent's callback listener on the registered port,
forward it from your workstation, and authorise in a local browser:

```bash
ssh -L 8765:127.0.0.1:8765 athena
# then open the authorization URL; the callback reaches the agent through the tunnel
```

This works only if a `http://localhost:<port>/...` URI is registered for the
client. Many providers allow one for native and CLI clients; some do not.

### Route B — the registered redirect points somewhere else

If the only registered URI is a public HTTPS endpoint belonging to another
application, the identity provider will send the browser there, and no tunnel
changes that. Two ways round it without touching the provider:

**Redirect the hostname at your workstation.** For the duration of the
authorisation, point the registered hostname at `127.0.0.1` in `/etc/hosts`,
serve the callback locally behind a certificate your browser trusts (`mkcert`),
and forward it to the agent. The provider sees nothing different: the
redirection happens in the browser.

**Copy the code by hand.** Let the browser land on the registered endpoint and
take the `code` parameter out of the address bar, then hand it to the agent,
which performs the exchange itself. Stop the other application first, or its
own handler will consume the single-use code before you can.

### Route C — import an existing refresh token

A refresh token is bound to the OAuth client, not to the process that obtained
it. If another application is registered under the **same `client_id`** and
already holds a refresh token for the mailbox, adopting it is enough — see
`mail-auth adopt` below. The agent refreshes from it and never needs a browser.

This is the least work and the least infrastructure. Its only cost is that the
first token was obtained elsewhere, so the two deployments share a credential
until the agent is re-authorised on its own.

## Driving it from a terminal

The steps above are wrapped by a small command, so the parts that can be
automated are, and the part that cannot is explicit:

```bash
mail-auth begin                  # prints the URL to open
mail-auth complete '<paste>'     # exchanges what came back
mail-auth adopt < token.txt      # route C: adopt a token obtained elsewhere
mail-auth status                 # what is stored, without disclosing it
```

`begin` holds the PKCE verifier and the anti-CSRF state across the gap while
you are in a browser; `complete` checks the state before spending the code.
Paste whatever you have — the whole redirect URL, the query string alone, or
just the code. If the identity provider refused, the command says so rather
than hunting for a code that is not there.

`adopt` reads its token from **stdin, never from an argument**: a command line
is visible in the process table to every user on the host. It also redeems the
token immediately rather than storing it on trust, so a stale one fails now
instead of at the first unattended run.

A grant that comes back without a refresh token is rejected: without
`offline_access` the agent cannot renew, and storing it would only defer the
failure to the first time nobody is watching.

## After the first token

The agent refreshes on its own, a minute before expiry. Tokens are written back
through the harness secret service, which encrypts them at rest; nothing lands
on disk in the clear and nothing reaches this repository.

Rotating `client_id` or `client_secret` at the provider means updating the
secret and restarting. No code changes, because nothing reads a literal.

## Starting from scratch elsewhere

If you are reusing this project against a different identity provider, register
your own client and pick the redirect URI that suits your deployment. Route A is
the least friction when your provider allows a loopback redirect; prefer it.
