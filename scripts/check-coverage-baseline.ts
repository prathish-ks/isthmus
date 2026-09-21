/**
 * scripts/check-coverage-baseline.ts — coverage floor gate: new coverage
 * must never regress below what's checked into .github/coverage-baseline.json.
 *
 * Same shape as scripts/check-pnpm-audit-baseline.ts: a plain
 * `pnpm run test:coverage` result would drift up and down forever with no
 * signal on a PR, so this pins a floor and fails only on a real regression
 * below it. Coverage rising above the baseline is fine and does not fail —
 * but the checked-in number stays exactly where it is until someone
 * deliberately raises it with --update, so a gain in one PR isn't silently
 * available as slack for a drop in a later, unrelated one.
 *
 * Compares all four vitest coverage metrics (statements/branches/functions/
 * lines) independently — a PR could raise line coverage while quietly
 * dropping branch coverage (e.g. new code with no failure-path test), and
 * that should still fail.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-coverage-baseline.ts           # gate (CI)
 *   pnpm exec tsx scripts/check-coverage-baseline.ts --update  # bump the
 *     checked-in baseline up to the just-measured numbers. Refuses if any
 *     metric would go DOWN — that's a regression hiding as an update, not
 *     a legitimate bump.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASELINE_PATH = path.join(process.cwd(), '.github', 'coverage-baseline.json');
const SUMMARY_PATH = path.join(process.cwd(), (process.env.COVERAGE_DIR ?? 'coverage') + '', 'coverage-summary.json');

export const METRICS = ['statements', 'branches', 'functions', 'lines'] as const;
export type Metric = (typeof METRICS)[number];
export type CoverageNumbers = Record<Metric, number>;

// Guards against failing (or "succeeding") on sub-hundredth-of-a-percent
// float noise between two otherwise-identical runs.
const EPSILON = 0.01;

export function loadBaseline(path_ = BASELINE_PATH): CoverageNumbers {
  return JSON.parse(fs.readFileSync(path_, 'utf-8'));
}

export function compare(current: CoverageNumbers, baseline: CoverageNumbers): { ok: boolean; regressions: string[] } {
  const regressions: string[] = [];
  for (const m of METRICS) {
    if (current[m] < baseline[m] - EPSILON) {
      regressions.push(`${m}: ${current[m].toFixed(2)}% < baseline ${baseline[m].toFixed(2)}%`);
    }
  }
  return { ok: regressions.length === 0, regressions };
}

function runCoverage(): CoverageNumbers {
  execSync('pnpm exec vitest run --config vitest.coverage.config.ts', { stdio: 'inherit' });
  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf-8'));
  const total = summary.total as Record<Metric, { pct: number }>;
  const current = {} as CoverageNumbers;
  for (const m of METRICS) current[m] = total[m].pct;
  return current;
}

function main(): void {
  const update = process.argv.includes('--update');
  const baseline = loadBaseline();
  const current = runCoverage();

  if (update) {
    const { regressions } = compare(current, baseline);
    if (regressions.length > 0) {
      console.error('Refusing to update: these metrics would go DOWN, which is a regression, not a bump:\n');
      for (const r of regressions) console.error(`  ${r}`);
      process.exit(1);
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log('Baseline updated (.github/coverage-baseline.json):');
    for (const m of METRICS) console.log(`  ${m}: ${baseline[m].toFixed(2)}% -> ${current[m].toFixed(2)}%`);
    return;
  }

  const { ok, regressions } = compare(current, baseline);
  if (!ok) {
    console.error('\nCoverage regressed below the checked-in baseline (.github/coverage-baseline.json):\n');
    for (const r of regressions) console.error(`  ${r}`);
    console.error(
      '\nAdd tests to bring coverage back up, or if this drop is deliberate and justified, run:\n' +
        '  pnpm exec tsx scripts/check-coverage-baseline.ts --update\n' +
        'and commit the updated .github/coverage-baseline.json with an explanation.\n',
    );
    process.exit(1);
  }

  console.log('Coverage at or above baseline:');
  for (const m of METRICS) console.log(`  ${m}: ${current[m].toFixed(2)}% (baseline ${baseline[m].toFixed(2)}%)`);
}

if (process.env.VITEST !== 'true') main();
