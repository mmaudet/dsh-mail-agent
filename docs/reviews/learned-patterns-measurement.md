# Does node 3 pay? Measured, with a holdout

The first dry run left the cascade settling 10% of real mail without a model
call, with node 3 empty. PRD section 4.2 bets that recurring senders close that
gap. This measures the bet.

**Protocol.** 200 messages from the target INBOX, newest first. The older 100
teach; the newer 100 are the holdout. Learning and measuring on the same
messages would be circular — a pattern derived from a message settles that
message by construction — so patterns must predict forward.

## The result

| | model calls | settled free |
|---|---|---|
| holdout, no patterns | 90 / 100 | **10%** |
| holdout, with patterns | 88 / 100 | **12%** |

**Four patterns learned from 100 decisions, catching two messages.** The bet
does not pay at this scale.

```
important         cmcaron@linagora.com    (0.90)
important         glehoux@linagora.com    (0.90)
important         jrichard@linagora.com   (0.90)
newsletter-promo  reseauchede@gmail.com   (0.90)
```

## Why, and it is not the threshold

The obvious reading is that three unanimous observations is too strict. It is
not the binding constraint. **In 100 messages, almost no sender appears three
times** — an inbox over a few days is mostly one-off correspondents.

The binding constraint is the granularity. The single largest recurring source
in this mailbox is a mailing list, `[License-review]`, and its messages come
from **many different senders**. A sender pattern cannot catch a mailing list,
ever, however long it runs.

RFC 2919 gives it a `List-Id`, and the list is the thing with a category — not
each person who posts to it. That is the pattern shape this mailbox is asking
for, and node 3 does not have it.

The same is true of the second-largest source: `App Store Connect` notifications
arrive from a rotating set of addresses under one service.

## What the run also settled

Two passes over the same 100 holdout messages disagreed on 5 classifications
while only 2 learned patterns fired, which raised a question about determinism.
Probed directly — 12 messages, 3 identical requests each, temperature 0:

```
  category unstable   : 0 of 12
  confidence unstable : 1 of 12
```

**The category is stable; the confidence wobbles.** Roughly 3% category
instability across the 100-message comparison, consistent with 0 of 12 here.
Low enough not to invalidate a calibration, high enough that a benchmark
comparing two models on a hundred messages should not read a three-point
difference as a result.

The confidence moving between 0.8 and 0.9 matters more than it looks: the
default threshold is 0.75, and a message whose confidence wanders across a
threshold changes category through node 7 without the model changing its mind.

### And a finding about the model, not the harness

Messages from the same `[License-review]` thread came back `standard` on one and
`newsletter-tech` on another. Not a determinism problem — different messages —
but the model has no stable view of what that list is. Node 3's unanimity rule
refused to learn from it, which is exactly the behaviour it was written for: a
source the model cannot classify consistently is one a pattern must not answer
for.

The rule worked. The granularity is what is wrong.

## What follows

**Learn on `List-Id`, not only on the sender.** It is the one change that
addresses the source this mailbox is actually made of, and it needs the header —
which the adapter now fetches, since `headers` was added for the spam nodes.

Two things to hold onto while doing it:

- A list pattern is *more* powerful than a sender pattern, so it deserves the
  same restraint: unanimity, a confidence ceiling, and evidence from the model
  rather than from a cheaper node.
- The measurement here is the template. Any claim that node 3 pays should come
  with a holdout, because the circular version of this experiment would have
  reported a triumphant number.

## The honest headline

The cascade settles 10% of real mail for free today, and 12% with sender
patterns. Neither is the number the architecture's cost argument assumes, and
saying so now is worth more than a plausible projection.
