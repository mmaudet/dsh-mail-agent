# Field notes for the article

Raw material for « Ce que l'on peut réellement faire avec DeepSeek Harness »
(PRD §10). Not prose: surprises, frictions, and the moments where the harness
turned out to mean something other than what we assumed. Written as they
happen, because the useful details are the ones that stop being surprising
within a week.

Organised by the article section each note serves.

---

## §2 — What DSH changes

**The composition is genuinely inspectable.** `dsh --profile web
--dump-config` prints 144 plugin rows assembled from `dsh-base`, each grouped
under a comment naming the layer it came from and the patches that modified
it. This is not a diagram in a README; it is the actual tree, as one loadable
YAML document. Being able to see the composed system before booting it is the
first thing that feels different from a framework.

**A bundle announces itself, and the harness says when it has not.** Linking
our package into a profile produced this, unprompted:

> `@dsh-mail-agent/llm-openai` declares no `dsh.bundle` — installed as a plain
> dependency, not a profile layer (a later update that gains one activates it
> automatically)

One line of manifest turned a dependency into a layer of the composition. The
diagnostic named the exact missing field and what would happen once it was
present. That is the "everything is a plugin" claim being operationally true
rather than architecturally asserted.

**Adding the web application to a profile is one array entry.** Going from a
headless composition to one carrying the full browser UI was a single string in
`dsh.profile.bundles`. The claim that the UI is replaceable by configuration
survives contact.

---

## §4 — Driving DSH from Claude Code, honestly

This is the section where the frictions live, and they are more interesting
than the successes.

### The secondary sources were wrong in checkable ways

The PRD was written against blog posts and tutorial sites rather than the
repository. Four claims did not survive verification against DSH
`0.1.2-alpha.1`:

| Claim | Reality |
|---|---|
| `inspect-runtime` command | Does not exist anywhere in the repository |
| Creator mode is an on-disk `cordis` **profile** | It is an agent **preset in the web client**; shipped profiles are `web`, `headless`, `sdk`, `sdk-minimal`, `acp` |
| Secrets referenced as `dsh:secret:<name>` | The credential seam addresses secrets by **environment-variable name** |
| Latency 100-300 ms per call | Measured 1.7-2.8 s on the real gateway |

None of these broke the design. All of them would have produced confidently
wrong code if written from the document instead of from the runtime. The
lesson is narrow and practical: for a harness this young, the repository is the
only specification, and third-party tutorials describe a version that may never
have existed.

### npm lags the repository

`@deepseek-ai/dsh-base` on npm: `latest` is `0.0.1-rc.1`, `next` is
`0.1.1-rc.2`, while the repository ships `0.1.2-alpha.1`. Developing an
out-of-tree bundle means choosing which of three versions to type against.
Worth saying out loud in an article about adopting a young harness.

### The contracts are strict, and that is the good news

The LLM adapter seam does not merely suggest conventions; it states
obligations and explains each one. Three that changed the implementation:

- **`usage` before `finish`, nothing after `finish`.** The documentation
  anticipates providers that send a trailing usage-only chunk and tells you to
  buffer until end-of-stream. Our gateway does exactly that. The contract
  described the failure before we could hit it.
- **Route on `code`, never by parsing `message`.** `LlmError` carries no
  `status` field on purpose. We had encoded HTTP status as data and had to
  split it into distinct failure codes instead — which is better, because a
  5xx and a 4xx deserve different retry behaviour.
- **Tool-call arguments stay raw JSON strings end to end.** No parsing and
  re-serialising in the middle. Obvious once stated; easy to get wrong.

A seam that documents its own failure modes is rare enough to be the point of
a paragraph.

### What an AI pair cannot do

Two steps in this project are closed to a coding agent, and both are
instructive about where the human stays essential:

- **The OAuth browser step.** Authenticating at the identity provider requires
  a human in a browser. Everything either side of it can be automated — and
  was, into a `mail-auth` command — but the gap itself cannot be closed.
- **Creator mode.** It is a preset selected from a menu in the web UI. An
  agent driving DSH programmatically would have to go through the ACP profile
  instead, which is a different thing. The article's "clear split" between
  Claude Code and Creator mode turns out to be enforced by the tooling, not
  merely advisable.

### Mistakes worth publishing

An honest section on pairing with an AI needs the failures, not just the
output. From this session:

- **A commit landed with a red typecheck.** Lint and tests were run after
  writing a spec; typecheck was not. The gap between "tests pass" and "the
  project compiles" is real and easy to skip.
- **A comment claimed a credential was redacted when it was not.** The code
  said the bearer never appears in an error message; it did, because an
  upstream that echoes the request puts it in its own error body. A test
  caught it. The comment had been wrong from the moment it was written — the
  kind of thing that survives review indefinitely.
- **A truncated terminal output produced a confident wrong conclusion.** Four
  identities were reported and an anomaly diagnosed; there were thirteen, and
  the "missing" one was present twice. The fix was to ask the response for its
  own count rather than counting the printed lines.

The pattern in all three: the failure was not in reasoning but in verifying —
and each was caught by making the machine assert something rather than by
looking harder.

---

## §5 — Sovereignty by endpoint

**The constraint decided the model before preference could.** Interrogating
the gateway returned seven models. Probing all three chat models with a real
tool schema:

