# Review: the seven-node cascade

Authored by `qwen3.8-27b` in Creator mode. 193 tests pass, build and lint are
clean, and the judge was not touched. This is what the green suite does not
say.

The point of writing it down: two of the four passing runs this project has
benchmarked shipped a protocol defect inside a full pass, and only a human read
found either. A review is not a formality here, it is the only step that has
ever caught that class of thing.

## What is good, and not by accident

- **No fixture coupling.** The corpus is named once, in a comment explaining
  where the rspamd junk threshold of 10 comes from. Nothing branches on a
  message id.
- **The orchestrator is the right shape.** Every node that runs is recorded,
  including the ones that decline; each is guarded by `if (settled === null)`
  so a settled message stops the cascade; node 6 is reached only when the six
  cheap nodes declined *and* a model was handed in.
- **Node 7 handles three cases, not two.** Below threshold degrades; nothing
  settled and no model degrades to the same honest non-answer; at or above the
  threshold the answer stands and node 7 leaves no step.
- **It reasoned about ordering.** Transactional markers are checked before the
  bulk signal, with a comment saying the two are disjoint.

## Findings

### 1. Brand spoofing is an allowlist, where the PRD asks for a comparison

PRD section 4.2, node 5: *SPF/DKIM/DMARC via headers, **similarité domain vs
display-name***.

What was built is a fixed list of seven brand names, matched as a substring of
the display name:

```ts
const SPOOFED_BRANDS: readonly string[] = ['paypal', 'amazon', 'apple', ...];
```

It catches the corpus case and passes the test. It detects impersonation of
brands somebody remembered to list, and nothing else — a spoof of a bank, a
supplier, or the owner's own employer walks through. The PRD's mechanism needs
no list: compare the display name against the sender's actual domain, and a
mismatch under a failed authentication is the signal.

**Severity: the node does not do what it is for.** It is the difference between
a rule and a rule engine.

### 2. Learned-pattern senders are matched by substring

```ts
const senderHit = pattern.sender !== null && sender.includes(pattern.sender.toLowerCase());
```

`types.ts` says *matched against the sender's full address*. A substring match
means a learned pattern for `veille@partenaire.example` also fires on
`x-veille@partenaire.example.attacker.test`.

The same file gets this right ten lines later, for VIPs:

```ts
if (context.vipSenders.some((vip) => vip.toLowerCase() === email))
```

So it is not a misunderstanding of the contract, it is an inconsistency within
one file — and the looser of the two is the one an attacker can aim at, since
learned patterns are accumulated from observed traffic.

**Severity: exploitable by anyone who can guess a trusted sender.**

### 3. A corporate domain settles every message as `standard`, at confidence 1

```ts
if (context.corporateDomains.some((d) => d.toLowerCase() === domain)) {
  return { category: 'standard', confidence: 1, rationale: '...' };
}
```

Confidence 1 means node 7 cannot degrade it, and settling at node 4 means the
model is never consulted. In production every message from a colleague is filed
as informational: an urgent internal request reads the same as a company
newsletter.

The PRD lists *domaines corporate* under node 4 without saying what they map
to. The reasoning given — "legitimate, not urgent by itself" — is defensible for
the *legitimacy* question and wrong for the *category* one: the two are not the
same judgement, and this collapses them.

**Severity: a design decision that should be made deliberately, not inherited
from an implementation.** It is the single largest behavioural consequence in
the file.

### 4. Corporate domain is checked before the transactional markers

A 2FA code or a receipt from a corporate domain settles as `standard`, never
reaching the transactional branch. PRD section 4.5 treats transactional
specially — never digested, kept in the inbox 24h, then archived — so the
misfile has downstream consequences.

Latent: the corpus's transactional senders are `bank.example` and
`shop.example`, neither corporate, so no test sees it.

### 5. `authenticationFailed` requires the value to be exactly `fail`

```ts
if (value !== undefined && value.toLowerCase() === 'fail') return true;
```

Real authentication headers carry qualifiers — `dmarc=fail (p=reject)`,
`spf=softfail`, `dkim=fail reason="..."`. An exact match sees none of them.

**This one is largely the corpus's fault, not the model's.** The fixture invents
`x-spam-dmarc: 'fail'`, and the implementation coded to what it was shown. Real
servers emit `Authentication-Results:` in RFC 8601 form. Blaming the model for
matching the contract it was given would be the same mistake this project has
made six times already: the harness was wrong, and the output reflected it.

**Action: the fixture needs realistic headers before this node can be judged.**

## What this says about the exercise

The three findings that are the model's own — the allowlist, the substring
match, the corporate collapse — share a shape: each is a *narrower* rule that
satisfies the visible case. None is a bug in the sense of crashing or returning
nonsense; all three pass every test, and would pass a stricter test suite aimed
at the same cases.

That is the limit of an executable criterion, stated precisely: it pins the
cases you thought of. Generalisation is still a human read, and on this evidence
it stays one.

## Recommended next round

Findings 1 to 4 are a correction brief. Finding 5 is a fixture task and belongs
to whoever owns the corpus, before Phase 3 meets real mail.
