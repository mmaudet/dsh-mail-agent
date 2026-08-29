# Twake Mail: `LIST ... RETURN (SUBSCRIBED)` fails where upstream James succeeds

**For: the Twake Mail team.** Not an Apache James issue — upstream does not
reproduce it, and the section below shows the comparison that establishes that.

Found while building an IMAP client against `imap.linagora.com`. Written up
because the fix belongs in the server; the workaround in this repository exists
only so the project can keep moving.

## What happens

The server advertises `LIST-EXTENDED`, and rejects a return option that
extension defines:

```
* CAPABILITY ... SPECIAL-USE ... CHILDREN ... LIST-EXTENDED ... LIST-STATUS ... AUTH=PLAIN

c3 LIST "" "INBOX" RETURN (SUBSCRIBED)
c3 NO LIST processing failed.
```

Server banner: `* OK JAMES IMAP4rev1 Server tmail-imap-smtp-d854df756-jf6vb is ready.`

## Why it is worse than one broken command

Clients that support `LIST-EXTENDED` use it for *every* listing, and many list
before they select. ImapFlow — the mainstream Node IMAP client — issues
`LIST "" "<mailbox>" RETURN (SPECIAL-USE CHILDREN SUBSCRIBED)` inside
`mailboxOpen`, so on this server:

- listing folders fails,
- **opening a mailbox fails**,
- and therefore fetching, searching, appending and IDLE never run.

The account is not degraded for such a client. It is unusable. The failure also
gives no hint of its cause: `Command failed` is all the client surfaces.

Feature detection makes this worse rather than better. A client that checks the
capability and finds it advertised has done the correct thing and still breaks;
one that ignores the advertisement works fine.

## Narrowed to one option

Each return option issued on its own, one connection, same session, raw IMAP
over TLS with no library in the path:

| Command | Twake Mail | `apache/james:memory-latest` |
|---|---|---|
| `LIST "" "INBOX"` | OK, 1 row | OK, 1 row |
| `LIST "" "INBOX" RETURN (SPECIAL-USE)` | OK, 1 row | OK, 1 row |
| `LIST "" "INBOX" RETURN (CHILDREN)` | OK, 1 row | OK, 1 row |
| **`LIST "" "INBOX" RETURN (SUBSCRIBED)`** | **NO** | OK, 1 row |
| `LIST "" "INBOX" RETURN (SPECIAL-USE CHILDREN)` | OK, 1 row | OK, 1 row |
| `LIST "" "INBOX" RETURN (CHILDREN SUBSCRIBED)` | **NO** | OK, 1 row |
| `LIST "" "INBOX" RETURN (SPECIAL-USE CHILDREN SUBSCRIBED)` | **NO** | OK, 1 row |
| `LIST (SUBSCRIBED) "" "INBOX"` | OK, 2 rows | OK, 1 row |
| `LSUB "" "INBOX"` | OK, 1 row | OK, 1 row |

So:

- **`SUBSCRIBED` as a *return* option is the single trigger.** Every set
  containing it fails; every set without it succeeds.
- **`SUBSCRIBED` as a *selection* option works** — `LIST (SUBSCRIBED) "" "INBOX"`
  returns rows, so the subscription state is readable.
- **`LSUB` works.** The data is there; only this path to it fails.
- **Upstream does not reproduce.** All nine commands succeed on
  `apache/james:memory-latest`.

Not a scale problem: it fails on `"INBOX"` alone, one mailbox, exactly as it
fails on `"*"` across 418.

## Where that points

Both servers identify as `JAMES IMAP4rev1 Server`, so the protocol layer they
share is not the difference. What differs is underneath: the memory mailbox
manager in the container against the distributed backend in the deployment.
`RETURN (SUBSCRIBED)` is the one option that has to join subscription state onto
each returned row, and it is the one that fails — while the same state read
through `LSUB` or the selection option comes back fine.

That is a hypothesis, not a diagnosis. Confirming it needs the server-side
exception: `NO LIST processing failed.` is what James returns when the operation
throws, and the stack trace stays on the server.

## Reproducing

```bash
PROBE_HOST=imap.linagora.com PROBE_USER=user@linagora.com \
  PROBE_PASS="$PASSWORD" node scripts/probe-james-list.mjs
```

Prints the nine commands above with the server's tagged response and row count
for each. Point it at a container to get the comparison column:

```bash
PROBE_HOST=localhost PROBE_PORT=10993 PROBE_USER=itest@example.test \
  PROBE_PASS=itest-secret node scripts/probe-james-list.mjs
```

## What would help

1. **The stack trace behind `LIST processing failed.`** for
   `RETURN (SUBSCRIBED)` on this deployment. That turns the hypothesis above
   into a diagnosis, and it is the one piece only you can get.
2. **Either honour the option, or stop advertising `LIST-EXTENDED` while part
   of it is broken.** A capability that cannot be exercised is worse than an
   absent one, for the reason in the second section: the clients that check
   before using it are precisely the ones that break.

The second is worth doing even before the first, since it turns a total failure
into a graceful degradation for every affected client at once.

## The workaround here, and its cost

`ImapFlowConnection` retries once with ImapFlow's `skipListSubscribedArg`, and
only that argument: dropping the aux options as well would cost `SPECIAL-USE`,
which is how folder roles are resolved. The connection keeps the setting for its
life rather than paying a round trip per call to rediscover the same failure.

The cost is that subscription state has to be read another way if this project
ever needs it — `LSUB` or the selection option, both of which work here.
