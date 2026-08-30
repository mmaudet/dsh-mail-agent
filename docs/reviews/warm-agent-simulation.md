# The cascade warm: 36%, and a classification that stops meaning anything

1000 messages over 40 days, oldest first, with threads and patterns
accumulating exactly as the running agent would have them. The first
measurement of the whole thing rather than one node against a cold store.

## The cost argument holds, once warm

```
  after  100: 10% free in the last 100   (2 patterns)
  after  200: 20%                        (7)
  after  300: 39%                       (13)
  after  400: 44%                       (15)
  after  700: 46%                       (26)
  after  900: 49%                       (31)
  after 1000: 23%                       (36)
```

| settled by | | |
|---|---|---|
| llm | 643 | 64% |
| **thread-continuity** | **174** | **17%** |
| **learned-pattern** | **121** | **12%** |
| static-rule | 62 | 6% |

**36% overall, and around 45% in steady state.**

Every earlier measurement in this repository was a cold-start measurement. Six
percent, ten, fourteen, plus-eight — all of them a store with nothing in it and
a window too short to fill one. The conclusion built on them, that the PRD's
cost argument was weaker than the document assumed, was measuring the first
hour of a system designed to run for months.

It is weaker at the start. It is not weaker in operation.

**Learned patterns pay after all.** Three holdouts said one or two points; over
1000 messages and 40 days they settle 12%. The holdouts were not wrong about
what they measured — a hundred-message learning window on a mailbox receiving
two hundred a day is half a day, and a source that appears weekly cannot be in
it twice.

## And the classification has stopped being useful

```
   613  important
   131  newsletter-promo
    88  transactional
    59  newsletter-notification
    48  standard
```

**61% of the mailbox came back `important`.** The 100-message cold dry run gave
24%.

Everything important means nothing is. A triage that files three of five
messages as needing the owner's attention has not triaged anything, and the
36% saving is bought at exactly that price.

### Where the inflation comes from

Not the model alone — it answered 24% on the same mailbox with an empty store.
What changed is that decisions are now **reused**:

- node 1 inherits a thread's category into every reply
- node 3 learns a sender's category and answers for all their mail

Both were built to reuse a decision. Neither knows whether the decision was
right. So a single `important` early in a thread becomes `important` for every
message after it, and a colleague classified `important` three times becomes a
pattern that answers `important` for everything they send.

This is precisely the risk written down when node 1 was built — *it makes the
classifier's first answer about a thread more consequential, because it is
reused rather than re-derived* — and it is larger than that note implied. The
three refusals bound how bad an individual inheritance can be. They do nothing
about a bias that is spread evenly across the corpus being amplified evenly.

**The cache does not just save calls. It concentrates whatever the classifier
leans towards.**

### Which makes the saving harder to read

The 36% and the 61% are the same mechanism seen twice. Any future measurement
of cascade efficiency on this system has to report a category distribution
beside it, because a number that improves while the answers converge on one
label is not obviously an improvement.

## What follows

**The prompt has an `important` bias worth measuring on its own.** 24% on a
cold store is already high for a mailbox where most traffic is bulk, and it is
the input the caches multiply. Sharpening node 6's boundaries paid last time
and this is a sharper target: what makes a message *not* important.

**A pattern should not be learnable for a whole person.** Node 3's unanimity
rule already refuses inconsistent sources; a colleague classified `important`
three times running passes it while being exactly the case that should not
generalise. The `List-Id` grouping was the right instinct applied to the wrong
half — services and lists are learnable, individuals are not.

**Node 1 needs the condition the PRD actually states.** Section 4.2 says *a
thread where the owner has already acted*, and what is implemented is *a thread
already classified*. The owner having replied is a fact about the owner, not
about the classifier, and it is the one signal in this whole design that cannot
be inflated by reuse.

## Not to be lost

The last slice dropped to 23% from 49%. One slice is not a trend, and a mailbox
has quiet weeks and busy ones — but a metric that swings twenty-six points
between adjacent hundreds is not one to quote to a single significant figure.
