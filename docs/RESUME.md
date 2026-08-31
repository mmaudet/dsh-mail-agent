# Where this is, and how to pick it up

Written 31 August 2026, after a week of building and a day of measuring. Read
this before anything else; the reviews under `docs/reviews/` carry the evidence
for every number quoted here.

## What is running right now

**The agent loop**, on athena, polling the inbox every 180 seconds and writing
keywords. It is *not* under systemd — the unit exists at
`~/.config/systemd/user/dsh-mail-agent.service` and has never been enabled, so
the loop dies with the host.

```
ssh athena
pgrep -fa 'run-agent.mjs --write'          # is it alive
setsid nohup /tmp/start-agent.sh < /dev/null > /tmp/agent.log 2>&1 &   # restart
tail -f /tmp/agent.log
```

`/tmp/start-agent.sh` sources `~/.dsh/.env` and runs `scripts/run-agent.mjs
--write --every 180`. No `--base` and no `--accept-third-party`: the script
refuses anything but the sovereign gateway, and the endpoint comes from the
environment so there is one place to change it.

**The gateway** is `https://inference.linagora.com/v1/`, certificate valid to
4 November 2026. It replaced `chat.lucie.ovh.linagora.com`, whose certificate
expired on 30 August — three days during which every measurement went to
OpenRouter and carried a banner saying so. The old address is still named in
the PRD on purpose; see amendment 11.

## The answer keys — the irreplaceable part

Hours of the owner's own judgement. Copied out of `/tmp` into
`~/.dsh/keys/` on athena and `~/dsh-mail-agent-keys/` on the MacBook. **They
are not in this repository and must not be**: it is public, and they are the
owner's mail.

| file | what it is |
|---|---|
| `labels-150.json` + `label-ids-150.json` | 150 messages, one of sixteen categories each, labelled blind |
| `dispositions.json` / `intents.json` | 40 queued messages, one note each on what it asked of them |
| `triage.json` | 13 messages with the one-line instruction dictated for each |
| `reformulations.json` | one draft the owner rewrote, with both versions |
| `asked.json` | what each of the 13 messages asks, extracted |
| `drafts-backup.json` | the drafts as they stood before the last replacement |
| `calibration-souverain.json` | the classifier scored against the 150 |

Regenerating any of these means asking for their time again. Copy them
somewhere durable before touching `/tmp`.

## Waiting on the owner

1. **Rotate the OpenRouter key.** It was pasted in plaintext on 30 August and
   is now unused, which is the best reason to revoke rather than renew it.
2. **The legal disclaimer**, 520 characters of English on every draft, taken
   from their identity signature. Currently kept whole. One flag trims it to
   the coordinates block.
3. **Sovereign or not, for drafting.** Sonnet covers 6 of 19 asks against
   Mistral's 2, and 44 words against 38, at the price of leaving the perimeter.
   The sovereign drafts are the ones deposited.
4. **Whether to wire the binary judgement into the loop.** It scores 78% recall
   and 70% precision against 70% and 45% for deriving the same answer from the
   sixteen categories, and costs one model call per message on top of
   classification. Built, tested, deliberately not wired: it is a decision
   about budget.

## What to do next, by what it is worth

**Enable systemd.** An hour, and the loop survives a reboot. Everything else
here assumes it is running.

**A `/runs/[id]` view.** Metric 7 asks for it and the traces are already in
SQLite; nothing renders them.

**Push instead of polling.** Metric 3 (VIP under 15 seconds) cannot be measured
at all while the loop polls every 180 seconds. `JmapPushChannel` exists in the
adapter and nothing calls it.

**Nothing more on the classifier prompt.** Two interventions were measured and
neither moved it — see below. The next thing that would is more of the owner's
own judgement, not more wording.

## What has been measured, so it is not re-derived

Six generic rules about this mailbox have been tested and refuted. Each cost
twenty minutes to check and would have cost a day to build.

| hypothesis | result |
|---|---|
| recipient position predicts importance | inverted |
| thread state settles cascade node 1 | 7% of the inbox |
| thread context improves a draft | made it worse — but on six pairs, one with a thread |
| intent can be enumerated in advance | 3 of 8 |
| addressing predicts what a message wants | 67% / 71%, not usable as a filter |
| the owner greets by name people they know | 40% for those, 63% for strangers |

What has never failed is a fact the owner stated: a route, a note, an
instruction, a rewritten draft.

**The classifier**, against the 150: 53% exact category, 69% right band. Two
things were tried against it on a held-out half and neither worked — rewording
the prompt (54%→51% exact, 66%→69% band, inside the noise) and sender memory
(6 of 64 errors sit on a sender the owner labels consistently; 101 distinct
senders for 150 messages).

**Drafting**: length tracks the instruction at about one word for one word. A
one-line instruction carrying three facts produces three facts, and anything
more is invention. The only honest route to a fuller reply is a fuller
sentence, which is why the triage page now lists what each message asks
*before* the owner dictates.

**The critique loop** the owner asked for: 16 revisions across 13 drafts, +4
words, 5 still faulted after three rounds. The critic was right every time and
could not fix anything, because the missing answers were never in the
instruction. It was turned around into `whatIsAsked`, which puts the same
question to the person who can answer it.

## The pages

Session-local watches are gone; re-watch if needed.

- **Tri du matin** — `36b0dde8-a519-4d32-988e-54e93c41084b`. 21 never-triaged
  messages, three buttons, dictation on "répondre", and the list of what each
  message asks.
- **Treize brouillons** — `8a2076e0-8eda-4226-b309-cddfcbb18eda`. The review
  page, one card per draft, with the message being answered underneath.
- **Cent cinquante jugements** — `aa1098f6-90f8-4171-8ef8-37dfe4883943`. The
  labelling page, complete. Its `localStorage` key is
  `dsh-mail-labels-150-v16`; changing it loses everything not yet published.

## Traps this project has already fallen into

- **A shim that quietly differs from the contract.** Twenty-four scripts
  hardcoded the JMAP capability list and threw away what the adapter asked for,
  which silently dropped the `From` on every deposited draft.
- **A test that asserts everything except the thing that breaks.** `createDraft`
  was covered for mailbox, keywords and threading, and not for the body — which
  arrived empty for a week.
- **Measuring against a stale build.** `scripts/lib/built.mjs` now refuses.
- **A guard that reports what it has not observed.** The loop monitor called a
  healthy agent dead when the network dropped, then called it stalled when the
  log was rotated. Liveness now reads the file's mtime.
- **Writing to the mailbox through a shell-interpolated string.** A `$` was
  eaten and a keyword was corrupted on a real message. Always via a file.
- **Publishing a page that parses but does not run.** The builders now load
  every page into a DOM shim and refuse to write if it throws or renders
  nothing.
