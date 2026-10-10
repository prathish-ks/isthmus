/**
 * Coverage-uplift tests for migrate-claude-memory-settings.ts (no sibling
 * test file previously existed for this module — baseline coverage was
 * ~4%). Covers: a settings file with everything already reconciled
 * (no-op, returns 'unchanged'), a fully-legacy file needing every fix, the
 * non-object-root guard, malformed JSON, the legacy-hook removal
 * (both "hooks empties out" and "hooks partially survive" shapes), and
 * creating settings.json from scratch when it's missing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareClaudeMemorySettings } from './migrate-claude-memory-settings.js';
import { log } from './log.js';

let dir: string;
let settingsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-settings-cov-'));
  settingsFile = path.join(dir, 'settings.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(obj: unknown): void {
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

function read(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}

describe('prepareClaudeMemorySettings', () => {
  it('is a no-op and returns unchanged when everything is already reconciled', () => {
    write({
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }] },
    });
    const before = fs.readFileSync(settingsFile, 'utf-8');
    expect(prepareClaudeMemorySettings(dir)).toBe('unchanged');
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  it('applies every fix on a fully-legacy settings file', () => {
    write({
      autoMemoryEnabled: true,
      env: { OTHER_VAR: 'keep-me' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'bun /app/src/memory-hook.ts' }] }],
      },
    });
    expect(prepareClaudeMemorySettings(dir)).toBe('reconciled');
    const result = read();
    expect(result.autoMemoryEnabled).toBe(false);
    expect((result.env as Record<string, unknown>).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect((result.env as Record<string, unknown>).OTHER_VAR).toBe('keep-me');
    // The only SessionStart entry was entirely the legacy hook — removed, key dropped.
    expect(result.hooks).not.toHaveProperty('SessionStart');
    expect((result.hooks as Record<string, unknown>).PreCompact).toBeDefined();
  });

  it('preserves a SessionStart entry that mixes the legacy hook with other hooks', () => {
    write({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'bun /app/src/memory-hook.ts' },
              { type: 'command', command: 'echo keep-this' },
            ],
          },
        ],
      },
    });
    prepareClaudeMemorySettings(dir);
    const result = read();
    const sessionStart = (result.hooks as Record<string, unknown>).SessionStart as Array<{ hooks: unknown[] }>;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0].hooks).toEqual([{ type: 'command', command: 'echo keep-this' }]);
  });

  it('leaves SessionStart entries with no legacy hook untouched (no-op for that key)', () => {
    write({
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }],
      },
    });
    expect(prepareClaudeMemorySettings(dir)).toBe('unchanged');
  });

  it('returns unchanged and warns when the settings root is not an object', () => {
    write(['not', 'an', 'object']);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(prepareClaudeMemorySettings(dir)).toBe('unchanged');
    expect(warnSpy).toHaveBeenCalledWith(
      'Claude settings root is not an object; leaving it unchanged',
      expect.objectContaining({ settingsFile }),
    );
  });

  it('returns unchanged and warns when the file is malformed JSON', () => {
    fs.writeFileSync(settingsFile, '{ not valid json');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(prepareClaudeMemorySettings(dir)).toBe('unchanged');
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to reconcile Claude settings; leaving them unchanged',
      expect.objectContaining({ settingsFile }),
    );
  });

  it('creates settings.json from the default content when the directory has none yet', () => {
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(prepareClaudeMemorySettings(dir)).toBe('created');
    const result = read();
    expect(result.autoMemoryEnabled).toBe(false);
    expect((result.hooks as Record<string, unknown>).PreCompact).toBeDefined();
  });

  it('creates the claudeDir itself (and settings.json) when neither exists yet', () => {
    const freshDir = path.join(dir, 'not-yet-created');
    expect(prepareClaudeMemorySettings(freshDir)).toBe('created');
    expect(fs.existsSync(path.join(freshDir, 'settings.json'))).toBe(true);
  });

  it('starts from an empty object and builds env/hooks structures from scratch', () => {
    write({});
    expect(prepareClaudeMemorySettings(dir)).toBe('reconciled');
    const result = read();
    expect(result.autoMemoryEnabled).toBe(false);
    expect(result.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect((result.hooks as Record<string, unknown>).PreCompact).toBeDefined();
  });
});
