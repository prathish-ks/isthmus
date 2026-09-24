/**
 * scripts/check-wiring-registry.ts — the standing, automated form of the
 * 2026-09-24 wiring/seam and boundary audits (docs/traceability.md,
 * go-host/docs/ADR-028-wiring-boundary-registry.md).
 *
 * Those audits found two recurring failure shapes, both already shipped as
 * real bugs once (ADR-024) and found again twice more the same day
 * (buildAgentGroupImage, the credential-injection boundary) before anyone
 * built a check that runs on every PR instead of waiting for the next
 * manual audit:
 *
 *   1. WIRING: a real, privileged, guard-gated function with no remaining
 *      production caller (dockerNetworkArgs before ADR-024) — or with a
 *      caller, but every test mocks it away, so a caller that silently
 *      breaks passes every check (ADR-022's "everything cuts at the same
 *      seam" finding, before its fix).
 *   2. BOUNDARY: a security claim ("credentials never land in a container
 *      env") that's real code, unit-tested, but never checked against
 *      anything real — a live daemon, a real container.
 *
 * This script re-checks docs/wiring-registry.json's entries mechanically:
 *
 *   - `wiring[]`: the named function has at least one real (non-test)
 *     caller, AND its declared seam-test file does not stub that specific
 *     function out via `vi.mock`.
 *   - `goKernelCapabilities[]` / `boundaries[]`: the declared live-Docker
 *     test file exists and looks like an actual test file. A script can't
 *     verify a live security property by static analysis — the entries
 *     below just confirm the promised proof still exists and hasn't been
 *     silently deleted or renamed; the "does the daemon inspect actually
 *     pass" question stays where it belongs, in the report-only
 *     go-ec05-live-docker CI job.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-wiring-registry.ts
 *
 * Deliberately narrow scope (LAW-05): only container-runner.ts's privileged
 * functions and the Go kernel's capability table — the exact bounded
 * surface LAW-07 already names — not a general "audit every function in
 * the repo" tool.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();

export interface WiringEntry {
  function: string;
  definedIn: string;
  seamTest: string;
  note?: string;
}

interface GoCapabilityEntry {
  capability: string;
  definedIn: string;
  liveDockerTest: string;
  note?: string;
}

interface BoundaryEntry {
  claim: string;
  verifiedBy: string;
  note?: string;
}

interface Registry {
  wiring: WiringEntry[];
  goKernelCapabilities: GoCapabilityEntry[];
  boundaries: BoundaryEntry[];
}

export function loadRegistry(root: string = ROOT): Registry {
  const raw = fs.readFileSync(path.join(root, 'docs', 'wiring-registry.json'), 'utf-8');
  return JSON.parse(raw) as Registry;
}

function exists(root: string, p: string): boolean {
  return fs.existsSync(path.join(root, p));
}

/** Every .ts source file under <root>/src, excluding *.test.ts. */
function productionTsFiles(root: string): string[] {
  const out: string[] = [];
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) return out;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

/**
 * Does `fnName` have at least one real call site outside its own defining
 * file? A crude `fnName(` grep — the same technique that would have caught
 * dockerNetworkArgs before ADR-024, deliberately kept simple rather than a
 * full TS AST walk, since a false negative here (a real caller the regex
 * misses) is far more likely than a false positive at this call-site
 * density.
 */
export function hasRealCaller(
  fnName: string,
  definedIn: string,
  root: string = ROOT,
): { ok: boolean; callers: string[] } {
  const definedInAbs = path.join(root, definedIn);
  const pattern = new RegExp(`\\b${fnName}\\s*\\(`);
  const callers: string[] = [];
  for (const file of productionTsFiles(root)) {
    if (file === definedInAbs) continue;
    const content = fs.readFileSync(file, 'utf-8');
    // Skip a bare import line, or a commented-out one, naming the function
    // — neither is a real call. (Deliberately simple: a line-level check,
    // not a full comment-stripping parse — a block-commented call site
    // would still count as a "caller" here, which only makes this check
    // more conservative, never less.)
    const callLines = content
      .split('\n')
      .filter((line) => pattern.test(line) && !/^\s*import\b/.test(line) && !line.trim().startsWith('//'));
    if (callLines.length > 0) callers.push(path.relative(root, file));
  }
  return { ok: callers.length > 0, callers };
}

/**
 * Does the seam-test file stub `fnName` out via `vi.mock`? Looks for a
 * `vi.mock(` block that (a) targets a path whose basename matches
 * `definedIn`'s basename, and (b) lists `fnName: vi.fn()`-shaped text
 * inside that block — the exact shape `apply.test.ts`'s original
 * `buildAgentGroupImage: vi.fn()` had before this file's own fix. A
 * `vi.mock` of the same module that does NOT stub this specific export
 * (e.g. mocking `killContainer`/`wakeContainer` while leaving
 * `buildAgentGroupImage` real via `vi.importActual`) is fine and common —
 * only stubbing THIS function collapses the seam.
 */
