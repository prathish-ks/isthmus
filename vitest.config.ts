import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // A handful of tests shell out to real subprocesses (execFileSync/
    // spawnSync against /bin/sh, and a real `tsx` process import in
    // setup/channels/slack-auto.test.ts) rather than mocking them, since
    // that's the point of the test. Vitest's 5000ms default is tight for
    // that under full-suite parallelism — which specific test trips it
    // varies run to run (confirmed 2026-09-06: not one broken test, a
    // shared-resource-pressure issue). 15s keeps real hangs failing loud
    // while giving real subprocess spawns room to finish under load.
    testTimeout: 15000,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
