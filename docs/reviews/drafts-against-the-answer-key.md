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
