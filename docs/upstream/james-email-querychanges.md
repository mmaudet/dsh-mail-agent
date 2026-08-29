# James answers `unknownMethod` to `Email/queryChanges`

Found while wiring the cold start. It matters more than a missing method: the
PRD's poll-delta path is specified on top of it.

## What happens

Both servers, same probe, one connection each:

| Method | `apache/james:memory-latest` | `imap.linagora.com` (Twake Mail) |
|---|---|---|
| `Email/query` | ok | ok |
| **`Email/queryChanges`** | **`unknownMethod`** | **`unknownMethod`** |
| `Email/changes` | ok | ok |
| `Mailbox/changes` | ok | ok |

`Email/changes` answers with `newState`, `created`, `updated`, `destroyed` and
`hasMoreChanges` on both. The data is there; the method the PRD names is not.

Reproduce with `scripts/probe-jmap-changes.mjs`.

## Why it is not a detail

PRD section 4.1, Voie 2, specifies the delta poll as *`Email/queryChanges` every
N minutes against a persistent `sinceState` cursor*, and section 3.2's contract
turns that into `queryChanges(folder, sinceCursor)`. The JMAP adapter
implements it literally, so **the change feed does not work against the server
this project targets** — and every unit test passes, because the fake transport
answers whatever it is handed.

This is the same shape as the `LIST-EXTENDED` finding: an assumption that holds
in the specification and not on the deployment, invisible to everything except a
real call.

## What the two methods actually differ on

Not interchangeable, which is why this is a design change rather than a rename:

| | `Email/queryChanges` | `Email/changes` |
|---|---|---|
| Scope | one filtered query | the whole account |
| Cursor | that query's `queryState` | the account's mail state |
| Reports | entering and leaving the query | objects created, updated, destroyed |
| Per-folder | by construction — the filter is the query | needs `Email/get` on the ids to read `mailboxIds` |

So a per-folder cursor stops being a natural unit. Following `Email/changes`
means holding one account-level cursor, fetching the changed ids' `mailboxIds`,
and routing them to folders afterwards — an extra round trip per batch, and a
cursor whose meaning the `MailboxCursor` union does not currently carry.

`hasMoreChanges` also makes the feed explicitly paginated, which
`queryChanges(folder, cursor): Promise<MailChange[]>` has nowhere to express.

## Settled: the adapter follows `Email/changes`

`JmapAdapter.queryChanges` is rebuilt on it, and the integration suite now
proves the round trip against a live server instead of skipping it.

It turns out to be an improvement rather than a workaround. The adapter used to
carry this caveat:

> `Email/queryChanges` tracks membership of a filtered query, so it reports a
> message entering or leaving the folder. It cannot report an in-place change
> such as a flag edit.

`Email/changes` reports `updated` as well, so keyword edits arrive through the
same feed and no longer depend on the push channel to be noticed.

What it costs: the feed is account-wide, so one `Email/get` on the changed ids
reads their `mailboxIds` and routes them to folders — skipped entirely when
nothing changed. `maxChanges` is bounded at 256, because a poll that has fallen
a week behind should return control rather than drain a mailbox; the cursor each
change carries points just past it, so the next call resumes exactly there.

One limitation, deliberately: a destroyed message has no `mailboxIds` left to
read, so it cannot be attributed to a folder. It is reported to the caller that
asked, which is the one holding the id and able to recognise it.

**PRD section 4.1, Voie 2 names `Email/queryChanges` and needs amending.**

## Still worth raising upstream

The above makes this project work. It does not make the server right, and the
report stands on its own:

`urn:ietf:params:jmap:mail` is advertised, and one of the methods it defines is
absent. Every JMAP client that reads the capability and uses `Email/queryChanges`
breaks on this server, and RFC 8621 section 4.5 defines it as part of what that
capability means.

Same shape as the `LIST-EXTENDED` report, and the same ask: implement it, or
make the gap discoverable, so a client can choose the other path deliberately
instead of failing at runtime.

## Two smaller things the same probe turned up

`currentCursor` reads the account's mail state from `Email/get` with no ids,
which is what `Email/changes` counts from. It first used `Email/query` with
`limit: 0` — rejected by James as `invalidArguments`, and accepted happily by a
fake transport. That same zero limit was sitting in `#inboxCursor`, so watching
the inbox would have failed on a real server with every unit test green. There
is one implementation now, and it is the public one.

Both are the same lesson as the method itself: nothing but a real call reports
them.
