# Two cheap models on the same 400 messages

The vocabulary was derived by a large model. Production runs a 24B one. This
runs both a 24B Mistral and a 32B Qwen through the same cascade, over the same
400 messages, and compares them to each other rather than only to the reference.

The comparison matters more than either score: agreement with a third opinion is
not accuracy, but **two models failing on the same messages have found something
hard**, and two giving the same wrong answer are the shortlist for the reference
being wrong.

## The run that had to be thrown away first

Qwen's first pass errored on 292 of 400 messages: *"the model returned no JSON
object"*. It read as a model that cannot follow a format.

It was the harness. `max_tokens: 300` was tuned for Mistral, and Qwen3-32B is a
reasoning model that spends about 345 tokens thinking before emitting its first
character — so the answer never arrived. At 1600 tokens it errors on 10 of 400
and answers correctly. `reasoning: { enabled: false }` does not turn it off on
this provider.

Worth carrying forward as a production fact rather than a footnote: **a
reasoning model costs about 500 completion tokens per message where Mistral
costs about 50.** On a mailbox taking two hundred a day that is the difference
between the two, before any accuracy argument.

## Mistral is the better choice here

| | agreement with the reference |
|---|---|
| `mistral-small-3.2-24b` | 244/375 — **65%** |
| `qwen3-32b` | 199/375 — **53%** |

| | |
|---|---|
| both agree with the reference | 171 (46%) |
| only Mistral | 73 (19%) |
| only Qwen | 28 (7%) |
| neither | 103 (27%) |

Qwen is more cautious — 52 `needs-review` against Mistral's 36 — and that
caution is where most of its twelve points go.

## The finding that should stop the trash rule

| | would trash unattended |
|---|---|
| `mistral-small-3.2-24b` | 89 of 386 (23%) |
| `qwen3-32b` | 11 of 386 (3%) |
| both | 11 |
| **only one of them** | **78** |

**Seventy-eight messages — 20% of the mailbox — are deleted or kept depending on
nothing but which model is deployed.**

That is a different objection from the earlier one. The first dry run showed the
rule taking 30% more than its category and being wrong on a third of it; that
reads as a calibration problem, and a calibration problem has a threshold you
can move. This does not. **The rule's scope is a property of the model, not of
the mailbox**, and no confidence floor expresses that — both models are
confident, they simply disagree about what cold prospecting is.

The grant was made on a measured fact (16% of the mailbox, ahead of the owner's
own client mail) and it is still a real problem worth solving. What this says is
that a *model verdict* is the wrong thing to hang an irreversible action on.

A stated route is not. It is the owner asserting a fact about their own mail, at
confidence 1, and it is deterministic across models. That is the shape the
automatic trash should take: `ask` by default, `auto` for the senders the owner
named.

## Where both models fail together, and what it says

Of the 103 messages neither matched, **they gave the same answer on 72**. Those
are not two models being wrong twice; they are the reference's weakest points,
or genuinely undecidable mail.

| both said | instead of | |
|---|---|---|
| `needs-review` | `spam-formulaire-contact` | 23 |
| `needs-review` | `phishing-arnaque` | 6 |
| `recu-transaction` | `obligations-administratives-echeance` | 5 |
| `rapport-compte-rendu-interne` | `correspondance-commerciale-client` | 5 |

**The largest single failure in the whole comparison is the contact form**, and
both models handle it the same way: they decline. That is the honest answer —
a form submission is ambiguous without knowing the form — and it is 9% of this
mailbox going to `needs-review` forever.

It is also exactly what a stated route removes. 31 of 36 come from one address,
`nple@linagora.com`, with one subject. A stated route settles them at confidence
1 with no model call at all, which is the same measurement arguing for the same
mechanism from the other end: the thing two models cannot work out is the thing
the owner already knows.

The second cluster — receipts read as obligations, client mail read as internal
reports — is the band-A boundary, the expensive one, and it is where the
hundred and fifty human labels will actually settle something.

## What this changes

- **Keep Mistral.** 65% against 53%, at a tenth of the completion tokens.
- **Do not arm the automatic trash on a model verdict.** Reduce it to `ask`, and
  let a stated route be the only path to `auto`.
- **The contact-form route is worth stating before anything else.** It is the
  single largest failure of both models and it costs one line.
