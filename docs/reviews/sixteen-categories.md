# Sixteen categories, derived from the mailbox instead of specified

PRD section 4.2 names eight categories. They were written before anyone had
looked at a mailbox, and nothing since had checked them against one.

Two measurements in a row said they were wrong, in opposite directions. Thirty
messages the owner labelled blind used **three** categories, and half the
classifier's errors were mail filed into categories they never used once
([thirty-judgements.md](thirty-judgements.md)). Then, fifteen messages into
labelling a hundred and fifty under three, the owner stopped: three cannot
annotate correctly either.

Both numbers were guesses. This is the measurement.

## Method

Three passes over 400 real inbox messages spanning a month, reproducible with
`scripts/benchmark-taxonomy.mjs`.

**Pass 1 — describe, do not classify.** Each message gets a free-form answer to
what it *is*, what it *asks*, who sent it, and whether a deadline is stated. No
vocabulary is offered, and the prompt says so: *n'essaie pas de faire rentrer
les messages dans des cases*.

It produced **356 distinct descriptions for 400 messages** — which is itself the
first result. No short list falls out of this mailbox naturally; any taxonomy is
a decision about which differences to stop caring about.

Two numbers from that pass matter on their own:

| | |
|---|---|
| messages that ask nothing | **263 of 400 (66%)** |
| messages with an explicit deadline | 33 (8%) |
| machine senders | 198 · humans 135 · via a list 43 |

The 66% matches the owner's own 60% `standard` on the earlier thirty, from a
completely different instrument.

**Pass 2 — group under one rule.** A category exists only if it passes both
tests: at least 2% of the corpus, and **the agent does something different with
it**. Two classes that end in the same place with the same urgency are one class
badly named.

**Pass 3 — measure the residual.** The same 400 messages reclassified under the
result, with `autre` available and the prompt instructing it be used rather than
forcing a fit.

## Result

Sixteen categories, **97% coverage**. The volumes below are measured in pass 3,
not estimated in pass 2 — the two differ, sometimes by a lot: cold prospecting
was estimated at 10% and measured at 16%.

### The owner must act — 35%

| category | measured | |
|---|---|---|
| `correspondance-commerciale-client` | 15% | an offer, quote or project wanting a substantive answer |
| `obligations-administratives-echeance` | 9% | pay, sign, renew, before a date |
| `planification-reunion-rdv` | 4% | only a time to fix |
| `demande-interne` | — | a colleague wants a decision |
| `incident-securite` | 1% | escalated, never queued |

### Worth reading, nothing to do — 34%

| category | measured | |
|---|---|---|
| `veille-newsletter` | 11% | editorial content the owner subscribed to |
| `support-technique-ticket` | 9% | a ticket, incident or account the owner opened |
| `notifications-personnelles-diverses` | 6% | no professional value |
| `liste-diffusion` | 5% | mailing-list traffic |
| `rapport-compte-rendu-interne` | 4% | a colleague informs, expects nothing |
| `rh-interne` | 2% | someone already employed |
| `candidature-emploi` | 2% | an external candidate |
| `recu-transaction` | — | money that already moved |

### Nothing to read, nothing to keep — 30%

| category | measured | |
|---|---|---|
| `prospection-commerciale-non-sollicitee` | **16%** | cold approach, no existing relationship |
| `spam-formulaire-contact` | 9% | automated web-form filler |
| `phishing-arnaque` | 5% | written to deceive or extort |

**The largest single category in this mailbox is cold prospecting, ahead of the
owner's own client correspondence.** Nothing in the PRD had a name for it: its
nearest word was `newsletter-promo`, which files rather than discards, and which
would have put a sixth of the inbox in a folder the owner reads.

## The residual named two of the sixteen

Eleven messages fell to `autre`. Reading them one by one, rather than counting
them, is what produced the last two categories.

**Four were a colleague asking the owner to decide** — *valider redirection
obm.org*, *préciser angle intervention*. The fourteen had
`rapport-compte-rendu-interne` for a colleague who informs and nothing for a
colleague who asks. That is the distinction the owner cares most about, and the
derivation had missed it.

**Three were receipts** — money already moved, nothing to do, worth keeping for
accounting. `obligations-administratives-echeance` covers the obligation *before*
a date; nothing covered the record *after*. The PRD had this one, under
`transactional`, and the derivation lost it.

The rest were newsletters and a bounce, which the existing categories absorb.

## Eight distinctions rejected, and why that list matters

- **`newsletter-tech` vs `newsletter-promo`** — the PRD's own split. Same
  handling either way: read once, forgotten. One category badly named.
- **`bon-de-commande`** — under 2%, and handled exactly like the other dated
  obligations.
- **`confirmation-paiement` separate from the invoice** — same financial
  follow-up.
- **`arnaque-nigeriane` vs `sextorsion`** — same intent, identical handling.
- **`invitation-linkedin`**, **`alerte-google`**, **`candidature-transmise-par-collegue`**,
  **`questionnaire-satisfaction`** — all below volume, all handled like their
  parent.

Every one of them is a distinction a person would naturally draw and that costs
more than it returns. The rejected list is the working half of the method: the
test is not *is this a real difference* but *does the agent act on it*.

## What it cost in the cascade

Node 4 used to guess a newsletter sub-category from the sender's local part and
subject markers. That rule is gone, and the corpus's no-model ratio fell from
0.6 to 0.5 with it.

The reason it had to go is not that it was inelegant. `List-Unsubscribe` proves
a message is bulk and says nothing more, and the two bulk categories are now
handled in **opposite directions** — subscribed editorial is filed and read,
cold prospecting is trashed unattended. The question that separates them is
whether the owner ever asked for it, and no header records that. A rule that
guessed there would trash a newsletter or file a sixth of the inbox as reading.

It was also wrong: on the target inbox, 40 of 42 bulk messages matched no
sub-category signal, and the two it did answer were a mailing list, an OVH
support case and a traffic-fine notice, all filed as a technology newsletter at
confidence 1 — where node 7 cannot degrade them and the model never reviews them.

Node 4 gained `List-Id` in exchange. A list is a list whatever it carries, it is
5% of this mailbox, and it costs nothing.

## What is still unmeasured

Everything about whether the classifier can *hit* these sixteen. The taxonomy is
derived from the mail; the accuracy against it is not measured at all, and the
last thing that was measured — the `important` verdict under the old vocabulary
— did not beat chance on thirty labels.

The hundred and fifty labels being collected now are for exactly that, and the
0.9 confidence floor on the one automatic trash rule is standing in for them
until they land.
