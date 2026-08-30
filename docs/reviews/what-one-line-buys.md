# The blind draft is not wrong, it is blank in exactly one place

The owner said it before this was measured: a foundation model given the
message body and one line of intent writes something nearly sendable, while the
agent's own drafts came back polished and useless. Ten of their real replies
now let that be checked, because the same message can be drafted twice and set
beside what they actually sent.

## Three conditions, same messages

| drafted from | content words shared with what they sent | length |
|---|---|---|
| the message alone | 34% | 21 words |
| the message and their retrospective note | 41% | 28 |
| **the message and a line that could have produced the reply** | **50%** | 26 |
| — what they actually wrote | — | 68 |

Eight pairs. Two of the ten were dropped and named: one where the owner's
"reply" was the single word *Bonsoir*, and one where the model declined to
write the draft at all — a judicial requisition asking for personal data about
a named individual, which it was right to refuse and which `draftReply` turns
into no draft rather than an empty one.

**The line beat the blind draft in seven of the eight.**

## What the blind drafts actually produce

The percentages are a crude proxy. This is the finding:

> Bonjour,
>
> **[à compléter avec lieu, horaire et personne à contacter pour mardi]**
>
> Cordialement, Michel-Marie

> Bonjour,
>
> **[Créneau à confirmer]** me convient, je me tourne vers Docaposte pour caler
> leur disponibilité.

> Pour le speaker du lightning talk, on vous confirme **[qui : Alexandre ou
> Michel-Marie]** très rapidement.

The drafting prompt's second rule forbids inventing a fact and asks for a
bracketed gap instead. It is working perfectly, and the result is a draft with
a hole exactly where the answer goes. Nothing is wrong in these drafts. They
are simply the parts of a reply that do not need a person.

Given the line, the same message produces:

> Le 8 septembre après-midi me convient. — **83% shared, and sendable as it is**

> Nous vous attendons effectivement le mardi 1er septembre au 37 rue Pierre
> Pauli. Vous pouvez prendre contact avec Valérie ou Christelle, nos assistantes
> respectives, afin qu'elles puissent vous accueillir.

**One line fills one bracket.** That is the whole mechanism, and it is why the
interface asks for a sentence rather than a form.

## Two things the measurement is not

**It is an upper bound, by construction.** The third condition's line is
derived from the reply it is scored against — a model reduces what they sent to
the sentence that would have produced it, in its own words. So 50% is what a
*perfect* line buys, not what a dictated one will. The value of an upper bound
is the other direction: had a perfect line changed nothing, no interface that
collects one could work.

**The overlap metric is weak and is only ever read as a difference.** It counts
shared content words over the smaller vocabulary, so a short draft against a
long reply can score well by saying few things that are all correct. It is
reported across three conditions on identical inputs and never as a score.

## The owner's notes are not instructions, and that showed

The first run of this used the forty annotations directly, and they are written
in the past tense about mail already dealt with — *"je l'ai réalisée"*, *"il
suffisait de lui confirmer"*. They still beat the blind draft, 41% against 34%,
because a description of what was said contains what was said. But two of them
described an intention the owner then abandoned: they set out to sign a mandate
and instead wrote to report that the platform was broken. A draft that follows
such a note is faithful and useless.

The interface collects the forward version, and that is the condition the third
row measures.

## And a measurement that measured nothing

The first run of all of this compared two conditions that had compiled to the
same prompt: the remote host was three commits behind, `renderDraftRequest`
there ignored the instruction field entirely, and the 2-point difference
between "with" and "without" was temperature noise. It looked exactly like a
result.

`scripts/lib/built.mjs` now refuses to run a measurement whose `dist` is older
than its `src`. A stale build does not fail — it answers, plausibly, about code
that is no longer there.

## What is still missing

An instruction can ask for something a draft cannot do. One derived line was
*"confirme le rendez-vous et ajoute Christelle en copie"*; the draft wrote *"je
mets Christelle Loiselet en copie"* in the body, which is a sentence about an
action nobody took. A draft writes a body. Adding a recipient, attaching a
file, and forwarding are outside what it can honour, and it should say so
rather than describe them.
