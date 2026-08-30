# Drafting, measured against replies the owner actually sent

Every measurement in this project has cost somebody something — the owner's
time labelling thirty messages, then a hundred and fifty, or a model's tokens
answering the same corpus twice. The Sent folder costs nothing and is a better
reference than either: for every message the owner replied to, the reply *is*
the answer.

## The style profile is right

Derived from 194 replies, and checkable against the folder in seconds:

| | |
|---|---|
| median reply | 59 words; a quarter are 26 or fewer |
| opens with | `Bonjour,` / `Hello,` / `Salut,`, often with a first name |
| signs off | `Michel-Marie` |
| languages | French, English, matching the message answered |

Against eight real replies, the drafts scored:

| | |
|---|---|
| signed `Michel-Marie` | **8/8** |
| opened in the owner's form | 8/8 |
| answered in the right language | 8/8 |
| left `[date]` rather than inventing one | 3/8 |

And one nobody asked for: the drafts use *tu* with a colleague and *vous* with
an external contact, correctly, inferred from the message.

## The substance is empty, and that is not a tuning problem

| | |
|---|---|
| median words, the owner | 67 |
| median words, the agent | **20** |

The eight drafts are one draft: *thank you, I will look at this and come back
to you*. An acknowledgement of receipt.

What the owner wrote instead:

- to a colleague, about a proposal — *"il faudrait un sous-chapitre… page 13 tu
  as encore un placeholder N° AFFAIRE… tu peux envoyer en me maintenant en
  copie"*
- to a partner, about a meeting — *"C'est noté pour 14h"*, plus who is now in
  the loop and who he has added
- to a colleague, about documents to sign — seven words: *"Voici les deux
  documents signés."*

That last one is the sharpest. He had already signed. The agent drafted *"Merci
pour les documents. Je les examine et vous donne une réponse [date]."* —
stylistically perfect and factually the opposite of what happened.

**The agent writes an acknowledgement where the owner gives an answer.**

## The thread does not close it, and makes it worse

The obvious explanation is that the prompt carries one message while a reply
answers a conversation. Measured, on the same pairs, with and without:

| | owner | no thread | with thread |
|---|---|---|---|
| median words | 52 | 35 | **36** |
| *"I'll get back to you"* | **0/6** | 4/6 | **6/6** |

No length change, and the phrasing got worse — every draft with the thread
promised to come back, where the owner never once does.

And the fact that ends the hypothesis: **only one of six messages had a thread
at all.** Most of what this owner replies to is the first message of its
conversation.

This is the third hypothesis in this project tested before being built and
refuted — after recipient position for the classifier, and thread state for
node 1. The pattern holds: the obvious explanation for a measured gap has been
wrong every time it was checked, and checking has cost twenty minutes where
building would have cost a day.

## What the gap actually is

A reply requires knowing something the mailbox does not contain. Whether 14h
suits him. Whether he has already signed. What he thinks of page 13.

No context available to the agent supplies that, because it exists only in the
owner's head. It is not a prompt problem, a model problem, or a retrieval
problem, and no amount of any of the three will move it.

## What follows

The style is right at 8/8 and the substance is impossible. So ship the half
that works, and be honest about the other:

```
Bonjour Benjamin,

[ta réponse sur la proposition]

Michel-Marie
```

A skeleton saves the greeting, the register — *tu* or *vous* — the language and
the sign-off, all of which the measurement validates, and does not pretend to
know what the owner thinks. A draft that says *I will look at this* is a message
they delete; a skeleton is a message they complete.

That is a change of design rather than a setting, so it is the owner's to make.

## Then the owner used it, and the queue found something else

Forty messages the agent had classified as needing the owner, still in the
inbox, presented one at a time with a microphone and a text field. The owner
dictated ten notes.

**Seven of the ten say there is nothing to reply.**

| what the classifier said | what the note said |
|---|---|
| `planification-reunion-rdv` | *"rien à faire, je suis en copie"* |
| `obligations-administratives-echeance` | *"c'est une action à prendre de mon côté, je vais faire l'opération"* |
| `obligations-administratives-echeance` | *"[GANDI] expiration du certificat"* — renew it, do not answer it |
| `correspondance-commerciale-client` | *"je suis en copie de l'échange entre Jean-Pierre et Olivier"* |

The `acts` band is catching two things that are not replies: threads the owner
is copied on, and **actions that are not messages**. Drafting a reply to a
certificate expiry is nonsense — the action is to renew.

### Three dispositions, in the owner's own words

The notes do not divide in two. They divide in three:

| | dictated |
|---|---|
| **reply** | *"lui répondre que je vais prendre connaissance des configurations"* |
| **do** | *"c'est une action à prendre de mon côté"* |
| **nothing** | *"je suis en copie"* |

That is the owner's taxonomy of what a message asks of them, arrived at the
same way the sixteen categories were: by reading what they actually said rather
than by specifying it first.

### And the fourth refuted hypothesis

Being addressed in `To` rather than copied looks like it should separate them.
It does not: 2 of 5 in `To` needed a reply, against 1 of 5 outside it. Ten
messages is far too few to conclude anything positive, and quite enough to stop
a rule being written.

This is the fourth obvious explanation this project has tested before building
— after recipient position for importance, thread state for node 1, and thread
context for drafting. None survived. The pattern is now strong enough to be
worth stating as a rule of its own: **on this mailbox, what a message asks of
its owner has not once been inferable from anything the message contains.**

### What the mechanism does do

Given the owner's own note, the draft is right:

> **note** — *"Oui, il a dû voir les posts sur LinkedIn, c'est très bien. Bonne soirée."*
>
> **draft** — *"Bonjour Alexandre, / Oui, il a dû voir les posts sur LinkedIn,
> c'est très bien. / Bonne soirée, / Michel-Marie"*

Seventeen words, their greeting, their sign-off, their register. The dictation
becomes the message.

So the division of labour is settled by measurement rather than by taste: **the
owner supplies what they decided, and the agent supplies everything else.** The
queue's question should be *what is this* with three answers, not *what do you
want to reply* — which also turns the two non-reply answers into signal nothing
currently captures, one correcting the classifier and one feeding a task list
the PRD does not yet have.
