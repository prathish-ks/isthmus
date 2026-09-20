/**
 * Coverage for setup/onecli.ts — installs/configures the OneCLI gateway +
 * CLI, or reuses an existing one, or points at a remote one.
 *
 * `child_process` is mocked so no real `curl`/`tar`/`docker`/`onecli` ever
 * runs — the mocked `execSync` simulates the CLI-download archive by writing
 * a stub `onecli` binary into the expected temp extraction dir, so the
 * subsequent real `fs.copyFileSync` in installOnecliCliDirect() has
 * something to copy. `./lib/version-pins.js` is mocked so the pinned
 * versions (and therefore the constructed download URL) are deterministic.
 * `os.homedir()` is mocked to a disposable temp dir so `~/.bashrc`/`~/.zshrc`
 * and `~/.local/bin` writes never touch the real machine.
 *
 * Safety-critical: `installOnecliCliDirect()` probes `/usr/local/bin` for
 * writability with a bare, non-overridable `fs.accessSync('/usr/local/bin', W_OK)`
 * and, if writable, installs the real `onecli` binary there for real — this
 * bit the sibling install-cred-helper test file during development (a stray
 * real file ended up in /usr/local/bin on the host). `fs.accessSync` is
 * therefore spied to always report "not writable", so every test exercises
 * the safe `~/.local/bin` fallback and NOTHING is ever written to
 * `/usr/local/bin` by this file.
 *
 * `pollHealth`'s internal 1s retry delay is driven with vi.useFakeTimers()
 * instead of real wall-clock waits.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

const mockVersionPins = vi.hoisted(() => ({
  readVersionPin: vi.fn((component: string) => {
    if (component === 'onecli-gateway') return '9.9.9';
    if (component === 'onecli-cli') return '8.8.8';
    throw new Error(`versions.json has no pin for "${component}"`);
  }),
}));
vi.mock('./lib/version-pins.js', () => mockVersionPins);

const cliState = vi.hoisted(() => ({
  execCalls: [] as string[],
  execFailPatterns: [] as RegExp[],
  execFileFailPatterns: [] as RegExp[],
  dockerPsOutput: '',
  onecliVersionOutput: 'onecli 8.8.8',
  apiHostOutput: '',
}));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, _opts?: unknown) => {
    cliState.execCalls.push(cmd);
    if (cliState.execFailPatterns.some((p) => p.test(cmd))) {
      throw new Error(`mock execSync failure: ${cmd}`);
    }
    const curlMatch = cmd.match(/^curl -fsSL -o "(.+?)" "(.+?)"$/);
    if (curlMatch) {
      fs.writeFileSync(curlMatch[1], 'fake archive bytes');
      return '';
    }
    const tarMatch = cmd.match(/^tar -xzf "(.+?)" -C "(.+?)"$/);
    if (tarMatch) {
      fs.writeFileSync(path.join(tarMatch[2], 'onecli'), '#!/bin/sh\necho fake onecli\n');
      return '';
    }
    if (cmd.startsWith('docker ps -a')) return cliState.dockerPsOutput;
    if (cmd.startsWith('docker rm -f')) return '';
    if (cmd.includes('onecli.sh/install')) return 'Installed OneCLI gateway at http://127.0.0.1:10254\n';
    return '';
  }),
  execFileSync: vi.fn((cmd: string, args: string[] = [], _opts?: unknown) => {
    cliState.execCalls.push(`${cmd} ${args.join(' ')}`);
    if (cmd !== 'onecli') throw new Error(`ENOENT: ${cmd}`);
    const sub = args.join(' ');
    if (cliState.execFileFailPatterns.some((p) => p.test(sub))) {
      throw new Error(`mock execFileSync failure: onecli ${sub}`);
    }
    if (sub === 'version') return cliState.onecliVersionOutput;
    if (sub === 'config get api-host') return cliState.apiHostOutput;
    return '';
  }),
}));

const origCwd = process.cwd();
const origExit = process.exit;
const origPlatform = process.platform;
const origArch = process.arch;
let tmpDir: string;
let homeDir: string;
let projectDir: string;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-test-')));
  homeDir = path.join(tmpDir, 'home');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.chdir(projectDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  // Never let this really touch /usr/local/bin — see file-header note.
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {
    throw new Error('EACCES (forced by test for safety)');
  });

  emitted.length = 0;
  cliState.execCalls = [];
  cliState.execFailPatterns = [];
  cliState.execFileFailPatterns = [];
  cliState.dockerPsOutput = '';
  cliState.onecliVersionOutput = 'onecli 8.8.8';
  cliState.apiHostOutput = '';
  mockVersionPins.readVersionPin.mockClear();

  vi.stubEnv('NANOCLAW_ONECLI_API_TOKEN', '');
  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  process.chdir(origCwd);
  Object.defineProperty(process, 'platform', { value: origPlatform });
  Object.defineProperty(process, 'arch', { value: origArch });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readDotEnv(): string {
  const p = path.join(projectDir, '.env');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

async function runOnecli(args: string[]): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./onecli.js');
  try {
    await run(args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

describe('getOnecliApiHost', () => {
  it('parses JSON output with a "data" field', async () => {
    cliState.apiHostOutput = JSON.stringify({ data: 'http://127.0.0.1:10254' });
    const { getOnecliApiHost } = await import('./onecli.js');
    expect(getOnecliApiHost()).toBe('http://127.0.0.1:10254');
  });

  it('parses JSON output with a "value" field', async () => {
    cliState.apiHostOutput = JSON.stringify({ value: 'http://127.0.0.1:10254' });
    const { getOnecliApiHost } = await import('./onecli.js');
    expect(getOnecliApiHost()).toBe('http://127.0.0.1:10254');
  });

  it('extracts a URL from raw-text output when not JSON', async () => {
    cliState.apiHostOutput = 'api-host: http://127.0.0.1:10254 (configured)';
    const { getOnecliApiHost } = await import('./onecli.js');
    expect(getOnecliApiHost()).toBe('http://127.0.0.1:10254');
  });

  it('returns null when onecli is not on PATH', async () => {
    cliState.execFileFailPatterns.push(/^config get api-host$/);
    const { getOnecliApiHost } = await import('./onecli.js');
    expect(getOnecliApiHost()).toBeNull();
  });

  it('returns null when neither JSON parsing nor URL extraction finds anything', async () => {
    cliState.apiHostOutput = 'no host configured';
    const { getOnecliApiHost } = await import('./onecli.js');
    expect(getOnecliApiHost()).toBeNull();
  });
});

describe('pollHealth', () => {
  it('returns true immediately when the first probe succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { pollHealth } = await import('./onecli.js');
    await expect(pollHealth('http://x', 5000)).resolves.toBe(true);
  });

  it('retries and succeeds on a later probe within the deadline', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return { ok: calls >= 3 } as Response;
      }),
    );
    const { pollHealth } = await import('./onecli.js');
    const promise = pollHealth('http://x', 10000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('returns false once the deadline passes with no successful probe', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
    const { pollHealth } = await import('./onecli.js');
    const promise = pollHealth('http://x', 2500);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toBe(false);
  });

  it('tolerates a fetch that throws (network error) and keeps polling', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const { pollHealth } = await import('./onecli.js');
    const promise = pollHealth('http://x', 1500);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe(false);
  });
});

describe('run() — remote mode (--remote-url)', () => {
  it('fails cli_install_failed when the platform is unsupported', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ step: 'ONECLI', STATUS: 'failed', ERROR: 'cli_install_failed' });
  });

  it('fails cli_install_failed when the arch is unsupported', async () => {
    Object.defineProperty(process, 'arch', { value: 'ia32' });
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'cli_install_failed' });
  });

  it('fails cli_install_failed when the download itself fails', async () => {
    cliState.execFailPatterns.push(/^curl -fsSL -o/);
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'cli_install_failed' });
  });

  it('fails cli_install_failed when the freshly installed binary does not run (version check fails)', async () => {
    cliState.execFileFailPatterns.push(/^version$/);
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'cli_install_failed' });
  });

  it('installs the CLI, configures api-host, writes .env, and reports success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(readDotEnv()).toContain('ONECLI_URL=http://remote.example.com');
    expect(cliState.execCalls).toContain('onecli config set api-host http://remote.example.com');
    expect(emitted.at(-1)).toMatchObject({
      STATUS: 'success',
      REMOTE: true,
      ONECLI_URL: 'http://remote.example.com',
      HEALTHY: true,
    });
    // Installed to the safe fallback under our mocked HOME, never /usr/local/bin.
    expect(fs.existsSync(path.join(homeDir, '.local', 'bin', 'onecli'))).toBe(true);
  });

  it('tolerates `onecli config set api-host` failing (non-fatal)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    cliState.execFileFailPatterns.push(/^config set api-host/);
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });

  it('writes ONECLI_API_KEY and runs `onecli auth login` when NANOCLAW_ONECLI_API_TOKEN is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    vi.stubEnv('NANOCLAW_ONECLI_API_TOKEN', 'secret-token-123');
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(readDotEnv()).toContain('ONECLI_API_KEY=secret-token-123');
    expect(cliState.execCalls).toContain('onecli auth login --api-key secret-token-123');
  });

  it('tolerates `onecli auth login` failing (non-fatal, still writes the key)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    vi.stubEnv('NANOCLAW_ONECLI_API_TOKEN', 'secret-token-123');
    cliState.execFileFailPatterns.push(/^auth login/);
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(readDotEnv()).toContain('ONECLI_API_KEY=secret-token-123');
  });

  it('does not write ONECLI_API_KEY when no token is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(readDotEnv()).not.toContain('ONECLI_API_KEY');
  });

  it('reports HEALTHY: false without crashing when the remote gateway never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
    const runPromise = runOnecli(['--remote-url', 'http://remote.example.com']);
    await vi.advanceTimersByTimeAsync(6000);
    const { exits } = await runPromise;
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ HEALTHY: false, STATUS: 'success' });
  });

  it('surfaces a GATEWAY_HINT when the healthy gateway is pre-/v1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/v1/health')) return { ok: false } as Response;
        return { ok: true } as Response;
      }),
    );
    const { exits } = await runOnecli(['--remote-url', 'http://remote.example.com']);
    expect(exits).toEqual([]);
    expect(String(emitted.at(-1)!.GATEWAY_HINT)).toContain('lacks the /v1 API');
  });
});

describe('run() — reuse mode (--reuse)', () => {
  it('fails onecli_not_found_for_reuse when onecli is not on PATH', async () => {
    cliState.execFileFailPatterns.push(/^version$/);
    const { exits } = await runOnecli(['--reuse']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'onecli_not_found_for_reuse' });
  });

  it('fails onecli_api_host_not_configured when onecli has no api-host set', async () => {
    cliState.apiHostOutput = 'no host configured';
    const { exits } = await runOnecli(['--reuse']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'onecli_api_host_not_configured',
    });
  });

  it('reuses the existing gateway, writes .env, and reports success', async () => {
    cliState.apiHostOutput = JSON.stringify({ data: 'http://127.0.0.1:10254' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli(['--reuse']);
    expect(exits).toEqual([]);
    expect(readDotEnv()).toContain('ONECLI_URL=http://127.0.0.1:10254');
    expect(emitted.at(-1)).toMatchObject({ REUSED: true, ONECLI_URL: 'http://127.0.0.1:10254', STATUS: 'success' });
    // Reuse mode never installs anything.
    expect(cliState.execCalls.some((c) => c.includes('curl -fsSL -o'))).toBe(false);
  });
});

describe('run() — default install mode', () => {
  it('fails install_failed when the gateway install itself fails', async () => {
    cliState.execFailPatterns.push(/onecli\.sh\/install/);
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'install_failed' });
  });

  it('fails install_failed when the gateway installs but the CLI download fails', async () => {
    cliState.execFailPatterns.push(/^curl -fsSL -o/);
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'install_failed' });
  });

  it('tolerates `docker ps` itself failing (e.g. docker not installed) during legacy-container cleanup', async () => {
    cliState.execFailPatterns.push(/^docker ps -a/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });

  it('overwrites an existing ONECLI_URL line in .env rather than duplicating it', async () => {
    fs.writeFileSync(path.join(projectDir, '.env'), 'ONECLI_URL=http://stale.example.com\nOTHER=1\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    const env = readDotEnv();
    expect(env).toContain('ONECLI_URL=http://127.0.0.1:10254');
    expect(env).not.toContain('stale.example.com');
    expect(env).toContain('OTHER=1');
    expect(env.match(/ONECLI_URL=/g)?.length).toBe(1);
  });

  it('cleans up legacy (non-v2) OneCLI containers before installing', async () => {
    cliState.dockerPsOutput = 'onecli-app-1|app\nonecli-1|onecli\nonecli-postgres-1|postgres';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    expect(cliState.execCalls).toContain('docker rm -f "onecli-app-1"');
    // v2 service names are left alone.
    expect(cliState.execCalls.some((c) => c.includes('onecli-1'))).toBe(false);
  });

  it('tolerates a legacy container removal failure and continues installing', async () => {
    cliState.dockerPsOutput = 'onecli-app-1|app';
    cliState.execFailPatterns.push(/^docker rm -f/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });

  it('fails onecli_not_on_path_after_install when the version check fails post-install', async () => {
    cliState.execFileFailPatterns.push(/^version$/);
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'onecli_not_on_path_after_install' });
  });

  // NOTE ("could_not_resolve_api_host" is effectively unreachable in
  // practice, and is a real observed bug): the combined stdout that
  // extractUrlFromOutput() scans is cleanup-output + gateway-install-output +
  // CLI-install-output, and installOnecliCliDirect() unconditionally logs
  // `Downloading https://github.com/<repo>/releases/download/...` on its
  // success path (the only path that reaches url resolution at all — a
  // failed CLI install exits earlier via ERROR: install_failed). So whenever
  // the *gateway* installer's own output happens not to contain a URL, the
  // code does not fall into the intended failure branch — instead the
  // regex's first match becomes the CLI's own GitHub download host
  // (truncated to "https://github.com"), which gets silently treated as the
  // resolved onecli api-host and handed to `onecli config set api-host`.
  // Demonstrated here instead of testing the (unreachable) intended branch.
  it('BUG: silently resolves the wrong "api-host" (the CLI download URL) when the gateway installer output has none', async () => {
    const { execSync } = await import('child_process');
    vi.mocked(execSync).mockImplementationOnce((...args: unknown[]) => {
      cliState.execCalls.push(String(args[0]));
      return ''; // legacy-container cleanup: no output
    });
    vi.mocked(execSync).mockImplementationOnce((...args: unknown[]) => {
      cliState.execCalls.push(String(args[0]));
      return 'Installed, but no URL printed here.\n'; // gateway install: no URL
    });
    const { exits } = await runOnecli([]);
    // Not the intended failure — the wrong host is "resolved" and reported
    // as a success instead.
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ INSTALLED: true, STATUS: 'success', ONECLI_URL: 'https://github.com' });
  });

  it('installs, configures api-host, writes .env, and reports success with no HEALTH_HINT when healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    expect(readDotEnv()).toContain('ONECLI_URL=http://127.0.0.1:10254');
    expect(cliState.execCalls).toContain('onecli config set api-host http://127.0.0.1:10254');
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ INSTALLED: true, STATUS: 'success', HEALTHY: true });
    expect(status.HEALTH_HINT).toBeUndefined();
  });

  it('reports a HEALTH_HINT when the freshly installed gateway does not answer within the poll window', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );
    const runPromise = runOnecli([]);
    await vi.advanceTimersByTimeAsync(16000);
    const { exits } = await runPromise;
    expect(exits).toEqual([]);
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ HEALTHY: false, STATUS: 'success' });
    expect(String(status.HEALTH_HINT)).toContain('auth-gated');
  });

  it('tolerates `onecli config set api-host` failing after a fresh install (non-fatal)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    cliState.execFileFailPatterns.push(/^config set api-host/);
    const { exits } = await runOnecli([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });
});

describe('run() — ensureShellProfilePath', () => {
  it('appends the PATH export to .bashrc and .zshrc when absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }) as Response),
    );
    await runOnecli(['--reuse']).catch(() => {});
    // --reuse without a working onecli fails fast, but ensureShellProfilePath
    // runs unconditionally before that check.
    const bashrc = fs.readFileSync(path.join(homeDir, '.bashrc'), 'utf-8');
    const zshrc = fs.readFileSync(path.join(homeDir, '.zshrc'), 'utf-8');
    expect(bashrc).toContain('.local/bin');
    expect(zshrc).toContain('.local/bin');
  });

  it('does not duplicate the PATH export on a second run', async () => {
    fs.writeFileSync(path.join(homeDir, '.bashrc'), 'export PATH="$HOME/.local/bin:$PATH"\n');
    await runOnecli(['--reuse']).catch(() => {});
    const bashrc = fs.readFileSync(path.join(homeDir, '.bashrc'), 'utf-8');
    expect(bashrc.match(/\.local\/bin/g)?.length).toBe(1);
  });
});
