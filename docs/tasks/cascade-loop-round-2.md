# Task: correct four defects in the cascade

Your implementation of `src/cascade/cascade-loop.ts` passes 193 tests and was
reviewed. Four defects came out of that review. None of them makes a test fail
today — they are cases the suite did not think of — so four tests have been
added that do fail, at the end of `cascade-loop.spec.ts`.

The suite now stands at **4 failed, 195 passed**. Close that gap.

## What is wrong

### 1. Brand spoofing is an allowlist where the PRD asks for a comparison

PRD section 4.2 node 5 asks for *SPF/DKIM/DMARC via headers, **similarité domain
vs display-name***. `SPOOFED_BRANDS` is a fixed list of seven names, so the node
catches impersonations somebody remembered to list and nothing else. A regional
bank, a supplier, or the owner's own employer walks straight through.

Replace the list with the comparison the PRD names. A failed authentication
plus a display name that claims an identity the sender's domain does not
support is the signal; a display name consistent with its own domain is not an
impersonation however badly its authentication is configured.

### 2. Learned patterns match a substring of an address

```ts
const senderHit = pattern.sender !== null && sender.includes(pattern.sender.toLowerCase());
```

`types.ts` says *matched against the sender's full address*. As written, a
pattern for `veille@partenaire.example` also fires on
`x-veille@partenaire.example.attacker.test`.

Ten lines below, the VIP rule in the same function gets this right with an
equality. Learned patterns accumulate from observed traffic, so this is the one
an attacker can aim at.

### 3. A corporate domain settles every message as `standard`, at confidence 1

Confidence 1 means node 7 cannot degrade it; settling at node 4 means node 6
never runs. In production every message from a colleague is filed as
informational, and an urgent internal request reads like a company newsletter.

Legitimacy and category are two judgements. Being on a corporate domain answers
the first and says nothing about the second, so it must not settle a category on
its own — the message continues down the cascade.

### 4. The corporate check runs before the transactional markers

A consequence of 3, and it survives independently: a 2FA code or a receipt from
a corporate domain must still be `transactional`. PRD section 4.5 treats that
category specially — never digested, kept in the inbox 24h, then archived — so
misfiling it has consequences downstream.

## What not to do

- **Do not edit `cascade-loop.spec.ts`, `types.ts`, or `corpus.ts`.** If you
  believe a test is wrong, say so in your report and leave it failing.
- **Do not special-case the new messages.** Branching on `r1`…`r6`, on
  `attacker.test`, or on any literal from the tests is not a fix. Each defect
  above is a rule that is too narrow; the correction is a rule that is right,
  not a second narrow rule beside it.
- Do not add a dependency, and do not touch anything outside
  `src/cascade/cascade-loop.ts`.

## How you will know it worked

```bash
cd ~/work/phase2-qwen && pnpm run build && pnpm run lint && pnpm run test
```

All three pass, and `pnpm run test` reports **199 passed, zero failed**. Run it.
Do not report success without having run it.

## Do not boot the profile you are running in

You are running inside an ACP profile. Nothing here needs it started, and
`dsh --profile <name>` against it can block on the session already holding it.
