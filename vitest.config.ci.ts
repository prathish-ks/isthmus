import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// CI-only override of vitest.config.ts.
//
// Historically (P9/10 hardening) this file excluded 2 test files —
// scripts/add-dial-tool-scope.test.ts and scripts/update/transaction.e2e.test.ts
// — carried over verbatim from upstream's own recorded baseline
// (docs/baseline.md's P0-09, 15 failures total, "not investigated further
// per plan"). Both were re-investigated during a coverage-uplift exercise
// (2026-09-20) and neither reproduces on this fork:
//
//   - scripts/update/transaction.e2e.test.ts: the 4 upstream failures were
//     a real bug, root-caused to `hasSafeStatePaths`/`loadState` comparing
//     `path.resolve()` paths without dereferencing symlinks — on macOS,
//     `os.tmpdir()` resolves through `/var` -> `/private/var`, so a state's
//     persisted (already-realpath'd) `projectRoot` never matched a caller's
//     raw path. Isthmus's `transaction.ts` already fixes this with a
//     symlink-aware `realResolve()` helper (introduced with the Go-kernel
//     work), applied consistently in both functions. Confirmed green
//     (7/7, including 3 tests this fork added beyond upstream's 4) across
//     repeated standalone runs.
//   - scripts/add-dial-tool-scope.test.ts: the 11 recorded failures were
//     "a subprocess exiting non-zero" on the original recording machine.
//     The suite shells out only to a fully self-contained fake `onecli`
//     script (a `jq`-driven shim on PATH) plus real `jq` — no live
//     network, Docker, or OneCLI dependency. Confirmed green (16/16)
//     across repeated standalone runs; `jq` is present on GitHub's
//     ubuntu-latest runners (this job's `runs-on`) and CI already uses it
//     unconditionally elsewhere (the upstream-watch job).
//
// Both exclusions are removed below. If either regresses, restore the
// specific exclusion with a fresh root-cause note — the reasoning above
// stops applying automatically as soon as `transaction.ts` or the fake
// onecli harness changes.
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
      ],
    },
  }),
);
