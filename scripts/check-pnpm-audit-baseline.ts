/**
 * scripts/check-pnpm-audit-baseline.ts — gate on NEW pnpm-audit findings,
 * not the ones already triaged.
 *
 * `pnpm audit --audit-level=high` fails on every run as long as any of the
 * 12 known, already-triaged devDependency advisories exist (see
 * .github/pnpm-audit-baseline.txt) — permanently red, which buries a
 * genuinely new advisory in noise nobody has a reason to read closely.
 * This instead diffs the current high/critical advisory set against that
 * checked-in baseline and fails ONLY on advisories not already accepted
 * there, so the pnpm-audit CI job is a real gate again.
 *
 * Usage: pnpm exec tsx scripts/check-pnpm-audit-baseline.ts
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASELINE_PATH = path.join(process.cwd(), '.github', 'pnpm-audit-baseline.txt');
const AUDIT_LEVEL = 'high'; // matches the threshold `pnpm audit --audit-level=high` used before this script existed

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

interface Advisory {
  github_advisory_id: string;
  severity: string;
  module_name: string;
  title: string;
  url: string;
}

function loadBaseline(): Set<string> {
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8');
  return new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

function runAudit(): { advisories: Record<string, Advisory> } {
  try {
    const out = execSync('pnpm audit --json', { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (err) {
    // pnpm audit exits non-zero whenever it finds anything at all — the
    // JSON report is still on stdout, so pull it from the thrown error.
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw err;
    return JSON.parse(out);
  }
}

const threshold = SEVERITY_RANK[AUDIT_LEVEL];
const baseline = loadBaseline();
const report = runAudit();
const advisories = Object.values(report.advisories ?? {});
const atLevel = advisories.filter((a) => (SEVERITY_RANK[a.severity] ?? 0) >= threshold);

// npm/pnpm's audit report lists one entry per dependency path, so the same
// advisory can appear more than once — dedupe by GHSA id before diffing.
const byId = new Map(atLevel.map((a) => [a.github_advisory_id, a]));
const newFindings = [...byId.values()].filter((a) => !baseline.has(a.github_advisory_id));
const resolved = [...baseline].filter((id) => !byId.has(id));

if (resolved.length > 0) {
  console.log(`Resolved (no longer present — safe to prune from the baseline): ${resolved.join(', ')}`);
}

if (newFindings.length > 0) {
  console.error(`\n${newFindings.length} new ${AUDIT_LEVEL}+ advisory(ies) not in the accepted baseline:\n`);
  for (const a of newFindings) {
    console.error(`  ${a.github_advisory_id}  ${a.module_name}  (${a.severity})`);
    console.error(`    ${a.title}`);
    console.error(`    ${a.url}\n`);
  }
  console.error(
    'If this is real: fix it (bump the package) or, if it is dev-tooling-only and genuinely\n' +
      'acceptable for now, add its GHSA id to .github/pnpm-audit-baseline.txt with a one-line reason.\n',
  );
  process.exit(1);
}

console.log(`pnpm audit: ${byId.size} known ${AUDIT_LEVEL}+ advisory(ies), all in the accepted baseline. OK.`);
