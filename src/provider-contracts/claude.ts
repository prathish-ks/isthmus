/**
 * Claude's provider host contract.
 *
 * v2.4.0 promotion, Workstream C8 (ADR-030) shipped the narrow slice of
 * this contract first (`modelDomains`/`modelEndpoints` only — see this
 * file's own git history and `registry.ts`'s header for why). Workstream
 * C14 (steps 4-5) adds the mount/file surface: `container-runner.ts`'s
 * `buildMounts` now composes Claude's mounts from this contract instead of
 * its own hand-written `.claude-shared` logic, and `group-init.ts` realizes
 * the group-lifetime portion (state-volume dir, settings.json) from it too.
 *
 * Declaring `projectDocument` here is what actually switches Claude over —
 * `hasProviderMountSurface('claude')` (registry.ts) starts returning true
 * the moment this module's side-effecting import runs, and every legacy
 * `defaultSurfaces` branch in `container-runner.ts`/`group-init.ts` stops
 * applying to Claude from that point on.
 *
 * No `inference` declaration: the `--speed` CLI flag this would back
 * (`cli/resources/groups.ts`'s `assertDeclaredSpeedTier` in upstream) isn't
 * wired into this tree — nothing would read it yet, and a declaration
 * nothing consumes is exactly the unused structure C8's narrow port existed
 * to avoid. Add it alongside wiring that flag, not before.
 */
import { DEFAULT_SETTINGS_JSON, reconcileClaudeSettingsContent } from '../migrate-claude-memory-settings.js';

import { registerProviderFileTransformer } from './file-transformers.js';
import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, registerProviderHostContract } from './registry.js';

// Reconciles an existing settings.json (operator-edited or pre-dating this
// contract) toward Isthmus's own required shape, same logic
// `migrateClaudeMemorySettings` used directly before this contract existed —
// see that function's own header for why this fork's settings content
// deliberately isn't upstream's `CLAUDE_DEFAULT_SETTINGS`.
registerProviderFileTransformer('claude-settings', {
  transform(current, filePath) {
    // JSON.parse failures propagate to realize.ts's own try/catch, which
    // calls mapIoFailure below — matches migrateClaudeMemorySettings's
    // original generic "failed to reconcile" outer-catch behavior.
    const result = reconcileClaudeSettingsContent(current);
    if (result.notAnObject) {
      return {
        kind: 'unchanged',
        diagnostics: [
          {
            level: 'warn',
            message: 'Claude settings root is not an object; leaving it unchanged',
            fields: { filePath },
          },
        ],
      };
    }
    return result.changed ? { kind: 'replace', content: result.content } : { kind: 'unchanged' };
  },
  mapIoFailure(err, filePath) {
    return {
      level: 'warn',
      message: 'Failed to reconcile Claude settings; leaving them unchanged',
      fields: { filePath, error: err instanceof Error ? err.message : String(err) },
    };
  },
});

registerProviderHostContract('claude', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  modelEndpoints: { api: 'https://api.anthropic.com' },
  modelDomains: ['anthropic.com'],
  projectDocument: {
    fileName: 'CLAUDE.md',
    containerPath: '/workspace/agent/CLAUDE.md',
    mountClass: 'group-state',
  },
  stateVolumes: [
    {
      id: 'claude-home',
      directory: '.claude-shared',
      containerPath: '/home/node/.claude',
      scope: 'group',
      mode: 'rw',
      mountClass: 'group-state',
    },
  ],
  skillBackings: [
    {
      id: 'claude-skills',
      location: { kind: 'state-volume', volumeId: 'claude-home', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'warn',
      // Claude reads the shared-skills store directly — copying template
      // skills onto themselves would delete them (see group-skills.ts's own
      // header). No skillViews needed either: skills already live inside
      // the claude-home state volume, at the exact path Claude expects.
      templateCopies: 'in-place',
    },
  ],
  files: [
    {
      id: 'claude-settings',
      volumeId: 'claude-home',
      relativePath: 'settings.json',
      prepare: { operation: 'create-if-missing', when: 'group-init', content: DEFAULT_SETTINGS_JSON },
      reconcile: { transformer: 'claude-settings' },
    },
  ],
  commands: {
    // Matches command-gate.ts's own former hardcoded sets exactly
    // (Workstream C14 step 6) — command-gate.ts now reads nativeFiltered
    // and the provider-native slice of nativeAdmin from every registered
    // contract instead of hardcoding them. `/clear`/`/upload-trace` are
    // NanoClaw's own commands, not Claude's, so command-gate.ts keeps
    // those two hardcoded rather than listing them here.
    nativeFiltered: ['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control'],
    nativeAdmin: ['/compact', '/context', '/cost', '/files'],
  },
});