```
Mistral-Small-3.2-24B → tool call: {"category":"newsletter-tech","confidence":0.95}
Luciole-23B-Instruct  → HTTP 400: "auto" tool choice requires --enable-auto-tool-choice
lucie-7b-instruct     → HTTP 400: same
```

Exactly one model on the sovereign gateway can drive an agent loop. Not
because of the model, but because of a vLLM start-up flag. Sovereignty in
practice is this granular: a server option decides whether a model is an agent
model.

**`trusted_endpoints_only` is checked at construction, not per request.** A
typo in a base URL fails the profile at boot rather than quietly sending mail
content elsewhere. Worth showing as a config excerpt: it is the sovereignty
claim expressed as code that can fail.

**Latency reframes the cascade.** At 1.7-2.8 s per call rather than the
assumed 100-300 ms, the cascade's hit rate stops being an efficiency metric and
becomes the feature. Seven messages in eleven never reaching a model is not an
optimisation — it is why the thing is usable at all.

---

## §6 — Two adapters, one contract

**Where the protocols genuinely differ, the difference is exposed rather than
hidden.** `capabilities.customKeywords` is false on IMAP, so `setKeywords`
degrades into flags plus a folder move. A consumer asking for
`$twaky-newsletter-promo` gets the message filed under `Newsletters/Promo`
without learning which adapter answered.

**One case resisted abstraction, and the PRD contains the contradiction.**
§4.2 says a `needs-review` message stays in the inbox with no automatic
action; §3.2 lists `NeedsReview/` among the fallback folders. On a server
without custom keywords there is no way to mark a message in place, so the
folder *is* the mark. The two statements cannot both hold. This is a good
concrete example for the article: the abstraction is honest about where it
leaks instead of pretending the protocols are equivalent.

**Cursors are not portable, and the type system says so.** A JMAP state string
and an IMAP `(UIDVALIDITY, UID)` pair are a discriminated union; handing one to
the wrong adapter does not compile. A small thing that prevents a whole class
of resume bug.

---

## §9 — Honest limits

- **`offline_access` is not advertised by the identity provider** yet refresh
  tokens are issued. Discovery documents are advisory; behaviour is
  authoritative. Do not gate on `scopes_supported`.
- **Authorization codes live 30-60 seconds.** The manual bootstrap route is
  genuinely fiddly: the first attempt failed on expiry, with `invalid_grant`
  and no way to distinguish that from a real misconfiguration without checking
  every other cause first.
- **The signature is HTML-only.** The sending identity carries an HTML
  signature and no text one, while the draft contract currently produces a
  `text/plain` body. Reusing the owner's signature (PRD §4.4) needs either
  conversion or a multipart body. A gap in the contract, not in the
  implementation.
- **A shared `.env` is not shell-safe by default.** Writing a JSON value
  unquoted means `source ~/.dsh/.env` silently mangles it. Found the hard way.

---

## §3 — Creator mode, first session

First contact, 2026-08-28, ~23h30. Two findings, and the second is the article's
paragraph.

**The context ceiling was the blocker, and swapping the endpoint fixed it.**
The session ran a turn with 199k input tokens against `mistralai/mistral-small-2603`
where the sovereign gateway caps a whole request at 16 384. Nothing in the
harness had to change: a tier's endpoint is configuration.

**The agent asserted an absence it had no way to check.** Asked to list the
configured LLM providers, it answered that *"le service `llm` n'est pas exposé
dans cette session"*. That is false: `--dump-config` shows `id: llm` at line 10
of the host composition, and the session's own model selector read
`mail-llm-default` — the provider it claimed not to see was the one answering
the question.

What makes this worth publishing is not that a model was wrong. It is *how* the
error was caught: the operator had out-of-model context — a model selector in
the corner of the screen — that contradicted the model's own conclusion. No
amount of prompting would have surfaced that; the cross-check came from
outside the loop.

**Two diagnoses were proposed and both were wrong**, which is itself the
lesson. The first blamed a host-versus-preset layering and pointed at
`~/.dsh/.agent-presets/mail-agent-dev/cordis.yml`. That path does not exist,
and the provider is not preset-scoped: it arrives through the bundle's
`cordis.patch.yml` as an ordinary host layer. The second blamed synthesis of a
correct tool result. Reading the source settled it:

```ts
export type CordisInspectPlatform = 'host' | 'client'
```

There is no `preset` platform. The follow-up prompt asked the agent to query one
anyway, and it span for minutes looking for a value that is not in the
enumeration.

So the honest finding is narrower and more useful than either guess: the
introspection tool does not cover the surface an operator assumes it covers,
and the agent filled the gap with a confident negative instead of reporting
that it could not tell. A tool that cannot see something should say so; one
that lets the model infer absence from silence turns a blind spot into an
assertion.

**Cost note:** four turns, 17 steps, 564k input tokens. Cheap in euros at this
model's pricing, but the thrashing on an impossible parameter is what spent
most of it.

## Still missing for the article

Section 3 — "Le mode Creator comme atelier" — has **no material at all**. Every
line of this project so far was written as Claude Code. The article's thesis is
the split between the two, and half of it has not been exercised yet.

That is not a gap to paper over in the writing: it is the next thing to do.
Phase 2 (cascade, tools, prompts) is what §5.3 assigns to Creator mode, and it
is where the comparison becomes real.
