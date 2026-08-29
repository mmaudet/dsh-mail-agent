// This package exists so the linter resolves its own `typescript` peer.
//
// The bundles are compiled with TypeScript 7 (the native compiler), but
// typescript-eslint throws on import under TS >= 7 and documents running
// side by side against the TS 6 API until it ships support:
// https://github.com/typescript-eslint/typescript-eslint/issues/10940
//
// pnpm `overrides` cannot express this: they do not apply to peer
// dependencies, which resolve from the importing package. Giving the linter
// its own package is what pins its compiler to 6.x without touching the
// compiler used by `pnpm build`.

import path from 'node:path';

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['packages/*/vitest.config.ts', 'packages/*/vitest.integration.config.ts'],
        },
        tsconfigRootDir: repoRoot,
      },
    },
  },
);
