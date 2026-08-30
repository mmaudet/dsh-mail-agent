# What node 3 actually earns back, measured rather than claimed

Two static rules were removed for guessing — `List-Unsubscribe`, then `List-Id`
— and cold-start efficiency fell to 3%. The claim made in their place was that
node 3 would earn back what they had asserted, on the evidence that of 36
distinct `List-Id` values in the sample, none was sometimes list traffic and
sometimes not.

That was a claim about a routing *table*, and it was measured on a large model's
labels with two sightings required. Node 3 learns from the *economy* model's
verdicts under stricter rules, which is a different thing, and the difference
turned out to be most of the number.

## The first run said 8%, not 33%

396 real verdicts replayed into a real store, through the real learning pass:
**6 patterns, covering 8% of the mailbox.** The single largest source in the
sample — the `license-review` list, 18 messages — learned nothing at all.

Two rules were responsible, and each assumed something the data does not
support.

### `looksAutomated` was another universal heuristic

Sender learning was gated behind a regex on the local part: `noreply`,
`newsletter`, `support`, `billing`. It is the same shape as the two rules
removed earlier this week, and it failed the same way.

It excluded `customer-service@ovh.com` — unanimous over twenty messages, the
largest single sender in the sample — along with a tax-office correspondent, a
security vendor, and three cold-outreach senders. What it let through was three
mailing lists and three addresses that happened to start with the right word.

| | patterns | coverage | agreement with the large model |
|---|---|---|---|
| with the gate | 6 | 8% | 90% |
| without it | 12 | 16% | 86% |

**Coverage doubles for four points.** And what the gate was protecting against —
a colleague's mail becoming a rule — is not what it was doing: on the same data
the most consistent human sender reached 42% on any one category, and the
colleagues scatter across four and five because their mail genuinely varies.
Unanimity was already doing that job, with a wide margin.

### Unanimity assumed a labeller that does not exist

The comment defending it read: *a source that is sometimes important and
sometimes bulk is exactly the one a pattern must not answer for*. That is right
about the mailbox and wrong about the instrument.

The economy model agrees with a larger one on 65% of this mailbox. Under strict
unanimity, one stray verdict in eighteen destroys a pattern — which is exactly
what happened to `license-review`: 16 messages `liste-diffusion`, one
`rapport-compte-rendu-interne`, one `demande-interne`, pattern discarded, 4.5%
of the mailbox lost to two verdicts.

| dominance | patterns | coverage | agreement |
|---|---|---|---|
| 1.0 (unanimous) | 12 | 16% | 86% |
| 0.9 | 12 | 16% | 86% |
| **0.8** | **14** | **22%** | **85%** |

0.9 changes nothing — `license-review` sits at 89%, just under. 0.8 recovers it
and one more, for a single point.

The margin against the thing that matters is unchanged: the most consistent
human is at 42%, half the threshold.

## Where it lands

| | |
|---|---|
| cold, no patterns, no routes | **3%** |
| warm, after one learning pass over 400 messages | **22%** |
| of that, agreeing with the first pass | 86 of 89 |

**22%, not 33%.** The earlier figure was a ceiling computed on a consistent
labeller; the real one is bounded by the economy model's own inconsistency.

Two more numbers bound it further. **161 sources in the sample were seen exactly
once** — 40% of the mailbox arrives from a source that will never recur often
enough to learn, and that mail goes to the model forever. And of the sources
seen three or more times, eleven of twenty-five are colleagues whose mail
legitimately varies and must not be learned.

So the architecture's efficiency claim, restated honestly: **a warm agent on
this mailbox settles about a fifth of it without a model call, and the ceiling
is somewhere near a third.** PRD section 3.3 says seven in eleven. That is not a
number this mailbox can produce, and the gap is not a tuning problem.

## What refuses to be learned, and wants stating instead

The contact-form relay is unanimous over thirty-one messages, at
`needs-review` — the economy model consistently cannot place it, and both cheap
models tested decline it in the same way. The pass now refuses to learn
`needs-review` at all: a pattern asserting that a sender is always
unclassifiable settles nothing, and would stop the model ever being asked again.

That source is 8% of the mailbox and it is the single largest failure of both
models. It is also the clearest case for a stated route: one line from the
owner settles what two models cannot work out.
