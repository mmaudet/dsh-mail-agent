# Every JMAP measurement so far was on 256 messages

A paging bug in this project's own probes, found while asking whether node 1's
eight points were a floor or a ceiling. It does not invalidate the
measurements, and it does change what they were measurements *of*.

## The bug

James caps an `Email/query` response at **256 ids**, whatever `limit` says, and
honours `position` correctly. The probes paged like this:

```js
if (page.ids.length < 500) break;   // ← stops at 256, every time
```

Asking for 500 and receiving 256 was read as "the folder is exhausted". It was
not: the next page starts at 256 and returns another 256.

Verified rather than assumed — `position: 200, limit: 50` returns fifty ids
whose first is exactly `pos0[200]`, and `position: 500` returns a different set
from `position: 0`.

## What was actually being measured

**The inbox holds 32837 messages, of which 15473 are unread.** Every JMAP
measurement in this repository before this correction ran on the 256 most
recent — a real and consistent sample, roughly a day and a half of traffic, but
described in the reviews as though it were the mailbox.

The sentence "your INBOX contains 256 messages, so you triage" was wrong. The
inbox contains 32837.

## What changes, with correct paging

### The recurrence ceiling holds, on twenty times the data

| | 256 messages / 4 days | 3000 messages / 54 days |
|---|---|---|
| distinct sources | 92 | 952 |
| sources seen 3+ times | 22 | 194 |
| **messages they cover** | **64%** | **70%** |

The number survives the correction, which is worth knowing: the small sample
was not misleading about recurrence.

### Node 1's headroom is far larger than measured

500 inbox messages against 3000 of history:

```
  alone in their thread            : 282 (56%)
  thread has an earlier message
    inside the inbox window        : 149 (30%)
    only outside it, already filed :  69 (14%)
```

**Around 44% of inbox messages belong to a thread with an earlier message** —
30% reachable within a window, and a further 14% only reachable by a store that
remembers what has already been filed away.

Against the 8 percentage points measured on a 200-message cold replay. The
`thread-continuity.md` note called that a floor rather than a ceiling on
reasoning alone; this is the number.

It also gives the trace store a purpose beyond audit: **14% of the inbox is
inheritable only by an agent that kept its history**, which is an argument for
retention that nothing else in this project has produced.

## The shape of the mistake

Not a server defect, not a specification error — the seventh and eighth of
those are in `prd-amendments.md`. This one is mine, and it is the same shape as
several of them: **a tolerant read of a response that was actually telling me
something.** A short page meant "capped", and I read it as "finished".

The probes now stop when a page is empty. The reviews written before this are
correct about their sample and wrong about its size, and say so where it
matters.
