/**
 * Coverage-uplift tests for migrate-claude-memory-settings.ts (no sibling
 * test file previously existed for this module — baseline coverage was
 * ~4%). Covers: a settings file with everything already reconciled
 * (no-op, returns false), a fully-legacy file needing every fix, the
 * non-object-root guard, malformed JSON, the legacy-hook removal
 * (both "hooks empties out" and "hooks partially survive" shapes), and
 * writeAtomic's real file write.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateClaudeMemorySettings } from './migrate-claude-memory-settings.js';
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

describe('migrateClaudeMemorySettings', () => {
  it('is a no-op and returns false when everything is already reconciled', () => {
    write({
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }] },
    });
    const before = fs.readFileSync(settingsFile, 'utf-8');
    expect(migrateClaudeMemorySettings(settingsFile)).toBe(false);
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
    const changed = migrateClaudeMemorySettings(settingsFile);
    expect(changed).toBe(true);
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
    migrateClaudeMemorySettings(settingsFile);
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
    expect(migrateClaudeMemorySettings(settingsFile)).toBe(false);
  });

  it('returns false and warns when the settings root is not an object', () => {
    write(['not', 'an', 'object']);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(migrateClaudeMemorySettings(settingsFile)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'Claude settings root is not an object; leaving it unchanged',
      expect.objectContaining({ settingsFile }),
    );
  });

  it('returns false and warns when the file is malformed JSON', () => {
    fs.writeFileSync(settingsFile, '{ not valid json');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(migrateClaudeMemorySettings(settingsFile)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to reconcile Claude settings; leaving them unchanged',
      expect.objectContaining({ settingsFile }),
    );
  });

  it('returns false and warns when the file does not exist', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(migrateClaudeMemorySettings(path.join(dir, 'does-not-exist.json'))).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('starts from an empty object and builds env/hooks structures from scratch', () => {
    write({});
    const changed = migrateClaudeMemorySettings(settingsFile);
    expect(changed).toBe(true);
    const result = read();
    expect(result.autoMemoryEnabled).toBe(false);
    expect(result.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect((result.hooks as Record<string, unknown>).PreCompact).toBeDefined();
  });
});
