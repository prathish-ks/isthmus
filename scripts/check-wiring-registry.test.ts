import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkRegistry,
  hasRealCaller,
  looksLikeTestFile,
  seamTestStubsFunction,
  type GoCapabilityEntry,
  type WiringEntry,
} from './check-wiring-registry.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-registry-fixture-'));
  fs.mkdirSync(path.join(root, 'src', 'modules'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('hasRealCaller', () => {
  it('finds a real call site outside the defining file', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/apply.ts', "import { buildAgentGroupImage } from '../container-runner.js';\nbuildAgentGroupImage();\n");

    const result = hasRealCaller('buildAgentGroupImage', 'src/container-runner.ts', root);
    expect(result.ok).toBe(true);
    expect(result.callers).toEqual(['src/modules/apply.ts']);
  });

  it('is the ADR-024 case: no caller anywhere means orphaned', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/unrelated.ts', 'export function other() {}\n');

    expect(hasRealCaller('buildAgentGroupImage', 'src/container-runner.ts', root).ok).toBe(false);
  });

  it('does not count a bare import line as a call', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/apply.ts', "import { buildAgentGroupImage } from '../container-runner.js';\n");

    expect(hasRealCaller('buildAgentGroupImage', 'src/container-runner.ts', root).ok).toBe(false);
  });

  it('does not count a commented-out call site', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/apply.ts', '// await buildAgentGroupImage(id);\n');

    expect(hasRealCaller('buildAgentGroupImage', 'src/container-runner.ts', root).ok).toBe(false);
  });

  it('ignores test files as callers', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/apply.test.ts', 'buildAgentGroupImage();\n');

    expect(hasRealCaller('buildAgentGroupImage', 'src/container-runner.ts', root).ok).toBe(false);
  });
});

describe('seamTestStubsFunction', () => {
  it('flags the exact pre-fix apply.test.ts shape: all three stubbed in one vi.mock', () => {
    write(
      'src/modules/apply.test.ts',
      "vi.mock('../container-runner.js', () => ({\n  buildAgentGroupImage: vi.fn(),\n  killContainer: vi.fn(),\n  wakeContainer: vi.fn(),\n}));\n",
    );
    expect(seamTestStubsFunction('src/modules/apply.test.ts', 'buildAgentGroupImage', 'src/container-runner.ts', root)).toBe(
      true,
    );
  });

  it('does not flag a vi.mock of the same module that leaves the function real via vi.importActual', () => {
    write(
      'src/modules/apply.test.ts',
      "vi.mock('../container-runner.js', async () => {\n  const actual = await vi.importActual('../container-runner.js');\n  return { ...actual, killContainer: vi.fn(), wakeContainer: vi.fn() };\n});\n",
    );
    expect(seamTestStubsFunction('src/modules/apply.test.ts', 'buildAgentGroupImage', 'src/container-runner.ts', root)).toBe(
      false,
    );
  });

  it('does not flag a seam test with no mock of the module at all', () => {
    write('src/modules/apply.test.ts', "import { buildAgentGroupImage } from '../container-runner.js';\n");
    expect(seamTestStubsFunction('src/modules/apply.test.ts', 'buildAgentGroupImage', 'src/container-runner.ts', root)).toBe(
      false,
    );
  });

  it('does not collide across two different files both literally named index.ts (this repo has 22)', () => {
    // The exact bug this test guards against: matching by bare basename
    // (path.basename('src/modules/mount-security/index.ts') === 'index')
    // would make ANY vi.mock('.../index.js', ...) in the seam test look
    // like it targets mount-security/index.ts, even when it actually
    // mocks a completely unrelated index.ts (e.g. db/index.ts).
    write(
      'src/modules/foo.test.ts',
      "vi.mock('../db/index.js', () => ({ validateAdditionalMounts: vi.fn() }));\n",
    );
    expect(
      seamTestStubsFunction('src/modules/foo.test.ts', 'validateAdditionalMounts', 'src/modules/mount-security/index.ts', root),
    ).toBe(false);
  });

  it('does not false-positive-match a shallower relative path that is merely a substring of a deeper one', () => {
    // '../../container-runner.js' contains '../container-runner.js' as a
    // literal substring — a plain `.includes()` check (the bug this test
    // guards against) would wrongly treat these as the same specifier.
    write(
      'src/modules/nested/apply.test.ts',
      "vi.mock('../../container-runner.js', () => ({ buildAgentGroupImage: vi.fn() }));\n",
    );
    // The real specifier from src/modules/nested/ to src/container-runner.ts
    // is '../../container-runner.js' — so THIS should still match...
    expect(
      seamTestStubsFunction('src/modules/nested/apply.test.ts', 'buildAgentGroupImage', 'src/container-runner.ts', root),
    ).toBe(true);
    // ...but a DIFFERENT function whose real specifier from the same seam
    // test would be the shallower '../container-runner.js' (a true
    // substring of what the file actually wrote) must NOT match, even
    // though the mock factory happens to stub a same-named export.
    write('src/modules/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    expect(
      seamTestStubsFunction('src/modules/nested/apply.test.ts', 'buildAgentGroupImage', 'src/modules/container-runner.ts', root),
    ).toBe(false);
  });
});

