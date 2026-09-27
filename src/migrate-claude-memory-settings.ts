import fs from 'fs';

import { log } from './log.js';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const LEGACY_MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts';

/**
 * Isthmus's own default Claude settings — NOT upstream's `CLAUDE_DEFAULT_SETTINGS`
 * (v2.4.0 promotion, Workstream C14 step 5: a deliberate divergence, not a gap).
 * Carries the `PreCompact` hook and the auto-memory/directories env vars this
 * fork already depends on; upstream's own default settings content doesn't
 * have them, and adopting it verbatim would silently drop working behavior.
 * Single source of truth for both `group-init.ts`'s fallback (any future
 * provider with neither a contract nor `providesAgentSurfaces`) and
 * `provider-contracts/claude.ts`'s own `files` declaration.
 */
export const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

export interface ClaudeSettingsReconciliation {
  changed: boolean;
  content: string;
  /** True when the root wasn't a JSON object — nothing was changed, but this isn't a parse failure either. */
  notAnObject?: boolean;
}

/**
 * Pure: compute reconciled Claude settings content from the current file
 * content, without touching disk. Throws on malformed JSON — callers decide
 * how to report that; a non-object root is reported via `notAnObject`
 * instead, since it's a recognized (if unexpected) shape, not a parse error.
 *
 * Split out from `migrateClaudeMemorySettings` (Workstream C14, step 5) so
 * `provider-contracts/claude.ts`'s file transformer can reuse this exact
 * logic without duplicating it or performing its own I/O — `realize.ts`
 * handles reading and atomically writing the file.
 */
export function reconcileClaudeSettingsContent(current: string): ClaudeSettingsReconciliation {
  const parsed: unknown = JSON.parse(current);
  if (!isRecord(parsed)) return { changed: false, content: current, notAnObject: true };

  let changed = false;
  if (parsed.autoMemoryEnabled !== false) {
    parsed.autoMemoryEnabled = false;
    changed = true;
  }

  const env = isRecord(parsed.env) ? parsed.env : {};
  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    changed = true;
  }
  if (parsed.env !== env) {
    parsed.env = env;
    changed = true;
  }

  const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
  const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  const nextSessionStart = existingSessionStart
    .map(removeLegacyNanoClawMemoryHook)
    .filter((entry) => entry !== undefined);
  if (JSON.stringify(nextSessionStart) !== JSON.stringify(existingSessionStart)) {
    if (nextSessionStart.length > 0) hooks.SessionStart = nextSessionStart;
    else delete hooks.SessionStart;
    changed = true;
  }

  const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
  if (!JSON.stringify(preCompact).includes(PRE_COMPACT_COMMAND)) {
    preCompact.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
    hooks.PreCompact = preCompact;
    changed = true;
  }
  if (parsed.hooks !== hooks) {
    parsed.hooks = hooks;
    changed = true;
  }

  if (!changed) return { changed: false, content: current };
  return { changed: true, content: JSON.stringify(parsed, null, 2) + '\n' };
}

/** Reconcile existing Claude settings with NanoClaw's shared memory system. */
export function migrateClaudeMemorySettings(settingsFile: string): boolean {
  try {
    const result = reconcileClaudeSettingsContent(fs.readFileSync(settingsFile, 'utf-8'));
    if (result.notAnObject) {
      log.warn('Claude settings root is not an object; leaving it unchanged', { settingsFile });
      return false;
    }
    if (!result.changed) return false;
    writeAtomic(settingsFile, result.content);
    return true;
  } catch (err) {
    log.warn('Failed to reconcile Claude settings; leaving them unchanged', {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function removeLegacyNanoClawMemoryHook(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return hook.command !== LEGACY_MEMORY_SESSION_START_COMMAND;
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename consumed the temp file, or creation failed before it existed.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
