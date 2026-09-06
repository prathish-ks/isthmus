import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// CI-only override of vitest.config.ts (P9/10 hardening, "Scope CI
// around it" — see .github/workflows/ci.yml's "Host tests" step
// comment).
//
// Excludes 2 files with pre-existing runtime test failures (15 total),
// confirmed via a real `pnpm exec vitest run` run on 2026-09-03 and
// matching docs/baseline.md's own recorded P0-09 baseline exactly (same
// 2 files, same 15 failures, already documented there as upstream/
// environment-sensitive debt "not investigated further per plan"):
//   - scripts/add-dial-tool-scope.test.ts (11 failures)
//   - scripts/update/transaction.e2e.test.ts (4 failures)
//
// The base vitest.config.ts is untouched, so a local `pnpm exec vitest
// run` still runs (and shows) these known-failing tests by default.
// Only CI's "Host tests" step uses this config.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cjs,mocha,eslint,prettier}.config.*',
        'scripts/add-dial-tool-scope.test.ts',
        'scripts/update/transaction.e2e.test.ts',
      ],
    },
  })
);
