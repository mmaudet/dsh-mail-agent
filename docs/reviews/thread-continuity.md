# Node 1 pays, where the other two did not

Three measurements of learned patterns came back at two points, one point, and
no advantage on a second mailbox. This is the fourth measurement of the
cascade's cost argument, and the first that moved.

## The result

200 messages from the target INBOX, replayed oldest first — exactly as a poll
would meet them, because a thread can only be inherited from after it has been
decided, and any other ordering measures a future the agent will not have.

```
without node 1: 200 classified, 188 model calls,  6% free
  llm=188  static-rule=12

with node 1   : 200 classified, 172 model calls, 14% free
  llm=172  thread-continuity=16  static-rule=12
```

**Eight percentage points. Sixteen fewer model calls out of 188, and the free
rate more than doubled.**

| Node measured | Gain |
|---|---|
| learned patterns, by sender | +2 points |
| learned patterns, by `List-Id` | +1 point |
| learned patterns, on a second mailbox | none |
| **thread continuity** | **+8 points** |

## Why this one worked

The consistency measurement said the constraint was that a source with several
purposes has several categories, and most sources have several purposes. Node 1
does not reason about sources at all.

A thread is one conversation about one thing. It is the unit that actually has
a single category, where a sender is not — and on this mailbox **100% of
messages carry a `threadId`**, so the mechanism applies to everything.

That is also why it reaches the traffic the other nodes could not. Learned
patterns catch services; static rules catch bulk. Node 1 catches **people
replying to each other**, which is what 70% of this mailbox is.

## What the number is not

**Not the ceiling — and now measured.** Sixteen of 200 is what a cold store
reaches on a 200-message window: every thread has to be decided once before it
can be inherited from, so the first message of every thread pays full price.

Measured afterwards over 500 inbox messages against 3000 of history: **44% of
inbox messages belong to a thread with an earlier message** — 30% reachable
within a window, and a further 14% only by a store that kept what has already
been filed away. See `paging-correction.md`, which also records that every JMAP
measurement before it ran on 256 messages rather than the 32837 the inbox
holds.

**Not additive with the pattern number.** A message settled by node 1 would
often have been settled by node 3 too, and node 1 runs first. The 19% pattern
ceiling and this 8% overlap by an amount nobody has measured.

**Not free of the classifier's problems.** Node 1 inherits a decision the model
made, so a thread whose first message was misclassified propagates that
misclassification to every reply. The three refusals — never `needs-review`,
never below the floor, always the most recent — bound how far that goes, and do
not eliminate it.

That last one deserves stating plainly: **node 1 makes the classifier's first
answer about a thread more consequential**, because it is now reused instead of
re-derived. It is a cost saving bought with a correctness risk, and the floor is
what sets the price.

## What follows

The obvious next measurement is a warm store — replay a month rather than a
window, and see where the inheritance rate settles once threads predate the
run. That is a bigger read than anything done so far and costs only time.

And it makes a case for the store having a retention policy before it has a
year of traces in it, which nothing has needed until now.
