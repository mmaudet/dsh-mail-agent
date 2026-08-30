# Thirty judgements, and what the classifier is actually getting wrong

The owner labelled thirty real messages from their own inbox, blind — the
model's answers were never shown, because an anchored label measures the
anchor. It is the first reference this project has had, and every measurement
before it compared the classifier only to itself.

## The distribution

| | owner | classifier |
|---|---|---|
| `standard` | 18 (60%) | ~5% |
| `important` | 10 (33%) | ~60% |
| `spam-probable` | 2 (7%) | ~1% |
| everything else | **0** | ~34% |

**The classifier over-assigns `important` by roughly two, and under-assigns
`standard` by roughly ten.** It is not a subtle calibration drift.

## Two findings, and one of them was my hypothesis being wrong

### The recipient position is not the signal

The obvious explanation — the classifier is never shown whether the owner is in
`To` or one of twenty in `Cc`, and `renderMessage` genuinely does not carry it —
turns out to be wrong, and wrong in the opposite direction:

| | in `To` | nowhere in `To`/`Cc` |
|---|---|---|
| `important` | **20%** | 80% |
| `standard` | **44%** | 56% |

An `important` message is *less* likely to be addressed to the owner than a
`standard` one. Any rule built on it would have made the classifier worse, and
it took one probe to find that out rather than a release to discover it.

Worth a separate look: 80% of what the owner considers important arrives with
them in neither `To` nor `Cc`. Alias delivery, distribution addresses, or `Bcc`
— it means recipient fields are close to useless as a signal on this mailbox,
whatever the RFCs suggest.

### What actually separates them is narrower than "a human is waiting"

The prompt's first ordered test is *is a human waiting on the owner? →
important*. Read against the labels, that is the defect:

**Called `important`** — a document awaiting signature, a laptop quote awaiting
approval, a new comment on an open support case, a direct question about a
tender, replies in project threads the owner is party to.

**Called `standard`** — *by the same colleagues*: "Transmission de notre réponse
au RFI", "Reporting mensuel ELL", "statut d'avancement prestation", "Demande
d'activation de modules", a calendar invitation.

The second list is full of humans writing to the owner, and one of them is
literally a *demande*. So "a human is waiting" catches most of a work inbox,
which is exactly the 60% observed.

The line the owner is drawing is **a specific action only they can take** —
sign, approve, answer — against **being kept informed**, including by a person,
including when the information is a request that is somebody else's to fulfil.

## The taxonomy is wider than the owner's

Thirty messages, three labels used. No `newsletter-tech`, no
`newsletter-promo`, no `newsletter-notification`, no `transactional`, no
`spam-certain`, no `needs-review`.

A Le Point newsletter, an npm token notification and an OVH domain verification
all came back `standard`.

Two readings, and thirty quick judgements cannot separate them: the owner
collapsed categories while working fast, or their working vocabulary genuinely
has three values where PRD section 4.2 specifies eight. The second would make
the sub-category work — the fallback that filed a traffic fine as a technology
newsletter, the `List-Id` learning, the three newsletter folders — machinery
serving distinctions nobody makes.

**This is worth asking the owner directly rather than inferring**, and it is a
larger question than the prompt: a taxonomy nobody uses is not a classifier
problem.

## What this changes, and what it turned out not to change

The prompt's ordered test needed its first rule replaced, not sharpened. Not
*is a human waiting*, but *is there an action only the owner can take* — with
the counter-case stated, because the counter-case is most of a work inbox: a
colleague sharing a document, a report or a status is `standard`.

That rewrite was written, and then measured against the same thirty. Both
prompts, same thirty messages pinned by id, same model, temperature 0. The
sovereign gateway's certificate is expired, so this ran through OpenRouter on
the owner's explicit authorisation, behind a flag that prints a banner naming
the endpoint before a single message leaves.

| | v2 *human waiting* | v3 *who must act* |
|---|---|---|
| agreement, 8 categories | 6/30 (20%) | 8/30 (27%) |
| `important` assigned | 15 | 9 |
| `standard` assigned | 2 | 10 |

Read alone, that is a 7-point win and the distribution problem is fixed: the
owner called 10 of 30 important, v3 calls 9, v2 called 15.

**It is not a win.** Collapse both to the three categories the owner actually
used — every `newsletter-*` and `transactional` is `standard`, `spam-certain`
is `spam-probable` — and the two prompts are indistinguishable:

| | v2 | v3 |
|---|---|---|
| agreement, 3 categories | **12/30 (40%)** | **12/30 (40%)** |
| `standard` called `important` | 10 | 7 |
| `important` called `standard` | 4 | 7 |
| **boundary errors, total** | **14** | **14** |

