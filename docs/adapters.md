# Switching between JMAP and IMAP

The agent speaks JMAP or IMAP+SMTP through one contract. Tools consume
`ctx.mailbox` and never an adapter, so changing protocol is a configuration
edit, not a code change.

> **Status.** The contract, both adapters and the capability degradation are
> implemented and unit-tested. The plugin entry that builds an adapter from the
> configuration below lands with the integration tests, against Apache James and
> Dovecot. The shapes here are the contract those tests will hold to.

## The choice

Put the adapter selection in your profile's `cordis.patch.yml`:

```yaml
- id: mail.service
  name: '@dsh-mail-agent/mail-core'
  config:
    adapter: jmap
    jmap:
      server_url: https://jmap.example.com
      account_id: dsh:secret:jmap-account-id
      identity_id: dsh:secret:jmap-identity-id
      auth: oidc
```

or:

```yaml
- id: mail.service
  name: '@dsh-mail-agent/mail-core'
  config:
    adapter: imap
    imap:
      host: imap.gmail.com
      port: 993
      tls: true
      auth: xoauth2
      user: you@example.org
      smtp:
        host: smtp.gmail.com
        port: 587
        starttls: true
```

A patch replaces a row's whole `config`, so restate the block you want rather
than expecting a merge.

No credential appears in either block. Anything sensitive is a
`dsh:secret:<name>` reference resolved at connection time from the harness
secret service.

## What changes underneath, and what does not

The contract is identical on both sides. What differs is reported through
`capabilities`, which consumers branch on:

| | JMAP | IMAP |
|---|---|---|
| `push` | `jmap-push-subscription` | `imap-idle` |
| `customKeywords` | `true` | `false` |
| `threadNative` | `true` | `false` |
| `spamHeaders` | `true` when the server exposes `x-spam-*` | same |

Three consequences are worth knowing before you switch.

**Tagging degrades.** With `customKeywords: false`, `setKeywords` cannot store a
Sentinel tag. The service turns each one into the flags and the single folder
move that stand in for it, so a caller asking for `$twaky-newsletter-promo` gets
the message filed under `Newsletters/Promo` instead. `important` is flagged in
place with `\Flagged`; `standard` and `transactional` are left alone. A
consumer never learns which adapter answered.

**Threads are reconstructed.** With `threadNative: false` the thread id is the
oldest entry of `References`, falling back to `In-Reply-To`, falling back to the
message's own `Message-ID`. That agrees with native threading in the common
case and can differ when a client writes a malformed `References` chain.

**Cursors are not portable.** A JMAP cursor holds a query state string; an IMAP
cursor holds `(UIDVALIDITY, UID)`. Handing one to the other adapter is rejected
rather than misread, so a stored cursor does not survive a protocol switch:
after switching, start from a fresh cursor.

## Folder names

The degradation targets these paths, created on demand:

| Category | Folder |
|---|---|
| `newsletter-tech` | `Newsletters/Tech` |
| `newsletter-promo` | `Newsletters/Promo` |
| `newsletter-notification` | `Newsletters/Notifications` |
| `spam-probable`, `spam-certain` | `Junk` |
| `needs-review` | `NeedsReview` |

On JMAP a keyword marks `needs-review` and the message stays in the inbox. A
server without custom keywords has no way to mark anything in place, so the
folder is the mark. That is a real behavioural difference between the two
deployments, not an implementation detail.

## Checking what you mounted

`mail_ping` reports the mounted adapter, its capabilities and the round-trip
latency. Run it first after any configuration change:

```
mail_ping
→ jmap adapter answered in 142 ms (push: jmap-push-subscription;
  custom keywords, native threads, spam headers)
```
