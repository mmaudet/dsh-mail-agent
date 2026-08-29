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

## Open, and deliberately

Nothing is patched here. The choice is between:

- **rebuild the JMAP delta on `Email/changes`**, with an account-level cursor
  and a mailbox lookup — correct against the real server, and it changes what a
  cursor means;
- **keep `queryChanges` and let the JMAP delta stay unavailable**, relying on
  push (`PushSubscription`, which James does advertise) with IMAP as the polling
  adapter — smaller, and it gives up Voie 2 on JMAP;
- **ask the Twake Mail team for `Email/queryChanges`**, which is the same
  conversation as the `LIST-EXTENDED` report and has the same shape: a
  capability advertised through `urn:ietf:params:jmap:mail` whose methods are
  not all there.

The first is the honest engineering answer, the third is the one that helps
everyone else too, and they are not exclusive.

## What is already true

`currentCursor` works on both servers and is covered by the integration suite.
It uses `Email/query` with `limit: 1` — **not `0`**, which James rejects with
`invalidArguments` while a fake transport accepts it happily. That same zero
limit was sitting in `#inboxCursor`, so watching the inbox would have failed on
a real server with every unit test green. One implementation now.
