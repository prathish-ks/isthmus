import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { compare, loadBaseline, type CoverageNumbers } from './check-coverage-baseline.js';

const baseline: CoverageNumbers = { statements: 80, branches: 75, functions: 85, lines: 80 };

describe('compare', () => {
  it('passes when every metric is at or above the baseline', () => {
    const current: CoverageNumbers = { statements: 80, branches: 75, functions: 85, lines: 80 };
    expect(compare(current, baseline)).toEqual({ ok: true, regressions: [] });
  });

  it('passes when every metric is above the baseline', () => {
    const current: CoverageNumbers = { statements: 90, branches: 90, functions: 95, lines: 90 };
    expect(compare(current, baseline)).toEqual({ ok: true, regressions: [] });
  });

  it('fails when exactly one metric drops below the baseline', () => {
    // Lines and functions up, statements up, but branches quietly regressed —
    // the scenario the four-way check exists to catch (e.g. new code with no
    // failure-path test still raises overall line coverage).
    const current: CoverageNumbers = { statements: 85, branches: 70, functions: 90, lines: 85 };
    const result = compare(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.regressions).toEqual(['branches: 70.00% < baseline 75.00%']);
  });

  it('fails and reports every regressed metric, not just the first', () => {
    const current: CoverageNumbers = { statements: 70, branches: 70, functions: 85, lines: 79 };
    const result = compare(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.regressions).toEqual([
      'statements: 70.00% < baseline 80.00%',
      'branches: 70.00% < baseline 75.00%',
      'lines: 79.00% < baseline 80.00%',
    ]);
  });

  it('tolerates sub-hundredth-of-a-percent float noise without failing', () => {
    const current: CoverageNumbers = { statements: 79.995, branches: 75, functions: 85, lines: 80 };
    expect(compare(current, baseline).ok).toBe(true);
  });

  it('still catches a regression larger than the float-noise tolerance', () => {
    const current: CoverageNumbers = { statements: 79.9, branches: 75, functions: 85, lines: 80 };
    expect(compare(current, baseline).ok).toBe(false);
  });
});

describe('loadBaseline', () => {
  it('reads and parses the checked-in baseline file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cov-baseline-'));
    try {
      const p = path.join(dir, 'coverage-baseline.json');
      fs.writeFileSync(p, JSON.stringify(baseline));
      expect(loadBaseline(p)).toEqual(baseline);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file does not exist', () => {
    expect(() => loadBaseline('/nonexistent/coverage-baseline.json')).toThrow();
  });
});