export function seamTestStubsFunction(
  seamTest: string,
  fnName: string,
  definedIn: string,
  root: string = ROOT,
): boolean {
  const content = fs.readFileSync(path.join(root, seamTest), 'utf-8');
  const moduleBasename = path.basename(definedIn, '.ts');
  const mockBlocks = content.match(/vi\.mock\([^)]*\)[\s\S]*?(?=\nvi\.mock\(|\nimport |\n\/\/ [A-Z]|$)/g) ?? [];
  for (const block of mockBlocks) {
    const targetsModule = block.includes(`${moduleBasename}.js`);
    const stubsFunction = new RegExp(`\\b${fnName}\\s*:\\s*vi\\.fn\\(`).test(block);
    if (targetsModule && stubsFunction) return true;
  }
  return false;
}

/**
 * A sanity check that the promised proof file still looks like a proof,
 * not a static-analysis attempt to verify what it proves. Three shapes
 * exist in this codebase: a Go live-Docker test file (`func Test...`), a
 * vitest test file (`it(`/`describe(`/`test(`), and an EC-0N live-smoke
 * script (`scripts/ec0N-*.ts` — no test framework, just a script that
 * shells `docker` directly; see any existing ec0*-live-smoke.ts header).
 */
export function looksLikeTestFile(p: string, root: string = ROOT): boolean {
  const content = fs.readFileSync(path.join(root, p), 'utf-8');
  if (p.endsWith('.go')) return /func Test\w+\(/.test(content);
  if (/^scripts\/ec\d+-.*\.ts$/.test(p)) return /docker/i.test(content) && content.length > 500;
  return /\bit\(|\bdescribe\(|\btest\(/.test(content);
}

/** The core check, extracted from main() so tests can call it directly against a fixture root. */
export function checkRegistry(registry: Registry, root: string = ROOT): string[] {
  const failures: string[] = [];

  for (const entry of registry.wiring) {
    if (!exists(root, entry.definedIn)) {
      failures.push(`wiring["${entry.function}"]: definedIn file "${entry.definedIn}" does not exist.`);
      continue;
    }
    if (!exists(root, entry.seamTest)) {
      failures.push(`wiring["${entry.function}"]: seamTest file "${entry.seamTest}" does not exist.`);
      continue;
    }
    const caller = hasRealCaller(entry.function, entry.definedIn, root);
    if (!caller.ok) {
      failures.push(
        `wiring["${entry.function}"]: no real (non-test) caller found outside ${entry.definedIn} — ` +
          `this is the exact ADR-024 shape (a privileged function with no remaining caller). ` +
          `If this function was intentionally retired, remove its entry from docs/wiring-registry.json ` +
          `in the same PR that removes the function.`,
      );
    }
    if (seamTestStubsFunction(entry.seamTest, entry.function, entry.definedIn, root)) {
      failures.push(
        `wiring["${entry.function}"]: its declared seam test "${entry.seamTest}" now mocks ` +
          `${entry.function} out via vi.mock — the seam has collapsed back to the pre-fix shape ` +
          `ADR-022 found. Either restore a real (non-mocked) call, or point seamTest at a test ` +
          `file that genuinely exercises it.`,
      );
    }
  }

  for (const entry of registry.goKernelCapabilities) {
    if (!exists(root, entry.definedIn)) {
      failures.push(`goKernelCapabilities["${entry.capability}"]: definedIn file "${entry.definedIn}" does not exist.`);
      continue;
    }
    if (!exists(root, entry.liveDockerTest)) {
      failures.push(
        `goKernelCapabilities["${entry.capability}"]: liveDockerTest file "${entry.liveDockerTest}" does not exist.`,
      );
      continue;
    }
    if (!looksLikeTestFile(entry.liveDockerTest, root)) {
      failures.push(
        `goKernelCapabilities["${entry.capability}"]: "${entry.liveDockerTest}" no longer looks like a test file.`,
      );
    }
  }

  for (const entry of registry.boundaries) {
    if (!exists(root, entry.verifiedBy)) {
      failures.push(`boundaries["${entry.claim}"]: verifiedBy file "${entry.verifiedBy}" does not exist.`);
      continue;
    }
    if (!looksLikeTestFile(entry.verifiedBy, root)) {
      failures.push(`boundaries["${entry.claim}"]: "${entry.verifiedBy}" no longer looks like a test file.`);
    }
  }

  return failures;
}

function main(): void {
  const registry = loadRegistry();
  const failures = checkRegistry(registry);

  if (failures.length > 0) {
    console.error(`wiring-registry-check: ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} failed.\n`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nSee docs/wiring-registry.json and go-host/docs/ADR-028-wiring-boundary-registry.md.');
    process.exit(1);
  }

  const total = registry.wiring.length + registry.goKernelCapabilities.length + registry.boundaries.length;
  console.log(`wiring-registry-check: ${total} entries OK.`);
}

if (process.env.VITEST !== 'true') main();
