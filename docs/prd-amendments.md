# Where the PRD and the deployment disagree

Eight places, found by building the thing. Each has evidence in the repository
and a note on what was done in the meantime. The PRD is the owner's document,
so nothing here has been changed in it — this is the list to work from.

Ordered by how much rests on the assumption.

---

## 1. §4.1 Voie 2 — `Email/queryChanges` does not exist on the target server

**Says.** The delta poll runs `Email/queryChanges` every N minutes against a
persistent `sinceState` cursor. §3.2 turns that into
`queryChanges(folder, sinceCursor)`.

**Is.** Both the container and the production deployment answer
`unknownMethod`. `Email/changes` works on both.

```
Email/query          ok      ok
Email/queryChanges   NO      NO      ← unknownMethod on apache/james:memory-latest
Email/changes        ok      ok         and on imap.linagora.com
```

**Done.** The adapter is rebuilt on `Email/changes`, which turned out better:
`queryChanges` cannot report a flag edit at all, and `Email/changes` reports
`updated`, so keyword changes now arrive through the same feed instead of
needing the push channel.

**Costs.** The feed is account-wide, so one `Email/get` routes changed ids to
folders. A destroyed message has no `mailboxIds` left and cannot be attributed
to one.

→ `docs/upstream/james-email-querychanges.md`

---

## 2. §4.2 node 2 — the spam header convention is not `x-spam-*`

**Says.** The prefilter consumes `x-spam-*` signals exposed by JMAP.

**Is.** The target account emits none. James stamps:

```
org.apache.james.rspamd.status: No, actions=no action score=-1.307155 requiredScore=15.0
```

**Done.** Both shapes are read, and the threshold comes from the header rather
than a constant — the deployment states 15 where rspamd's documentation says
10, so a hardcoded 10 would have junked clean mail for five points of score, on
the one node with no review path.

**Also.** The adapter had never asked JMAP for any header at all, so nodes 2 and
5 were unreachable from the day they were written, under a green suite.

→ `docs/reviews/first-dry-run.md`

---

## 3. §3.2 — the contract cannot cold-start

**Says.** The `MailService` interface, verbatim, with
`queryChanges(folder, sinceCursor)`.

**Is.** Every cursor it produces rides on a `MailChange`, so a folder that has
not changed hands back nothing to resume from. An agent meeting a mailbox it
has never seen had nowhere to begin.

**Done.** `currentCursor(folder)` added, after checking that no existing method
could answer it. **This amends a contract the PRD states verbatim** and is the
one item here that changes the document's own text.

---

## 4. §3.2 — the contract cannot enumerate a mailbox

**Says.** `getMessages(ids)`.

**Is.** Nothing produces ids for mail that is already there. The Phase 2 output
— *batch classifier une mailbox réelle* — is not reachable through the contract.

**Not done.** The dry-run script reaches past `MailService` to `Email/query`,
marked as such. Closing it is a contract decision, not a script's.

---

## 5. §4.5 — automatic filing is prescribed without a way to earn it

**Says.** Newsletters move to their folder automatically; `spam-certain` goes
to Junk directly.

**Is.** The first dry run over the real mailbox would have moved six of twelve
messages, among them a bounce (`Mail delivery failed`) and a sales enquiry
(`New demo request`), both filed out of the inbox as
`newsletter-notification`.

**Done.** Every move demoted to `ask`. Only tagging runs unattended.

**The gap the PRD has.** It prescribes the automation and says nothing about
how one establishes that the classifier is good enough for it. The store now
makes a per-category error rate measurable from real traces, which is the
missing half: a category earns `auto` on the evidence of its own history.

→ `docs/reviews/first-dry-run.md`

---

## 6. §4.2 — the cost argument is weaker than assumed

**Says.** Seven of eleven corpus messages avoid the model, and that ratio is
the loop's efficiency KPI.

**Is.** Measured on two real mailboxes:

| | |
|---|---|
| static rules | ~6-9% |
| learned patterns, ceiling | ~19% |
| spam prefilter | ~1% |
| **thread continuity** | **+8 points** |
| the rest | needs the model, and will keep needing it |

A corpus written to exercise each node has one case per node by construction; a
mailbox has whatever it has.

**Not a defect.** A property of a mailbox mostly written by people. Worth
restating in the PRD in those terms rather than as a projection.

→ `docs/reviews/source-consistency.md`, `docs/reviews/thread-continuity.md`

---

## 7. §4.5 — Gmail has no archive folder

**Says.** Transactional mail stays in the inbox 24h then archives to
`Archives/Transactions/`.

**Is.** Gmail reports `\All` and no `\Archive`. Archiving there is not a move
but the removal of the `INBOX` label, after which the message is in All Mail by
definition. A `moveMessage` would create a Gmail label nobody asked for beside
the semantics Gmail already has.

**Done.** The planner plans no archive destination on a server that has none.
The label semantics belong with Phase 3.

→ `docs/reviews/gmail-target.md`

---

## 8. §3.4 — secrets are addressed by environment-variable name, not by URI

**Says.** `api_key_ref: dsh:secret:mail-sentinel-api-key`.

**Is.** The DSH credential seam addresses secrets by the *name of an
environment variable*. There is no `dsh:secret:` URI scheme.

**Done.** Every config in this repository uses `apiKeyEnv`, `tokensEnv`,
`sessionUrlEnv` and so on. The PRD's example would not load.

---

## Two more, outside the PRD

**`LIST-EXTENDED` is advertised and broken** on the production IMAP server:
`RETURN (SUBSCRIBED)` answers `NO LIST processing failed.` while
`RETURN (SPECIAL-USE)` succeeds, and upstream James accepts all of them. Every
client that feature-detects correctly fails; one that ignores the advertisement
works. → `docs/upstream/twake-mail-list-return-subscribed.md`

**`Email/query` rejects `limit: 0`** with `invalidArguments`, which a fake
transport accepts happily. The same zero limit sat in `#inboxCursor`, so
watching the inbox would have failed on a real server with every unit test
green.