Exactly fourteen either way. The rewrite moved the *threshold* and left the
*discrimination* untouched — it bought three false positives back at the price
of three false negatives. That is the signature of a model that cannot see what
separates the two classes: all a prompt can do then is slide the cut point
along a curve, and every point on that curve costs what it gains.

## The number that matters, and it is worse

`standard` is 18 of 30. **A classifier that answers `standard` every time scores
60%.** Both prompts score 40%. Both are well beaten by refusing to think.

And on the one verdict the whole product rests on:

| | flags `important` | really are | precision | base rate |
|---|---|---|---|---|
| v2 | 15 | 5 | 33% | 33% |
| v3 | 9 | 2 | 22% | 33% |

v2's `important` flag carries **no information** — picking 15 of these 30 at
random gives the same 33%. v3's is worse than random.

The honest caveat: n=30 with 10 positives, so 5/15 and 2/9 are not separable
from each other or from the base rate, and this is one mailbox on one day.
What survives the caveat is the negative claim, and it is enough:
**there is no evidence here that the classifier's `important` verdict beats
chance.** Nothing measured so far in this repository could have told us that,
because nothing measured so far compared it to anything but itself. The 61%
`important` rate and the 36% warm efficiency are both still true and both were
measuring how often the machine answered, never whether it was right.

## Why the prompt was never going to be the lever

`renderMessage` gives the model: owner, sender, subject, an unsubscribe flag,
an attachment flag, and 1200 characters of body. From that it is asked whether
there is *an action only the owner can take, that has not been taken*.

The second half of that sentence is unanswerable from what it is shown. Whether
the owner already replied is not in the render. It is in the trace store —
`traces.owner_acted`, written on every pass — and it is never fed back to the
node that needs it. The prompt asks a question about thread state using only
message state.

The same gap explains the earlier finding that 80% of what the owner calls
important arrives with them in neither `To` nor `Cc`. On this mailbox
importance is not a property of the message. It is a property of the owner's
position in a conversation, and every field that would carry it — has the owner
written in this thread, how recently, how many times — is absent from the one
place it is needed.

## Where this leaves the taxonomy

Half of v3's remaining errors are not boundary errors at all: 11 of 22 land in
categories the owner never once used. That is no longer a suspicion from thirty
quick judgements — it is half the error budget spent on distinctions that, on
this evidence, do not exist for this user.

**This is the question to put to the owner directly**, and it is bigger than
the prompt: eight categories are specified in PRD section 4.2, three are used.
The `List-Id` learning, the newsletter sub-categories, the three newsletter
folders are all machinery serving splits nobody makes.

## The obvious next lever, tested before it was built

The section above ended by naming the fix: feed the node the thread state it is
already being asked about. That was measured before it was written, because the
last hypothesis this project tested before building — recipient position — came
back inverted, and one probe cost less than a release.

It came back worse than inverted. On the thirty:

| feature | important | standard |
|---|---|---|
| owner wrote in this thread before | 10% | 0% |
| thread longer than one message | 40% | 61% |
| thread longer than two messages | 40% | 39% |

The one feature pointing the right way fires on a single message out of thirty.
Thread length points the wrong way, and past two messages it separates nothing.

First check whether the feature was merely untested rather than refuted: on this
James server, do sent messages thread with received ones at all? They do — of 28
threads sampled from Sent, 22 contain more than the sent message. The signal is
available, and it is not there.

Measured across 768 inbox messages rather than thirty:

| | count | share |
|---|---|---|
| in a thread with more than one message | 333 | 43% |
| in a thread the owner ever wrote in | 76 | 10% |
| **owner wrote before this message arrived** | **55** | **7%** |

**The feature is structurally unavailable at the moment the decision is made.**
A message is classified when it arrives; the owner's reply, if it ever comes,
comes after. "Has the owner acted?" asked at arrival is a question about the
future, and on 93% of the inbox the answer is trivially no.

So the second half of the rule I wrote — *an action only the owner can take,
**that has not been taken*** — is not merely unfed. It is nearly always true by
construction, and wiring `owner_acted` into the render would have added a column
that reads the same on 93% of the mail. Two hours of plumbing to change nothing,
avoided by twenty minutes of counting.

## What was kept, and why

The v3 prompt is committed. Not because it scored better — on the measurement
that counts it did not — but because its distribution matches the owner's and a
miscalibrated base makes every later experiment unreadable. It is a better
starting point, not a better classifier, and the commit says so.

What it does not do is close this, and the next experiment is now neither
another prompt nor thread state. Both have been measured and neither moves the
boundary.

What is left is the taxonomy, and it is the largest single item: 11 of v3's 22
errors are messages filed into categories the owner never used once. That is
half the error budget spent on distinctions that, on this evidence, do not exist
for this user — and unlike the prompt and the thread, it is not a question this
repository can answer by measuring. It is a question for the owner.
