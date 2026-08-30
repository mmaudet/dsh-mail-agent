# The first run under sixteen categories, and why the trash rule cannot be armed

The vocabulary was derived by a large model reading 400 real messages. This is
the production cascade — the 24B economy model, the shipped prompt, the shipped
approval policy — over the same 400, writing nothing.

Three questions, in the order they matter.

## 1. The trash rule would take 23% of the mailbox, and 30% of that is disputed

Cold prospecting is the only category the owner authorised removing unattended,
at a 0.9 confidence floor.

| | |
|---|---|
| messages the rule would trash | **90 of 396 (23%)** |
| of those, the large model called something else | **27 (30%)** |
| messages the large model called prospecting that the rule left alone | 2 |

The benchmark measured prospecting at 16% of the mailbox. The cheap model
assigns it to 23%, so **the rule is 40% wider than the category it is supposed
to implement**.

What the 27 disputed messages actually were:

| the large model said | count |
|---|---|
| `veille-newsletter` | 7 |
| `notifications-personnelles-diverses` | 5 |
| `candidature-emploi` | 3 |
| `correspondance-commerciale-client` | 3 |
| `phishing-arnaque` | 3 |
| `obligations-administratives-echeance` | 2 |
| `spam-formulaire-contact` | 2 |
| other | 2 |

Three job applications, three client threads, and a *"Dernier rappel :
souhaitez-vous conserver votre compte"*. Deleted silently, with no digest entry,
on a thirty-day timer.

**The confidence floor does not catch any of this.** All 27 disputed verdicts
came back at 0.90 or 0.95. The floor was set to stand in for evidence until the
owner's labels arrive; this run says it does not, because the cheap model is
confidently wrong rather than unsure.

The floor is not the fix. Either the rule waits for the labels, or it moves to
`ask` and the owner clears a batch at a time.

### One number moved for a good reason and made this worse

The earlier pass of this same run put the trash at 61 messages, not 90. The
difference is the `List-Id` rule being removed between them: it was absorbing 15
cold pitches into `liste-diffusion`, and removing it returned them to the model,
which classified them correctly — and correctly means trashed.

Fixing a bad rule enlarged the blast radius of a risky one. Worth stating,
because the two changes look unrelated on the diff.

## 2. The cheap model agrees with the large one 64% of the time

| | |
|---|---|
| exact category | 248/385 (**64%**) |
| same band (act / read / drop) | 283/385 (**73%**) |

(Both counts fold in 16 messages where the only difference is the rename from
`liste-diffusion-licence-open-source` to `liste-diffusion`.)

Where they part company:

| | |
|---|---|
| `spam-formulaire-contact` → `needs-review` | 30 |
| `correspondance-commerciale-client` → `rapport-compte-rendu-interne` | 10 |
| `veille-newsletter` → `prospection-commerciale-non-sollicitee` | 7 |
| `phishing-arnaque` → `needs-review` | 7 |
| `obligations-administratives-echeance` → three different things | 15 |

Two patterns, and neither is random noise.

**The cheap model says "I don't know" on 38 messages (10%)** — almost all of
them the Twake contact-form notifications, which are 9% of this mailbox and
which it cannot tell from real enquiries. That is the single largest failure and
it is a coherent one: those messages *are* ambiguous without knowing the form.

**It cannot see obligation.** Fifteen messages the large model read as something
due before a date, it read as a receipt, a report, or an internal request. That
is the band-A boundary, and it is the expensive one to miss.

This is not yet a verdict on the vocabulary. It is a measurement of one model
against another, and the only reference that settles which is right is the
hundred and fifty labels being collected.

## 3. The cheap nodes settle 3%

| node | messages |
|---|---|
| `llm` | 384 |
| `static-rule` | 8 |
| `spam-prefilter` | 3 |
| `brand-spoofing` | 1 |

**12 of 396.** Cold — no VIP list configured, no learned patterns.

PRD section 3.3 puts seven messages in eleven ahead of the model. Under this
vocabulary, cold, the cascade is a model call with three exceptions. The
architecture's efficiency claim now rests entirely on what node 3 learns, which
is a much narrower claim than the one the PRD makes and should be argued on its
own terms rather than assumed.

Two rules were removed to get here, both for the same reason: `List-Unsubscribe`
proves a message is bulk and cannot say which kind, and `List-Id` names a bulk
sender rather than a mailing list. Each looked decisive and settled a large
fraction of mail at confidence 1. Each was wrong most of the time it fired.

The measurement that says how to get the efficiency back is already in hand: of
36 distinct `List-Id` values in the sample, **zero** were sometimes list traffic
and sometimes not. Per-value consistency is exactly what node 3 learns under, so
the 5% that `List-Id` covers is recoverable — earned after three sightings
rather than asserted on the first.

## What this changes

- **The auto-trash grant is not safe to arm.** It is wider than its category by
  40%, wrong on 30% of what it takes, and confident while wrong.
- **The efficiency claim needs re-arguing, not re-tuning.** Cold, it is 3%.
- **`spam-formulaire-contact` needs a signal the model does not have.** It is 9%
  of the mailbox and the cheap model resolves almost none of it. The form's own
  sender address is constant and would settle it as a static rule — the first
  cheap rule in this design that would be reading a fact rather than guessing at
  one.
