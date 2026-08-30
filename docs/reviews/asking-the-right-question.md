# The wording of the question was worth more than any signal in the message

Every measurement in this project so far has compared *signals*: recipient
position, thread state, list headers, sender history. This one holds the signal
fixed and varies the question, on the owner's forty annotated messages
(`docs/reviews/forty-dispositions.md`).

The task is the binary the queue actually asks: **does this message ask the
owner for something?** Nine of them do. The ten the owner had already answered
are removed first, by the exact `In-Reply-To` join rather than by any judgement,
so what is scored is twenty-nine messages and nine positives.

Accuracy is not reported anywhere below. A classifier that answers "no" to
everything scores 69% on this distribution and hands the owner an empty inbox.

## The result

| | recall | precision | queue |
|---|---|---|---|
| offer everything — what the agent did | 100% | 31% | 29 |
| addressed to the owner, not to a list | 67% | 55% | 11 |
| Mistral Small 3.2, prompt B | 44% | 67% | 6 |
| Qwen3 32B, prompt B | 78% | 47% | 15 |
| Claude Sonnet 5, prompt A | 78% | 50% | 14 |
| **Claude Sonnet 5, prompt B** | **78%** | **70%** | **10** |
| the model *or* the addressing | 78% | 58% | 12 |
| the model *and* the addressing | 67% | 67% | 9 |

Same model, same twenty-nine messages, same temperature. **Prompt B is worth
twenty points of precision at identical recall** — four fewer messages in the
queue, and not one of the nine lost.

Three unrelated configurations land on the same 78%, and they do not miss the
same two: Sonnet on prompt B drops the subcontracting question, Qwen drops a
laptop quote, Sonnet on prompt A drops a meeting invitation. Only one message
is missed by every one of them. So recall is not saturating on something
intrinsically unreadable — each configuration has its own blind spot, and what
the better prompt buys is a shorter queue rather than a more complete one.

## The two prompts

**A**, which is what the classifier's own prompt says today, reduced to a
binary:

> Answer YES if a human is waiting on the owner because of this message.

**B**, written from the owner's forty notes rather than from an idea of what
importance means:

> Answer YES only if it asks for something that the owner personally has to
> do: write a reply that has not been written, sign, validate, approve, renew,
> or answer a question put to them.
>
> Answer NO if it only keeps them informed. That includes: an exchange between
> other people that they are copied on, a status report, a delivery or platform
> notification about something already in motion, a meeting confirmation, and
> anything addressed to a team they belong to where a colleague is the one
> being asked.
>
> Most mail in this inbox is NO.

The difference is not tone. A is a question about the *sender's* state — is
somebody waiting — and on a working inbox the answer is nearly always yes,
which is the 60% over-assignment of `important` that the thirty labels found
three days ago. B is a question about the *owner's* obligation, and it carries
the four exceptions the owner actually named, in the owner's own terms.

The last line matters more than it looks. Without a stated base rate a model
reads each message alone and finds something plausible to do in most of them.

## Combining rules made it worse

The union of model and addressing keeps the same nine and adds two more wrong
ones. The intersection drops one right answer to gain nothing. Neither is worth
the extra machinery, and the honest reading is that the addressing signal has
nothing left to contribute once the question is put properly — it was a weak
proxy for the thing the prompt now asks directly.

## An open model can find them; it cannot keep the queue short

Mistral Small 3.2 finds four of nine. It is not offering noise — its precision
is 67% — it is silent about more than half of what is waiting, which for a
queue is the worse failure of the two.

Qwen3 32B finds **the same seven as Sonnet**, and offers five more that were
not waiting: 78% recall at 47% precision, a queue of fifteen. That is worth
saying plainly, because it is the first result in this project that makes the
sovereign target look reachable rather than aspirational. A queue of fifteen
containing seven is not as good as ten containing seven, and it is much better
than twenty-nine containing nine. The capability is there; the discipline is
not.

The first run of this scored Qwen at 0%, and that was the harness rather than
the model: an eight-token cap on a model that spends three hundred of them
thinking. It is the same mistake this project made once before, on the same
model family. The script now takes `--max-tokens` and reads the last `YES` or
`NO` anywhere in the answer instead of the first character, and an answer it
cannot read is offered to the owner rather than dropped.

## What it still misses, both models, both prompts

**"Votre abonnement Microsoft 365 a expiré"** — a renewal only the owner can
authorise, addressed to a billing alias. Missed by all three models, on both
prompts, without exception.

**"Sous-traitance marché open source"** — a partner asking a direct question,
delivered through a team alias. Missed by two of the three.

Both are the same shape: *sent to a list, and the owner is nevertheless the one
who must act.* No rule and no prompt has caught this case yet, and there is a
plain reason — nothing in either message says the owner is the one. It is a
fact about the company, and the two ways to learn it are for the owner to say
so, or for the agent to notice that they always end up handling that alias.

## End to end

Forty messages the agent said needed the owner, nine that did:

```
  40   what the queue offered
  −10  answered already          exact, In-Reply-To join
  − 1  sent by the owner         exact
  =29
  −19  judged to ask nothing     Sonnet 5, prompt B
  =10  offered, 7 of the 9 in it
```

Four times shorter, keeping seven of nine. The two it drops are the two above.
