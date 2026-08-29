# `LIST ... RETURN (SUBSCRIBED)` fails on a Twake Mail deployment

Found while building the Phase 1 integration suite. Written up here because the
right fix is upstream, not a workaround in this repository — the workaround
exists only so this project can keep moving.

## What happens

The server advertises `LIST-EXTENDED`, and rejects the return option that
extension defines:

```
* CAPABILITY ... SPECIAL-USE ... CHILDREN ... LIST-EXTENDED ... LIST-STATUS ...

c3 LIST "" "INBOX" RETURN (SUBSCRIBED)
c3 NO LIST processing failed.
```

Every client that issues the extended form breaks on every call, not only on
listing: `mailboxOpen` in ImapFlow lists before it selects, so opening a
mailbox fails too. The whole account is unreachable to such a client.

## Narrowed to one option

Each return option issued on its own, one connection, same session:

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

- **`SUBSCRIBED` as a *return* option is the single trigger.** Any set
  containing it fails; every set without it succeeds.
- **`SUBSCRIBED` as a *selection* option works** — `LIST (SUBSCRIBED) "" "INBOX"`
  returns rows, so subscription state is readable.
- **`LSUB` works.** The data is there; only this path to it fails.
- **Upstream does not reproduce.** The same nine commands all succeed on
  `apache/james:memory-latest`.

Not a scale problem: it fails on `"INBOX"` alone, one mailbox, as readily as on
`"*"` across 418.

## Where that points

Both servers identify as `JAMES IMAP4rev1 Server`. The difference between them
is not the protocol layer they share but what sits under it — the memory
mailbox manager in the container against the distributed backend in the
deployment. `RETURN (SUBSCRIBED)` is the one option that must join subscription
state onto each returned row, and it is the one that fails, while the same
state read through `LSUB` or a selection option comes back fine.

That is a hypothesis, not a diagnosis. Confirming it needs the server's logs
for the failing command, which we do not have: `NO LIST processing failed.` is
what James returns when the operation throws, and the exception itself stays
server-side.

## Reproducing

`scripts/probe-james-list.mjs`, one connection, nine commands:

```bash
PROBE_HOST=imap.example.com PROBE_USER=user@example.com \
  PROBE_PASS="$PASSWORD" node scripts/probe-james-list.mjs
```

Raw IMAP over TLS with no library in the path, so the result is the server's
answer rather than a client's interpretation of it.

## What to ask for

1. The server-side stack trace behind `LIST processing failed.` for
   `RETURN (SUBSCRIBED)`, which turns this hypothesis into a diagnosis.
2. Either the return option honoured, or `LIST-EXTENDED` not advertised while
   part of it is broken. A capability that cannot be exercised is worse than an
   absent one: clients feature-detect on the advertisement, and every one of
   them that does breaks completely rather than degrading.

## The workaround here, and its cost

`ImapFlowConnection` retries once with `skipListSubscribedArg`, and only that
argument: dropping the aux options as well would cost `SPECIAL-USE`, which is
how folder roles are resolved. The connection keeps the setting for its life.

The cost is that subscription state has to be read another way if this project
ever needs it — through `LSUB` or the selection option, both of which work.
