# A source is not always a category

> **Scale correction.** Sampled the 256 most recent messages; see
> `paging-correction.md`. The recurrence ceiling re-measured at 70% over 3000
> messages against the 64% stated here, so the proportion held.


Three measurements chased the same question — why does node 3 settle 10% when
the mailbox looks far more repetitive than that. The first blamed the window,
the second the granularity. Both were wrong.

## What the diagnostic said

Of seven frequent sources yielding no learned pattern, **six failed on
disagreement, not on volume**. One support address came back under four
categories across seven messages.

So the constraint is the classifier: a cascade cannot cache an answer that is
not stable enough to cache.

## What sharpening the prompt bought

The prompt listed eight categories and never said where one ends. It now carries
an ordered test and two rules aimed at the cases the model actually disagreed
about. Measured per source, 200 messages, 15 recurring sources:

| | before | after |
|---|---|---|
| `support@npmjs.com` | split | **unanimous** (8×) |
| `cpiechurski@nvidia.com` | important / newsletter-promo | **unanimous** (3×) |
| `newsletter@linformaticien.com` | split | **unanimous** (3×) |
| `support@services.ovhcloud.com` | **four** categories | two |

Real, and not enough on its own.

## The finding underneath

**8 of 15 sources are unanimous, covering 19% of the mailbox — against a 64%
ceiling that counted sources rather than sources with a stable category.**

Sorted by what the source *is*, the pattern is unmistakable:

| Kind of source | Unanimous? |
|---|---|
| `support@npmjs.com`, `users@notifications.pennylane.com`, `twake-on-matrix` | yes |
| `newsletter@linformaticien.com`, a Mailjet list | yes |
| `vente@linagora.com` (a list) | yes |
| `license-review` (a list) | no — important×17, newsletter-tech×9, standard×5 |
| `nple@linagora.com` (a colleague, 36 messages) | no — **five** categories |
| `vsteffen@linagora.com`, `customer-service@ovh.com` | no |

**Node 3's premise holds for machines and fails for people.** A service emits
one kind of message; a colleague does not. `nple@linagora.com` is 18% of this
inbox on its own and is genuinely not one category — no prompt will make it one,
because the messages differ.

Unanimity already selects for this correctly: the sources it learns are the
automated ones, and the ones it refuses are the ones a human writes. That was
not designed, and it is the right behaviour.

### One number that needs reading carefully

The probe calls the classifier directly, not the cascade. `nple@linagora.com`
came back `spam-certain` three times — and the cascade would never publish that,
because a corporate sender's bulk categories degrade to `needs-review` at node 6.
The raw model is worse than the system that contains it, which is the point of
containing it.

## The other mailbox, and what it corrects

The work mailbox is colleagues and internal lists. A personal one is services,
shops and newsletters — so if the cascade is built for automated senders it
should do markedly better there. Measured on the Gmail account, same probes:

| | work (JMAP) | personal (Gmail) |
|---|---|---|
| window | 256 msgs / 4 days | 129 msgs / 18 days |
| sources seen 3+ times | 64% of messages | 50% |
| **unanimous sources** | **8 of 15** | **3 of 5** |
| **messages they cover** | **19%** | **18%** |

**No advantage.** The ratio is the same to within the noise of a small sample,
and the reason corrects the framing above.

`noreply-marketplace.partner@decathlon.com` is as automated as a sender gets,
and it splits `transactional×3 important×2` — because a marketplace sends order
confirmations *and* other things. `www.substack.com` splits between promo and
notification for the same reason.

So it is not people against machines. **It is that a source with several
purposes has several categories, and most sources have several purposes.** A
single newsletter is one category; a platform is not, and a colleague is not.

The earlier reading — "node 3's premise holds for machines and fails for
people" — was the right observation from one mailbox and the wrong
generalisation. What holds is narrower: a source is learnable when it does one
thing.

## What this settles about the architecture

The cascade's cost argument is weaker than PRD section 4.2 assumes, and the
same on both mailboxes measured. On the work account:

- static rules settle ~9%
- learned patterns could reach ~19% once they accumulate
- the prefilter, ~1%
- **the rest — around 70% — needs the model, and will keep needing it**

Not a defect to fix. A property of a real inbox, where most mail is written by
people and people are not categories. Worth stating in those terms rather than
projecting a number from a corpus that had one case per node.

## What would move it, and what would not

**Would not:** more prompt tuning. The remaining disagreement is on sources that
are genuinely heterogeneous, and the last round already took the reachable
ground.

**Would:** thread continuity, node 1, which is the only node that can settle a
message from a person cheaply — a reply in a thread the owner has already acted
in inherits its category, at zero cost and with no guess about who the sender
is in general. It is unimplemented for lack of a thread history, and on a
mailbox that is 70% human mail it is the node with the most left to give.
