# The first dry run over a real mailbox

100 messages from the target INBOX, classified, nothing written. This is the
Phase 2 output PRD section 6 asks for, and it answered one question and raised
four.

## The number the architecture rests on

```
  classified   : 100
  model calls  : 57
  settled free : 43%
  wall clock   : 153.6s
```

**43% of real mail is settled without a model call.** The synthetic corpus says
10 of 14, or 71%.

That gap is the finding. A corpus written to exercise each node has one case per
node by construction; a mailbox has whatever it has. Any cost projection built
on the corpus overstates the cascade's efficiency by roughly two thirds, and
nobody would have known without running it.

It is also a **floor rather than a verdict**: two of the six cheap nodes cannot
fire yet. Thread continuity needs a thread history nothing supplies, and learned
patterns need patterns nothing has accumulated. Both are the nodes that should
absorb recurring traffic, which on a real mailbox is most of it. The honest
statement is *43% before the two nodes designed to grow*.

| Node | Decisions in 100 |
|---|---|
| static-rule | 42 |
| llm | 57 |
| spam-prefilter | 1 |
| thread-continuity | 0 — nothing supplies a thread history |
| learned-pattern | 0 — nothing accumulates patterns |
| brand-spoofing | 0 |

## Four findings, in the order they were found

### 1. Two nodes had never been reachable

`capabilities.spamHeaders` reported `true` and every message arrived with none.
JMAP returns only the properties asked for, and the adapter asked for a fixed
list naming no header at all — while the extractor scanned the reply for keys
that could never appear. **Nodes 2 and 5 have been dead since they were
written**, with a full unit suite green over both.

### 2. The header convention in the PRD is not the one the server uses

PRD section 4.2 says the prefilter consumes `x-spam-*`. The target account emits
none of it. James stamps:

```
org.apache.james.rspamd.status: No, actions=no action score=-1.307155 requiredScore=15.0
```

### 3. The threshold was hardcoded, and wrong for this deployment

`JUNK_SCORE = 10`, from rspamd's documented default. The server states
`requiredScore=15.0` in every message. A message scoring 12 is junk under the
constant and clean under the server's own judgement — **silently, on the node
with no review path.** The threshold is read from the header now.

### 4. `newsletter-tech` is a catch-all, and it is permanent

39 of 100. `newsletterSubcategory` files anything carrying an unsubscribe link
with no stronger signal as the technology digest, so a press review, a political
newsletter and a parish bulletin all land there.

Worse, node 4 settles at **confidence 1**, so node 7 cannot degrade it and the
model never sees it. A misfile here is not a low-confidence guess anybody
reviews; it is a permanent verdict from a default.

This is the same shape as the node 5 finding from round two: a rule with more
authority than its evidence supports. The fix is the same shape too — either the
fallback stops being a category, or it stops being certain.

## What the run also showed, quietly

- **1 prefilter decision in 100.** Real mail sits far below any spam threshold;
  the node earns its place on the rare case, not on volume.
- **57 model calls in 154 seconds**, about 2.7 s each against the sovereign
  gateway, entirely serial. A daily inbox is minutes, not hours.
- **Forwarded Microsoft mail** carries `ARC-Authentication-Results` and
  `X-MS-Exchange-Authentication-Results`. Both are assertions about a previous
  hop, and reading them as this delivery's authentication would let a forwarding
  chain decide whether mail is forged. They are excluded deliberately.

## The pattern, again

Every one of these was invisible to 234 unit tests and to a container. The dry
run is the third instrument this project has built that found something nothing
else could — after the integration suite and the live `mail_ping` — and each
one found defects in code that was already green.

The corpus is not wrong, it is *narrow*: it says what each node does when it
fires. Only a mailbox says how often that is.
