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

## 9. §4.2 — the eight categories are not this mailbox's, in either direction

The eight are the PRD's largest single divergence, and unlike the others it is
not a detail of a protocol. They were specified before anyone had classified a
real message, and two independent measurements have now said they are wrong.

**Too many, then too few.** Labelling thirty of their own messages blind, the
owner used three, and half the classifier's errors were mail filed into
categories they never used once. Reducing the vocabulary to three was then
started and abandoned fifteen messages into a second labelling run: three cannot
annotate this mailbox either.

Neither eight nor three came from the mail. Sixteen do — derived from 400 real
messages, with 97% coverage measured rather than assumed
(`docs/reviews/sixteen-categories.md`).

**What the eight get wrong is not their number.** The rule that produced the
sixteen is that a category exists only where the agent does something different
with it, and by that rule the PRD contains a distinction that does nothing and
misses one that decides a sixth of the inbox:

- `newsletter-tech` and `newsletter-promo` are the same category. Both are read
  once and forgotten; nothing downstream tells them apart.
- **Cold prospecting is 16% of this mailbox, ahead of the owner's own client
  correspondence, and the PRD has no word for it.** Its nearest,
  `newsletter-promo`, *files* — so the specified behaviour puts a sixth of the
  inbox into a folder the owner is expected to read.
- A colleague asking the owner to decide has no category. The PRD can say a
  colleague informs (`standard`) but not that one is waiting, which is the
  distinction the owner cares most about.

**§4.5's filing follows the categories out.** Three newsletter folders and an
archive for transactional mail are all specified for distinctions that do not
survive. What replaces them is one folder per category that earns one, and one
category — cold prospecting — whose mail is trashed rather than filed, on the
owner's explicit instruction and at a 0.9 confidence floor.

**§3.3's efficiency target is collateral.** The static rule that guessed a
newsletter sub-category from the sender's local part was the cheap path for
bulk mail, and it had to go: `List-Unsubscribe` proves a message is bulk and
cannot say which kind, and the two kinds are now handled in opposite
directions. The corpus's no-model ratio falls from 0.6 to 0.5, and the rule it
replaced was wrong on the real mailbox 40 times out of 42.

## 10. §5 — a category is not a queue, and the PRD has no way to say so

The PRD's drafting section takes the category as the trigger: certain
categories are draftable, the agent drafts for them. Measured against forty
messages the owner annotated, that produced a queue of forty of which nine
wanted anything (`docs/reviews/forty-dispositions.md`).

Three of the four failures are not about the model at all.

**Ten had already been answered.** The queue's second condition was "still in
the inbox", and this owner replies without filing. The fix is exact and free —
their reply carries the original's `Message-ID` in `In-Reply-To` — and it is
the largest single correction anything in this project has produced.

**One was the owner's own message,** returned to their inbox through a role
alias and offered back to them as needing an answer.

**And a category is a poor proxy for an obligation.** The sixteen say what a
message *is*. `demande-interne` covers both a colleague asking the owner to
approve something and a colleague telling them a decision has been taken. The
queue needs the second question — *does this ask something of the owner?* —
and the PRD has no place for it, because it assumes classification settles
everything downstream.

That question is now `queue/asks.ts`, deliberately not wired into the loop: it
costs a model call per message on top of classification, and §3.3's efficiency
target is stated against classification alone. Turning it on is a decision
about cost that belongs to the owner, and the PRD should say which of the two
budgets it comes out of.

**§4.2's ordering has nothing to say about addressing.** Twenty of the forty
name the owner in neither `To` nor `Cc`, arriving through a group alias. The
PRD's model has one owner address; a real one has a personal address, a role
address, and half a dozen team aliases whose meanings are opposite —
`expertise-libre@` carried four messages and no obligations, `canut-libre@`
carried one message and one obligation. Which alias is which is an
owner-stated fact, like a route, and there is no field for it.

## 11. §3.4 — the sovereign gateway moved

The PRD names `https://chat.lucie.ovh.linagora.com/v1/` in five places, as the
one endpoint the whitelist admits and as the basis of the sovereignty claim.
Its certificate expired on 30 August, which is why every measurement taken
since then carries a banner saying real message content went to a third-party
endpoint instead.

It is now `https://inference.linagora.com/v1/`, certificate valid to 4 November,
serving the same `Mistral-Small-3.2-24B-Instruct-2506-FP8` the PRD specifies
along with `Luciole-23B-Instruct-1.1-FP8`, `lucie-7b-instruct-v1.1`,
`Qwen3-VL-8B-Instruct-FP8`, an embedding model and a reranker.

The PRD is not edited: the address changed, the design did not, and editing it
would erase the record that the endpoint this project was built against went
away for three days. What changed in the code is the whitelist, the four
`dsh-llm-openai` tiers, and the `SOVEREIGN` guard that every measurement script
uses to refuse a non-sovereign endpoint.

The cost of those three days is measurable and is recorded in
`docs/reviews/one-hundred-and-fifty.md`: thirteen of a hundred and fifty
messages went unclassified because the third-party endpoint answered 429, and
the live agent hit the same wall twice on the morning of 31 August.

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
