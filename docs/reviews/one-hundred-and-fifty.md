# 150 labels, and the boundary the prompt names and does not create

The owner labelled 150 messages from their own inbox, one at a time, without
seeing the classifier's answers. It is the first reference of any size this
project has had — the earlier one was thirty — and it was collected with the
whole message in front of them rather than its first two lines, which the
labelling page had been showing until they said so.

The deployed classifier (Mistral Small 3.2, the sixteen-category prompt) then
ran over the same 150.

## The result

**137 scored. 53% exact category. 69% right band.**

Thirteen messages are missing because the provider answered 429 thirteen times,
not because anything classified them wrongly. That is a ninth of a run lost to
rate limiting, and it is worth its own line: a classifier that cannot be
reached is a classifier that is not deciding.

| the owner said | classifier said `acts` | `reads` | `drops` |
|---|---|---|---|
| **acts** (20) | 14 | 2 | **4** |
| **reads** (76) | **16** | 50 | **10** |
| **drops** (41) | 1 | 10 | 30 |

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

## What this says to do

1. **`recu-transaction` scores 17%** — four of six read as
   `obligations-administratives-echeance`. A receipt taken for a bill due, which
   the prompt also names ("Keep vs. owe"). Three boundaries named, three
   boundaries missed: the prompt is being read as description rather than as a
   test.
2. The two confusions are *between named categories*, not a failure to
   understand the mail. That is a discrimination problem, and the thing that
   moved a discrimination problem on this mailbox before was rewording the
   question rather than restating the rule
   (`docs/reviews/asking-the-right-question.md`).
3. Rate limiting cost 9% of the run. Whatever the classifier's accuracy, the
   agent needs an answer for every message, and thirteen have none.
