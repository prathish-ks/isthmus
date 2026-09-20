import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// Coverage measurement config. Not used by `pnpm test` or CI's "Host tests"
// step — it exists so coverage can be measured on demand:
//
//   pnpm run test:coverage
//   (or directly: pnpm exec vitest run --config vitest.coverage.config.ts)
//
// Reports land in ./coverage (override with COVERAGE_DIR). `include` lists
// every host-side source tree so files no test ever imports still count as
// 0% — V8 coverage otherwise only reports files that were loaded, which
// overstates the number. Test files, fixtures and the vitest setup file are
// excluded from the denominator. `reportOnFailure` is set because a real
// pre-existing test failure should still produce a coverage report rather
// than silently skip one.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 30000,
      coverage: {
        enabled: true,
        provider: 'v8',
        // The baseline suite has known failures (see vitest.config.ci.ts);
        // without this the report is silently skipped whenever any test fails.
        reportOnFailure: true,
        reporter: ['text-summary', 'json-summary', 'json'],
        reportsDirectory: process.env.COVERAGE_DIR ?? 'coverage',
        include: ['src/**/*.ts', 'setup/**/*.ts', 'scripts/**/*.ts'],
        exclude: ['**/*.test.ts', '**/__fixtures__/**', '**/__snapshots__/**', 'src/test-setup.ts'],
      },
    },
  }),
);