describe('looksLikeTestFile', () => {
  it('accepts a Go test file', () => {
    write('go-host/internal/kernel/foo_test.go', 'package kernel\n\nfunc TestSomething(t *testing.T) {}\n');
    expect(looksLikeTestFile('go-host/internal/kernel/foo_test.go', root)).toBe(true);
  });

  it('rejects a Go file with no Test function', () => {
    write('go-host/internal/kernel/foo.go', 'package kernel\n\nfunc helper() {}\n');
    expect(looksLikeTestFile('go-host/internal/kernel/foo.go', root)).toBe(false);
  });

  it('accepts a vitest file', () => {
    write('src/foo.test.ts', "import { it } from 'vitest';\nit('works', () => {});\n");
    expect(looksLikeTestFile('src/foo.test.ts', root)).toBe(true);
  });

  it('accepts an EC-0N live-smoke script without test-framework syntax', () => {
    write(
      'scripts/ec09-example-live-smoke.ts',
      '// A live-smoke proof script.\n' + 'async function main() {\n  await run("docker", ["create", "..."]);\n}\n'.repeat(20),
    );
    expect(looksLikeTestFile('scripts/ec09-example-live-smoke.ts', root)).toBe(true);
  });
});

describe('checkRegistry', () => {
  function wiringOnly(entry: WiringEntry) {
    return { wiring: [entry], goKernelCapabilities: [], boundaries: [] };
  }

  it('reports no failures for a healthy entry', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write('src/modules/apply.ts', "import { buildAgentGroupImage } from '../container-runner.js';\nbuildAgentGroupImage();\n");
    write('src/modules/apply.test.ts', "import { buildAgentGroupImage } from '../container-runner.js';\n");

    const failures = checkRegistry(
      wiringOnly({ function: 'buildAgentGroupImage', definedIn: 'src/container-runner.ts', seamTest: 'src/modules/apply.test.ts' }),
      root,
    );
    expect(failures).toEqual([]);
  });

  it('reports a failure when the seam test file is missing', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    const failures = checkRegistry(
      wiringOnly({ function: 'buildAgentGroupImage', definedIn: 'src/container-runner.ts', seamTest: 'src/modules/missing.test.ts' }),
      root,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('does not exist');
  });

  it('reports both an orphan failure and a re-mocked-seam failure together', () => {
    write('src/container-runner.ts', 'export function buildAgentGroupImage() {}\n');
    write(
      'src/modules/apply.test.ts',
      "vi.mock('../container-runner.js', () => ({ buildAgentGroupImage: vi.fn() }));\n",
    );

    const failures = checkRegistry(
      wiringOnly({ function: 'buildAgentGroupImage', definedIn: 'src/container-runner.ts', seamTest: 'src/modules/apply.test.ts' }),
      root,
    );
    expect(failures).toHaveLength(2);
    expect(failures.some((f) => f.includes('no real (non-test) caller'))).toBe(true);
    expect(failures.some((f) => f.includes('now mocks'))).toBe(true);
  });

  function goOnly(entry: GoCapabilityEntry) {
    return { wiring: [], goKernelCapabilities: [entry], boundaries: [] };
  }

  it('reports no failures for a Go capability whose dispatch case is present', () => {
    write(
      'go-host/internal/kernel/capability.go',
      'package kernel\n\nfunc dispatch() {\n\tswitch cap {\n\tcase CapabilityContainerBuildImage:\n\t\thandleBuildImage()\n\t}\n}\n',
    );
    write('go-host/internal/kernel/foo_test.go', 'package kernel\n\nfunc TestLiveBuildImage(t *testing.T) {}\n');

    const failures = checkRegistry(
      goOnly({
        capability: 'container.build_image',
        definedIn: 'go-host/internal/kernel/capability.go',
        liveDockerTest: 'go-host/internal/kernel/foo_test.go',
      }),
      root,
    );
    expect(failures).toEqual([]);
  });

  it('is the ADR-024 shape one layer down: flags a Go capability whose dispatch case was removed', () => {
    write(
      'go-host/internal/kernel/capability.go',
      'package kernel\n\nfunc dispatch() {\n\tswitch cap {\n\t// case CapabilityContainerBuildImage:\n\t//\thandleBuildImage()\n\t}\n}\n',
    );
    write('go-host/internal/kernel/foo_test.go', 'package kernel\n\nfunc TestLiveBuildImage(t *testing.T) {}\n');

    const failures = checkRegistry(
      goOnly({
        capability: 'container.build_image',
        definedIn: 'go-host/internal/kernel/capability.go',
        liveDockerTest: 'go-host/internal/kernel/foo_test.go',
      }),
      root,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('case CapabilityContainerBuildImage');
  });
});
