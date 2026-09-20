/**
 * Coverage for the runCli() entrypoint in captured-token.ts. It's not
 * exported — only reachable via the module's own `import.meta.url ===
 * pathToFileURL(process.argv[1])` main-module check — so these tests fake
 * that check in-process (set process.argv[1] to the module's own path,
 * re-import with a cache-busting query so the top-level guard re-runs, and
 * trap process.exit) instead of shelling out to a real `tsx` subprocess,
 * which would run outside this process and report zero coverage here.
 * The pure extractor is already covered by captured-token.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { describe, it, expect, vi, afterEach } from 'vitest';

const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}AA`;
const MODULE_PATH = path.join(process.cwd(), 'setup/lib/captured-token.ts');

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function runCliInProcess(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const prevArgv1 = process.argv[1];
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += chunk;
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += chunk;
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  process.argv[1] = MODULE_PATH;
  process.argv.splice(2, process.argv.length, ...args);
  vi.resetModules();
  let exitCode = -1;
  try {
    await import(pathToFileURL(MODULE_PATH).href);
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else throw e;
  } finally {
    process.argv[1] = prevArgv1;
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    vi.resetModules();
  }
  return { exitCode, stdout, stderr };
}

const files: string[] = [];
function tmpFile(content: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'captured-token-')), 'capture.txt');
  fs.writeFileSync(p, content);
  files.push(p);
  return p;
}

afterEach(() => {
  for (const f of files.splice(0)) {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

describe('captured-token CLI (runCli, exercised as the real main-module entrypoint)', () => {
  it('prints the token and exits 0 when found', async () => {
    const file = tmpFile(`Your token:\n${TOKEN}\n`);
    const { exitCode, stdout } = await runCliInProcess(['claude', file]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(TOKEN);
  });

  it('exits 1 with empty stdout when no token is present', async () => {
    const file = tmpFile('claude: authentication cancelled\n');
    const { exitCode, stdout } = await runCliInProcess(['claude', file]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
  });

  it('exits 2 with a usage message on stderr when the provider is not "claude"', async () => {
    const file = tmpFile(TOKEN);
    const { exitCode, stderr } = await runCliInProcess(['openai', file]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('usage: captured-token.ts claude <capture-file>');
  });

  it('exits 2 with a usage message when no file is given', async () => {
    const { exitCode, stderr } = await runCliInProcess(['claude']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('usage:');
  });
});
