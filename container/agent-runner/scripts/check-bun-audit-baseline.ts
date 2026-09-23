/**
 * container/agent-runner/scripts/check-bun-audit-baseline.ts — gate on NEW
 * bun-audit findings for this tree, not ones already triaged.
 *
 * Mirrors scripts/check-pnpm-audit-baseline.ts's exact approach (see that
 * file's own header) for the same reason: a plain `bun audit` fails on
 * every run as long as any known, already-triaged advisory exists —
 * permanently red, burying a genuinely new one in noise. This diffs the
 * current advisory set against the checked-in baseline and fails ONLY on
 * advisories not already accepted there.
 *
 * container/agent-runner/ is a separate Bun-managed package tree, not a
 * pnpm-workspace.yaml member (see CLAUDE.md's "Container Runtime (Bun)"
 * section) — it was never covered by the pnpm-audit job above; this is
 * that job's counterpart for this tree. See docs/agent-runner-audit-findings.md
 * for how that gap was found and first closed.
 *
 * Usage (from container/agent-runner/): bun run scripts/check-bun-audit-baseline.ts
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Baseline lives at repo root alongside .github/pnpm-audit-baseline.txt,
// not inside this package tree — one place to look for either, even
// though the two audit tools run from different working directories.
const BASELINE_PATH = path.resolve(process.cwd(), '..', '..', '.github', 'bun-audit-baseline.txt');
const AUDIT_LEVEL = 'high'; // matches pnpm-audit's own threshold

const SEVERITY_RANK: Record<string, number> = { low: 1, moderate: 2, high: 3, critical: 4 };

interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: string;
}

function ghsaId(a: Advisory): string {
  // bun audit's JSON has no dedicated advisory-id field the way pnpm's
  // does (github_advisory_id) — the GHSA id is only present embedded in
  // the advisories/<id> URL. Extract it so the baseline file can key on
  // the same portable, human-checkable GHSA-xxxx-xxxx-xxxx form pnpm's
  // baseline already uses, rather than bun's own internal numeric id
  // (which is not guaranteed stable across bun/registry versions).
  //
  // Falls back to that numeric id (never throws) if the url is ever in
  // some future shape this regex doesn't expect — one oddly-shaped
  // advisory failing to parse should degrade that single entry, not take
  // down the whole gate and hide every other, possibly-real finding
  // alongside it.
  const match = a.url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  if (match) return match[0];
  console.error(`Warning: could not extract a GHSA id from advisory url, falling back to bun's own id: ${a.url}`);
  return `bun-id-${a.id}`;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_PATH)) return new Set();
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8');
  return new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

function runAudit(): Record<string, Advisory[]> {
  // A genuinely clean result is `{}` on stdout (verified directly), never
  // empty/whitespace-only output — so this deliberately does NOT special-
  // case empty stdout as "no findings." Truly empty output means something
  // went wrong upstream of JSON.parse ever running, and JSON.parse('')
  // throwing is exactly the loud failure that should produce, not a
  // silent "0 advisories, OK" that would make a broken audit look clean.
  try {
    const out = execSync('bun audit --json', { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (err) {
    // bun audit exits non-zero whenever it finds anything at all — same
    // as pnpm audit — but (verified directly, unlike pnpm) still writes
    // its JSON report to stdout even on a non-zero exit, so pull it from
    // the thrown error's own captured stdout. If that stdout is itself
    // empty or unparseable, let JSON.parse's own error propagate rather
    // than swallowing it — see this function's own note above.
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw err;
    return JSON.parse(out);
  }
}

const threshold = SEVERITY_RANK[AUDIT_LEVEL];
const baseline = loadBaseline();
const report = runAudit();

const byId = new Map<string, Advisory & { module: string; ghsaId: string }>();
for (const [moduleName, advisories] of Object.entries(report)) {
  for (const a of advisories) {
    if ((SEVERITY_RANK[a.severity] ?? 0) < threshold) continue;
    const id = ghsaId(a);
    // Same package can carry multiple advisories (as ip-address did) —
    // key by GHSA id, not module name, so each is tracked independently.
    byId.set(id, { ...a, module: moduleName, ghsaId: id });
  }
}

const newFindings = [...byId.values()].filter((a) => !baseline.has(a.ghsaId));
const resolved = [...baseline].filter((id) => !byId.has(id));

if (resolved.length > 0) {
  console.log(`Resolved (no longer present — safe to prune from the baseline): ${resolved.join(', ')}`);
}

if (newFindings.length > 0) {
  console.error(`\n${newFindings.length} new ${AUDIT_LEVEL}+ advisory(ies) not in the accepted baseline:\n`);
  for (const a of newFindings) {
    console.error(`  ${a.ghsaId}  ${a.module}  (${a.severity})`);
    console.error(`    ${a.title}`);
    console.error(`    ${a.url}\n`);
  }
  console.error(
    'If this is real: fix it (bun audit fix, or an explicit `overrides` entry — see\n' +
      'docs/agent-runner-audit-findings.md for a worked example). If it is genuinely\n' +
      'acceptable for now, add its GHSA id to .github/bun-audit-baseline.txt with a\n' +
      'one-line reason.\n',
  );
  process.exit(1);
}

console.log(`bun audit: ${byId.size} known ${AUDIT_LEVEL}+ advisory(ies), all in the accepted baseline. OK.`);
