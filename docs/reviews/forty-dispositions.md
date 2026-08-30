# Forty messages the agent queued, and the four that were actually waiting

The agent built a queue: every message it had classified as needing the owner,
still sitting in the inbox. Forty of them. The owner wrote a one-line note on
each, in their own words, saying what it asked of them.

Those forty notes are the second reference this project has, after the thirty
labels, and they answer a different question. The labels said *what category is
this*. The notes say *what does it want from me* — which is the question the
queue exists to answer, and the one no measurement had ever touched.

## The queue was ten times too long

Sorting the notes into four dispositions:

| | n | of which already answered |
|---|---|---|
| information — copied in, notified, nothing expected | 20 | 0 |
| already handled | 7 | 6 |
| wants a reply | 8 | 4 |
| wants an action that is not an email | 5 | 0 |

**Ten of the forty had already been dealt with**, and the agent had no idea.
Removing those leaves thirty; of those, **four want a reply and five want an
action.** The queue was forty items long and should have been nine.

The ten are detectable for nothing: a reply in `Sent` carries the original's
`Message-ID` in `In-Reply-To`. Exact, no model, no heuristic, no false
positives. It is pure defect — the queue's filter was *classified as needing
the owner, and still in the inbox*, and the second half of that is wrong,
because this owner replies without filing.

One caveat on the table, stated rather than hidden: sorting the notes is
itself a judgement, and two runs of the same model disagreed on one message —
the boundary between "I replied" and "a reply is owed" is genuinely blurry in a
note like *"il suffisait simplement de lui confirmer"*. Both runs agreed on
every other message, and both put **four** replies genuinely pending.

## What the twenty information messages have in common, and it is not `Cc`

Thirteen of the notes say some version of *"je suis en copie"*. The obvious
reading is that the owner is in `Cc`, and it is wrong: **only three of the
twenty are.** Twenty of the forty name the owner in neither `To` nor `Cc`.

They are not malformed. Every one has a populated `To` — addressed to a group
alias the owner belongs to, and reaching them through `Delivered-To`:
`vente@`, `expertise-libre@`, `dg@`, `canut-libre@`, `communication@`,
`gandi@`, `azure-account@`. "En copie" is the owner describing their *position
in a conversation*, not a header.

That reframes the test. Not *in `To` or in `Cc`*, but **addressed to me, or to a
list I am on**:

|  | addressed to the owner | addressed to a list |
|---|---|---|
| wants something (9) | 6 | 3 |
| wants nothing (21) | 6 | 15 |

67% and 71%. Better than the raw `To` test, and still not a rule worth
shipping: it would bury the Microsoft 365 renewal, the subcontracting question,
and the LinTO contact — three of the nine things actually waiting — while
keeping six notifications.

## The aliases are not interchangeable

Broken down by the address that carried the message, the aggregate hides the
only usable structure in it:

| carried by | n | pending |
|---|---|---|
| the owner, personally | 20 | 6 |
| `vente@` | 4 | 1 |
| `expertise-libre@` | 4 | **0** |
| a colleague’s own address | 6 | **0** |
| `dg@` | 2 | 0 |
| `gandi@`, `communication@` | 2 | 0 |
| `canut-libre@`, `azure-account@` | 2 | **2** |

`expertise-libre@` is a reporting list: four status mails on the same
engagement, all information, none pending. `vente@` is a sales lead address:
mostly information, but one of the four is a prospect the owner has to answer
himself. Those two lists have opposite meanings, and *no rule over "am I in
`To`" can tell them apart* — because the difference is not in the message, it
is in what the owner does with that list.

Which is the shape every finding in this project keeps landing on. The generic
version fails; the owner-stated version is a single line of configuration.
`expertise-libre@ → information` is a route the owner can declare and node 2b
already applies deterministically, with no model call and no confidence score.

Even the personal address is 70% noise: twenty messages to `mmaudet@`
directly, six of them pending.

## Score

Five generic hypotheses have now been tested against this mailbox and refuted:

1. recipient position predicts importance — **inverted**
2. thread state settles node 1 — **7% of the inbox**
3. thread context improves a draft — **made it worse**
4. intent can be enumerated ahead of time — **3 of 8**
5. addressing predicts what a message wants — **67% / 71%**

And the two things that have survived every measurement are both facts the
owner stated: a route, and a note.

## What this changes

- **Filter answered mail out of the queue.** Ten of forty, exact, free.
  Not a heuristic — a join on `In-Reply-To`.
- **Sort by addressing, never filter by it.** It puts two of the four pending
  replies at the top and buries the other two, which is worth an ordering and
  is not worth a hidden message.
- **`expertise-libre@` is a stated route**, on the same footing as the
  contact-form rule already in the profile.
- **A message the owner sent themselves must never be queued.** One was: their
  own reply, delivered back into the inbox.
