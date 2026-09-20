/**
 * Coverage-uplift tests for config.ts (no sibling test file previously
 * existed for this module) — targets the few env-var-driven branches: the
 * NANOCLAW_TEMPLATES_DIR override, the HOME-unset os.homedir() fallback,
 * and resolveConfigTimezone's final UTC fallback when nothing (TZ env,
 * .env TZ, or the Intl-resolved system zone) is valid. Every scenario
 * needs a fresh module instance (config.ts computes its exports once at
 * import time), so each test resets modules and re-imports.
 */
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['HOME', 'TZ', 'NANOCLAW_TEMPLATES_DIR'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('NANOCLAW_TEMPLATES_DIR override', () => {
  it('resolves TEMPLATES_DIR against the provided override when set', async () => {
    process.env.NANOCLAW_TEMPLATES_DIR = './my-templates';
    const config = await import('./config.js');
    expect(config.TEMPLATES_DIR).toBe(path.resolve('./my-templates'));
  });
});

describe('HOME fallback', () => {
  it('falls back to os.homedir() when HOME is unset', async () => {
    delete process.env.HOME;
    const os = await import('os');
    const homedirSpy = vi.spyOn(os.default, 'homedir').mockReturnValue('/fake/home');
    const config = await import('./config.js');
    expect(config.MOUNT_ALLOWLIST_PATH.startsWith('/fake/home')).toBe(true);
    homedirSpy.mockRestore();
  });
});

describe('resolveConfigTimezone fallback to UTC', () => {
  it('returns UTC when TZ env, .env TZ, and the Intl-resolved zone are all unusable', async () => {
    delete process.env.TZ;
    vi.doMock('./env.js', () => ({
      readEnvFile: () => ({}),
    }));
    const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Not/AValidZone' } as unknown as Intl.ResolvedDateTimeFormatOptions);
    try {
      const config = await import('./config.js');
      expect(config.TIMEZONE).toBe('UTC');
    } finally {
      spy.mockRestore();
      expect(Intl.DateTimeFormat.prototype.resolvedOptions).toBe(realResolvedOptions);
    }
  });
});
