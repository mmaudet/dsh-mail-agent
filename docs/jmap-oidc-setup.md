# Authorising JMAP access

The agent reaches a JMAP mailbox with an OAuth access token obtained through
OIDC. Getting the *first* token is a one-off interactive step; everything after
that is an unattended refresh.

## What the identity provider decides

Three values come from the OAuth client registered at your issuer:

| Value | Where it lives |
|---|---|
| `client_id` | `dsh:secret:jmap-oidc-client-id` |
| `client_secret` (confidential clients only) | `dsh:secret:jmap-oidc-client-secret` |
| `issuer` | `cordis.patch.yml`, in the clear |
| `redirect_uri` | `cordis.patch.yml`, in the clear |

```yaml
- id: jmap.auth
  name: '@dsh-mail-agent/mail-core'
  config:
    oidc:
      issuer: https://sso.example.com
      client_id_ref: dsh:secret:jmap-oidc-client-id
      client_secret_ref: dsh:secret:jmap-oidc-client-secret
      redirect_uri: https://example.org/oauth/jmap/callback
      scopes: [openid, profile, email, offline_access]
    token_storage:
      ref: dsh:secret:jmap-tokens
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
already holds a refresh token for the mailbox, storing that token under
`dsh:secret:jmap-tokens` is enough: the agent refreshes from it and never needs
a browser at all.

This is the least work and the least infrastructure. Its only cost is that the
first token was obtained elsewhere, so the two deployments share a credential
until the agent is re-authorised on its own.

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
