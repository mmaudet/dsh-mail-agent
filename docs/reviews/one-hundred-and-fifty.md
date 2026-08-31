# 150 labels, and the boundary the prompt names and does not create

The owner labelled 150 messages from their own inbox, one at a time, without
seeing the classifier's answers. It is the first reference of any size this
project has had — the earlier one was thirty — and it was collected with the
whole message in front of them rather than its first two lines, which the
labelling page had been showing until they said so.

The deployed classifier (Mistral Small 3.2, the sixteen-category prompt) then
ran over the same 150.

## The result

**150 scored. 53% exact category. 69% right band.**

| the owner said | classifier said `acts` | `reads` | `drops` |
|---|---|---|---|
| **acts** (23) | 14 | 4 | **5** |
| **reads** (83) | **18** | 55 | **10** |
| **drops** (44) | 1 | 9 | 34 |

The first run of this scored 137 of the 150 at 53% and 69% — the same two
numbers — and lost thirteen messages to a third-party endpoint answering 429.
The run above went through the sovereign gateway and lost none.

That comparison is worth keeping. The endpoint the project was built against
had an expired certificate from 30 August, so for three days every measurement
went somewhere else and carried a banner saying so. The replacement,
`inference.linagora.com`, serves the same model, scores identically, and
answers every request. The detour cost 9% of a run and bought nothing.

The bands are what matter. A confusion inside a band costs a folder; one across
a band costs either an unanswered request or a message the owner never sees.

## Three failures, and two of them are the same failure

**Sixteen messages queued for nothing.** Mail the owner reads and answers
nothing, offered to them as work. Almost all of it is one confusion:
`rapport-compte-rendu-interne` read as `correspondance-commerciale-client` or
`demande-interne` — a colleague sharing a report, taken for a colleague asking.
That category scores 37%.

**Ten messages the owner keeps, judged disposable.** Eight are newsletters,
event invitations and vendor announcements he subscribed to, read as cold
prospecting. `liste-diffusion` scores 46%.

Those two are opposite in direction and identical in kind: *being informed* read
as *being asked*, and *content chosen* read as *content pushed*. Both boundaries
are stated in the prompt, in as many words:

> Being kept informed is band B, and most of a work inbox is being kept
> informed.

> An unsubscribe link does NOT settle this: the owner subscribes to newsletters
> too. Ask instead whether they ever asked for it.

They are the two longest paragraphs in the prompt, they name exactly the two
mistakes that happen, and they do not prevent them. **Stating a boundary does
not create it.** The same defect was measured on thirty labels three days ago;
at five times the sample it has not moved.

**Four requests filed away**, the expensive error: a signature request from a
platform, a "Marchés Online" alert the owner treats as internal work, and twice
`Request from [lucie.chat]` — a real enquiry arriving through the contact form
relay that a stated route sends to Junk. That last one is not the classifier's
fault. It is the price of the route, quantified: the profile note says roughly
two in thirty-two are genuine, and here it is two in a hundred and fifty.

Worth stating plainly: none of the ten drops would have executed. Every `move`
and `trash` is `ask` unless `decidedBy` is `stated-route`, so a model verdict
proposes and waits. The provenance rule is the reason a 46% category is not a
mailbox emptying itself.

## The categories that do not exist

The owner used **fourteen** of the sixteen. `rh-interne` and `phishing-arnaque`
got nothing in 150 messages — and the classifier assigned `phishing-arnaque`
five times, all of them to cold prospecting.

And the labelling page and the package had drifted on a name:
`liste-diffusion-licence-open-source` against `liste-diffusion`. Same concept,
same band, 25 of the 150 carrying it. Harmless here because it was caught, and
the kind of thing that turns a measurement into a fiction when it is not.

## Two things tried against it, and neither worked

With 150 labels there is finally enough to hold half back. The odd-numbered
messages were read for their errors; the even-numbered ones were not looked at
until the end. On the deployed prompt the two halves score 53%/71% and
54%/66%, so the split is not doing any work of its own.

### Rewording the prompt: no effect

Three changes, each from a band-crossing error in the development half and
nothing else: the base rate stated from the owner's own distribution (15% A,
55% B, 30% C); band A turned into a test with evidence — *point to the sentence
that asks, and a thread about a deal is band B while the owner is only being
kept in the loop*; and receipt-versus-bill decided on whether the money has
already moved rather than on what the subject line calls it.

On the holdout: **exact 54% → 51%, band 66% → 69%.** Three messages fixed, five
broken. On 65 messages that is inside the noise, and the honest reading is that
it did nothing.

This is the same intervention that moved precision from 50% to 70% on the
binary question the day before. It does not transfer. A stated base rate helps
a model that is systematically biased one way; these errors are not a bias, they
are adjacent categories being confused in both directions at once.

### Sender memory: it would fix six errors out of sixty-four

The architecture already has somewhere to put a fact a prompt cannot reason to:
learned patterns for a sender the agent has decided about before, stated routes
for one the owner has. So: how much of the error sits on senders that recur?

**101 distinct senders for 150 messages.** Seventeen appear twice or more, and
nine of those the owner labels consistently. Of sixty-four errors, twenty-two
are on a recurring sender and only **six** are on one the owner is consistent
about.

This mailbox is a long tail. Sender memory is worth having — `customer-service@ovh.com`
is eight messages of one category — and it is not where this error lives.

## What the two measurements say together

Of the owner's twenty band-A messages the classifier finds fourteen: 70%
recall, and 45% precision because it calls thirty-one messages band A.

The binary question — *does this ask the owner for something?* — measured on a
different sample the day before, scores 78% recall and 70% precision.

**Asking directly beats deriving it from a sixteen-way classification**, on the
one thing the owner actually uses the agent for. The categories may still earn
their keep for filing, where a wrong-but-adjacent answer costs a folder. For
the queue they are a detour, and the detour loses precision.

Rate limiting cost 9% of the run, thirteen messages with no answer at all. That
is separate from every accuracy number here and larger than the difference
between the two prompts.
