/**
 * Claude's container-side provider runtime contract.
 *
 * v2.4.0 promotion, Workstream C15. Declares the execution-policy/inference/
 * memory/mcpServers capabilities `providers/claude.ts` now consumes via
 * `ResolvedRuntimeConfiguration` (see that file and `providers/factory.ts`),
 * plus the memory session-hook write (moved out of the provider class here,
 * matching upstream's own split) and the newest-transcript lookup for
 * `/upload-trace`.
 *
 * Two deliberate divergences from upstream, not oversights:
 *
 * 1. `commands.nativeAdmin`/`nativeFiltered` corrects `/remote-control` to
 *    filtered, not admin. Upstream's own container-side contract categorizes
 *    it as admin — but this fork's `formatter.ts` (container) and
 *    `command-gate.ts`/`provider-contracts/claude.ts` (host, Workstream C14)
 *    both categorize it as filtered, and `formatter.commandLists.test.ts`'s
 *    own header names this exact command as one that had already silently
 *    diverged in this fork's history. `contract.commands` is currently
 *    inert either way (nothing reads it for real behavior yet — see below),
 *    but a self-contradictory declared value serves no one; matching this
 *    fork's own already-tested categorization is the only value that makes
 *    the contract internally consistent with the rest of the codebase.
 *
 * 2. `textDelivery`/`commands.formatting` are declared (verifier-checked,
 *    so the shape stays correct) but not yet consumed by `poll-loop.ts` —
 *    see `providers/types.ts`'s comment on `emitsMidTurnText` for why that
 *    reconciliation is deliberately out of scope for this pass. This
 *    contract still activates the real value of C15: contract-driven
 *    execution-policy/inference/mcpServers/memory resolution replaces
 *    `providers/claude.ts`'s old constructor-time option handling.
 */
import fs from 'fs';
import path from 'path';

import {
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeMemoryRuntime,
} from '../providers/claude-config.js';
import { claudeConfigDirectory, newestClaudeTranscript } from '../providers/claude-history.js';

import { registerProviderContract } from '../providers/provider-registry.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type RuntimeMemoryHookInput,
} from './registry.js';

const provider = 'claude';
const tone = { default: 'Concise', toSettings: (tone: string) => ({ outputStyle: tone }) };

export const claudeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    // Claude's stance is fixed — the container and the OneCLI allow-list are
    // the boundary — so it is declared as the constant it is.
    executionPolicy: { constant: resolveClaudeExecutionPolicy() },
    inference: resolveClaudeInference,
    tone,
    // The memory runtime env is likewise fixed: auto-memory stays off whatever
    // hook core registers, so it is a constant, not a function of the hook.
    memory: { constant: resolveClaudeMemoryRuntime() },
    mcpServers: resolveClaudeMcpServers,
  },
  lifecycle: { memorySessionHookRegistration: writeMemorySessionHook },
  // Pre-compact archiving and continuation rotation are provider-internal
  // (providers/claude-history.ts); core only needs the trace lookup.
  history: { readTrace: newestClaudeTranscript },
  textDelivery: 'mid-turn-complete',
  commands: {
    formatting: 'native',
    nativeAdmin: ['/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/help', '/login', '/logout', '/doctor', '/config', '/start', '/remote-control'],
  },
};

registerProviderContract(provider, claudeRuntimeContract);

function writeMemorySessionHook(hook: RuntimeMemoryHookInput): void {
  const filePath = path.join(claudeConfigDirectory(), 'settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const exists = fs.existsSync(filePath);
  const parsed: unknown = exists ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : {};
  if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${filePath} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${filePath} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  // Seed user defaults; existing values and higher-priority project/local settings win.
  const settings = { ...tone.toSettings(tone.default), ...parsed };
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
