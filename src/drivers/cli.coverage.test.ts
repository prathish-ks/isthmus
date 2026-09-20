/**
 * Coverage-uplift tests for drivers/cli.ts targeting realCli's `run()` and
 * the event-wiring inside `start()` — the pre-existing cli.test.ts only
 * pins start()'s `detached: true` spawn option via a fully-stubbed
 * child_process mock, so run() and the stdout/stderr/exit callback plumbing
 * are never exercised. Uses real (non-mocked) child processes with plain
 * shell builtins (`sh`, `echo`, `cat`) — no network, no Docker, no claude
 * CLI, no onecli.
 */
import { describe, expect, it } from 'vitest';

import { realCli, validateRuntimeName } from './cli.js';

describe('realCli.run', () => {
  it('returns stdout on a successful command', () => {
    const cli = realCli('sh');
    const out = cli.run(['-c', 'echo hello-from-run']);
    expect(out.trim()).toBe('hello-from-run');
  });

  it('throws on a non-zero exit code', () => {
    const cli = realCli('sh');
    expect(() => cli.run(['-c', 'exit 3'])).toThrow();
  });

  it('pipes opts.input to the process stdin', () => {
    const cli = realCli('cat');
    const out = cli.run([], { input: 'piped-through-stdin' });
    expect(out).toBe('piped-through-stdin');
  });

  it('respects a short timeoutMs by killing a long-running command', () => {
    const cli = realCli('sh');
    expect(() => cli.run(['-c', 'sleep 5'], { timeoutMs: 100 })).toThrow();
  });
});

describe('realCli.start', () => {
  it('delivers stdout lines and fires onExit(0) for a successful process', async () => {
    const cli = realCli('sh');
    const proc = cli.start(['-c', 'echo out-line-1; echo out-line-2'], { captureStdout: true });
    const stdoutChunks: string[] = [];
    let exitCode: number | null | undefined;
    proc.onStdout((line) => stdoutChunks.push(line));
    const exited = new Promise<void>((resolve) => {
      proc.onExit((code) => {
        exitCode = code;
        resolve();
      });
    });
    await exited;
    expect(exitCode).toBe(0);
    expect(stdoutChunks.join('')).toContain('out-line-1');
    expect(stdoutChunks.join('')).toContain('out-line-2');
  });

  it('delivers stderr lines split and trims blank lines', async () => {
    const cli = realCli('sh');
    const proc = cli.start(['-c', 'echo err-line-1 1>&2; echo "" 1>&2; echo err-line-2 1>&2']);
    const stderrLines: string[] = [];
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    proc.onStderr((line) => stderrLines.push(line));
    await exited;
    expect(stderrLines).toEqual(['err-line-1', 'err-line-2']);
  });

  it('fires onExit(null) when the process errors instead of exiting (bad binary)', async () => {
    const cli = realCli('/no/such/binary/at/all');
    const proc = cli.start(['x']);
    const exitCode = await new Promise<number | null>((resolve) => proc.onExit(resolve));
    expect(exitCode).toBeNull();
  });

  it('kill() terminates a running process, still firing onExit exactly once', async () => {
    const cli = realCli('sh');
    const proc = cli.start(['-c', 'sleep 30']);
    let exitCalls = 0;
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => {
        exitCalls++;
        resolve();
      });
    });
    proc.kill();
    await exited;
    // Give any duplicate close/error event a moment to (not) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(exitCalls).toBe(1);
  });
});

describe('validateRuntimeName', () => {
  it('accepts a well-formed name and returns it unchanged', () => {
    expect(validateRuntimeName('nanoclaw-agent_1.2-3', 'container')).toBe('nanoclaw-agent_1.2-3');
  });

  it('rejects names with shell-hostile characters', () => {
    expect(() => validateRuntimeName('bad; rm -rf /', 'container')).toThrow('Invalid container name');
    expect(() => validateRuntimeName('', 'network')).toThrow('Invalid network name');
    expect(() => validateRuntimeName('-leading-dash', 'volume')).toThrow('Invalid volume name');
  });
});
