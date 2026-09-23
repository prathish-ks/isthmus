import globals from 'globals';
import tseslint from 'typescript-eslint';

// Code review finding: the root eslint.config.js's `ignores` excludes
// container/ entirely, so no-floating-promises/no-misused-promises/
// await-thenable — added after a "missing await" bug class was fixed at
// least 8 separate times in this project's git history on the host side —
// never applied here. This tree has its own tsconfig.json (Bun runtime,
// separate package tree per CLAUDE.md's "Container Runtime (Bun)" section),
// so it needs its own config rather than being folded into the root's.
//
// Deliberately scoped to just the type-aware promise-handling rules that
// motivated adding this file, not the full `recommended` rule set — pulling
// that in here would surface a large, separate body of pre-existing style
// findings unrelated to this fix. Run via `pnpm run lint:agent-runner` from
// the repo root (uses the root's installed eslint/typescript-eslint; no new
// devDependency added to this Bun-managed package tree).
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Not typeChecked: matches the root eslint.config.js's own pattern —
    // extend the non-type-checked recommended set, then enable only the
    // type-aware rules actually wanted (parserOptions.projectService above
    // supplies the type info those three need; it doesn't require also
    // pulling in recommendedTypeChecked's much broader rule set).
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Same settings as the root config: this tree uses the identical
      // `_`-prefix-for-intentionally-unused convention (visible throughout
      // its own source), which recommended's bare no-unused-vars doesn't
      // recognize on its own.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
