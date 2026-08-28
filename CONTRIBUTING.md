# Contributing

## Requirements

- Node 22 (`.nvmrc`)
- pnpm 10 (pinned in `packageManager`; `corepack enable` picks it up)

```bash
pnpm install
```

## Checks

Everything CI runs, you can run locally:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), imperative mood, first letter
uppercase:

```
feat(mail-core): Add JMAP queryChanges cursor persistence
```

Types in use: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`.

One subject per commit. If the subject needs the word "and", split it. Each dependency
upgrade gets its own commit. The body explains *why* only when the reason is real and not
obvious from the diff.

Branches are `feat/…`, `fix/…` or `chore/…`. `main` stays production-ready.

## TypeScript

`strict` is on and stays on. Fix the types rather than loosening the compiler. Named exports
only, `unknown` for external data and caught errors, string unions rather than `enum`.

### Two TypeScript versions, on purpose

The bundles compile with **TypeScript 7** (the native compiler). The linter runs against the
**TypeScript 6** API, because typescript-eslint throws on import under TS >= 7 and documents
running side by side until it ships support
([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).

That is why the ESLint config lives in its own workspace package, `tooling/lint`: a peer
dependency resolves from the importing package, so giving the linter its own package pins its
compiler to 6.x without touching the one `pnpm build` uses. pnpm `overrides` cannot express
this, since they do not apply to peers.

When typescript-eslint supports TS >= 7.1, collapse this: move `eslint.config.js` back to the
repository root, drop `tooling/lint`, and let the catalog supply the single compiler.

## Testing

Vitest, one config per package, specs colocated as `src/**/*.spec.ts`. Import `describe`,
`it` and `expect` explicitly rather than relying on globals.

## Secrets

Never commit credentials. The LLM bearer token lives in `dsh-secrets` on the host, and OIDC
tokens are encrypted at rest outside the repository. `.gitignore` already blocks `.env`,
`*.pem`, `*.key` and `tokens.enc`; that is a safety net, not a licence to keep secrets nearby.
