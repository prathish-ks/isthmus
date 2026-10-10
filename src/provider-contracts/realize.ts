/**
 * Realize a declared provider host contract: create state-volume
 * directories, prepare/reconcile files, resolve skill-backing paths, and
 * compose the project document — the group-init- and spawn-time work
 * `container-runner.ts`'s `buildMounts` depends on before it can turn a
 * contract into mounts.
 *
 * v2.4.0 promotion, Workstream C14 (provider-host-contract mount-composition
 * rewrite), step 2/6.
 *
 * Deliberate divergence from upstream, not an oversight, now superseded by a
 * stronger fix: upstream imports `writeAtomic` from
 * `migrate-claude-memory-settings.ts`, which is safe there only because that
 * file runs once at startup, before any container exists to race against.
 * This module's file writes/reconciliation land in the same agent-writable
 * provider state-volume tree `project-doc-compose.ts`'s own `writeAtomic`
 * was written to protect (LOAD-BEARING comment on that function) — group-
 * scoped state volumes are shared across a group's sessions and mounted
 * read-write into every one of them, so a later group-init pass reconciling
 * an existing file can race a live container's write access to the same
 * directory. `AnchoredDir` closes that race directly (symlink-refused
 * descriptor I/O, not just an atomic rename), so this module no longer
 * needs `project-doc-compose.ts`'s own `writeAtomic` at all.
 */
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from '../anchored-dir.js';
import { DATA_DIR } from '../config.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { BASE_INSTRUCTIONS_PATH, type ProjectDocSpec } from '../project-doc-compose.js';
import type { ProviderContainerContribution } from '../providers/provider-container-registry.js';

import {
  describeRegisteredProviderFileTransformers,
  getProviderFileTransformer,
  type ProviderFileDiagnostic,
  type ProviderFileTransformer,
} from './file-transformers.js';
import {
  type ProviderFileTransformerId,
  type ProviderHostContract,
  type ProviderPreparedFile,
  type ProviderSkillBacking,
  type ProviderSkillBackingLocation,
  type ProviderStateVolume,
} from './registry.js';

/**
 * The host file a contract's project document is rendered from. Every
 * contract renders from core's canonical instruction template; a contract
 * declares facts for it, never a document of its own.
 */
export function providerDocumentSourcePath(projectRoot: string, contract: ProviderHostContract): string | undefined {
  if (contract.projectDocument === undefined) return undefined;
  // False positive: `BASE_INSTRUCTIONS_PATH` is a module-level literal
  // (project-doc-compose.ts), never runtime/agent input; `projectRoot` is
  // this process's own root, passed by callers, not derived from a request.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH);
}

// Core-owned: the canonical instruction template is protected unconditionally;
// no provider contract switches this on or off.
export function protectedProviderDocumentSourcePaths(projectRoot: string): string[] {
  // False positive: same as providerDocumentSourcePath above — both operands
  // are fixed, never agent/runtime input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return [path.resolve(projectRoot, BASE_INSTRUCTIONS_PATH)];
}

export function providerProjectDocSpec(contract: ProviderHostContract): ProjectDocSpec | undefined {
  if (contract.projectDocument === undefined) return undefined;
  const { fileName, instructions, maxBytes } = contract.projectDocument;
  return {
    fileName,
    ...(instructions ? { instructions } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

export function providerStateVolumePath(
  volume: ProviderStateVolume,
  agentGroupId: string,
  sessionDirectory?: string,
): string {
  return resolveWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), volume.directory);
}

function providerStateVolumeRoot(volume: ProviderStateVolume, agentGroupId: string, sessionDirectory?: string): string {
  if (volume.scope === 'session') {
    if (!sessionDirectory) throw new Error(`Session directory required for provider state volume '${volume.id}'`);
    // False positive: `sessionDirectory` is host-constructed (session-manager's
    // own `data/v2-sessions/<group>/<session>` path), never raw request input.
    // This function only builds the trusted ROOT other code resolves untrusted
    // segments against via `resolveWithinRoot` below — it is the containment
    // boundary itself, not something that needs one.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return path.resolve(sessionDirectory);
  }
  // False positive: same rationale — `DATA_DIR` is a fixed constant and
  // `agentGroupId` is a host-generated id (`ag-<timestamp>-<random>`), not
  // free-form external input; this is the root, not the untrusted segment.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return path.resolve(DATA_DIR, 'v2-sessions', agentGroupId);
}

/** Realize the group-lifetime portion of a declared provider contract. */
export function initializeProviderGroupSurfaces(
  provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
): string[] {
  const stateVolumes = contract.stateVolumes ?? [];
  const skillBackings = contract.skillBackings ?? [];
  const files = contract.files ?? [];
  const initialized: string[] = [];
  const volumes = new Map(stateVolumes.map((volume) => [volume.id, volume]));

  for (const volume of stateVolumes) {
    if (volume.scope !== 'group') continue;
    const hostPath = providerStateVolumePath(volume, agentGroupId);
    const existed = fs.existsSync(hostPath);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId), hostPath);
    if (!existed) initialized.push(volume.directory);
  }

  for (const file of files) {
    if (file.prepare.when === 'group-init') initializeFile(provider, file, volumes, agentGroupId, initialized);
  }

  for (const backing of skillBackings) {
    if (backing.location.kind === 'state-volume') {
      const volume = volumes.get(backing.location.volumeId);
      if (!volume) throw new Error(`Provider skill backing references unknown volume '${backing.location.volumeId}'`);
      if (volume.scope !== 'group') continue;
    }
    const skillsPath = providerSkillDirectory(backing, volumes, agentGroupId, groupDir);
    const existed = fs.existsSync(skillsPath);
    ensureDirectoryWithinRoot(
      skillBackingContainmentRoot(backing.location, volumes, agentGroupId, groupDir),
      skillsPath,
    );
    if (!existed) initialized.push(`${path.basename(skillsPath)}/`);
  }

  return initialized;
}

export interface ProviderSpawnRealization {
  skillBackingPaths: Map<string, string>;
  contribution: ProviderContainerContribution;
}

/** Realize every-spawn provider surfaces in the order derived from their resources. */
export async function realizeProviderSpawnSurfaces(
  _provider: string,
  contract: ProviderHostContract,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory: string,
  selectedSkills: readonly string[],
  actions: {
    legacyOverlay: () => Promise<ProviderContainerContribution>;
    composeProjectDocument: (spec: ProjectDocSpec) => Promise<void>;
  },
): Promise<ProviderSpawnRealization> {
  const stateVolumes = contract.stateVolumes ?? [];
  const skillBackings = contract.skillBackings ?? [];
  const files = contract.files ?? [];
  const volumes = new Map(stateVolumes.map((volume) => [volume.id, volume]));
  const paths = new Map<string, string>();
  // A registered legacy adapter still contributes env exactly as before this
  // contract existed; only its mounts are dropped, since core now realizes
  // every declared surface. Nothing in the contract switches this on or off.
  const overlay = await actions.legacyOverlay();
  const contribution: ProviderContainerContribution = overlay.env ? { env: overlay.env } : {};

  for (const volume of stateVolumes) {
    const hostPath = providerStateVolumePath(volume, agentGroupId, sessionDirectory);
    ensureDirectoryWithinRoot(providerStateVolumeRoot(volume, agentGroupId, sessionDirectory), hostPath);
  }

  for (const file of files) {
    if (file.prepare.when === 'every-spawn') prepareSpawnFile(file, volumes, agentGroupId, sessionDirectory);
  }

  for (const backing of skillBackings) {
    const backingRoot = skillBackingPath(backing.location, volumes, agentGroupId, groupDir, sessionDirectory);
    const skillsPath = resolveWithinRoot(backingRoot, backing.skillsSubdirectory);
    paths.set(backing.id, backingRoot);
    // Anchor at the host-owned base (the group's parent / the volume root),
    // never at an intermediate the container can swap, then treat every
    // component below it as untrusted. A state volume's own `directory` sits
    // inside a writable mount, so it is a segment here, not the root.
    const anchorRoot = skillBackingAnchorRoot(backing.location, volumes, agentGroupId, groupDir, sessionDirectory);
    const segments = segmentsWithinRoot(anchorRoot, skillsPath);
    const linked = syncSharedSkillLinks(anchorRoot, segments, selectedSkills, backing.conflictDiagnostics === 'warn');
    if (linked && backing.templateCopies === 'copy') {
      materializeTemplateSkills(agentGroupId, anchorRoot, segments);
    }
  }

  const spec = providerProjectDocSpec(contract);
  if (spec) await actions.composeProjectDocument(spec);

  return { skillBackingPaths: paths, contribution };
}

function initializeFile(
  provider: string,
  file: ProviderPreparedFile,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  initialized: string[],
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  const root = providerStateVolumeRoot(volume, agentGroupId);
  const filePath = resolveWithinRoot(providerStateVolumePath(volume, agentGroupId), file.relativePath);
  // The volume is a read-write mount, so every name below `root` belongs to
  // the container: the file is reached through its directory's descriptor and
  // a symlink or FIFO planted under its name is refused, never followed.
  const name = path.basename(filePath);
  let dir: AnchoredDir | null;
  try {
    dir = AnchoredDir.open(root, segmentsWithinRoot(root, path.dirname(filePath)));
  } catch (err) {
    log.warn('Provider file not prepared: unsafe directory', { path: filePath, err });
    return;
  }
  if (!dir) {
    log.warn('Provider file not prepared: directory missing', { path: filePath });
    return;
  }
  try {
    let present = true;
    try {
      dir.lstat(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      present = false;
    }
    if (!present) {
      if (file.prepare.operation !== 'create-if-missing') return;
      try {
        dir.writeNewFile(name, Buffer.from(file.prepare.content));
      } catch (err) {
        // Something took the name since the lstat; it is the container's entry, not ours.
        log.warn('Provider file not prepared: unsafe entry', { path: filePath, err });
        return;
      }
      initialized.push(file.relativePath);
      return;
    }
    // Reconciliation runs at the moment the file is prepared, so the prepare
    // variant is the only schedule there is.
    if (file.reconcile === undefined || file.prepare.when !== 'group-init') return;
    const transformerProvider = file.reconcile.transformerProvider ?? provider;
    const transformer = providerFileTransformer(file.reconcile.transformer);
    try {
      const result = transformer.transform(dir.readFile(name).toString('utf-8'), filePath);
      emitDiagnostics(result.diagnostics);
      if (result.kind === 'replace') {
        dir.replaceFile(name, result.content);
        initialized.push(`${file.relativePath} (reconciled ${providerName(transformerProvider)} settings)`);
      }
    } catch (err) {
      emitDiagnostic(transformer.mapIoFailure(err, filePath));
    }
  } finally {
    dir.close();
  }
}

function providerFileTransformer(name: ProviderFileTransformerId): ProviderFileTransformer {
  const transformer = getProviderFileTransformer(name);
  if (transformer === undefined) {
    throw new Error(
      `Unknown provider file transformer '${name}'; registered transformers: ${describeRegisteredProviderFileTransformers()}`,
    );
  }
  return transformer;
}

function prepareSpawnFile(
  file: ProviderPreparedFile,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  sessionDirectory: string,
): void {
  const volume = volumes.get(file.volumeId);
  if (!volume) throw new Error(`Provider prepared file references unknown volume '${file.volumeId}'`);
  // Lexically validated at contract-registration time (assertRelativePath),
  // but the volume is agent-writable, so an intermediate segment could be
  // swapped for a symlink between that check and this call — resolve it by
  // descriptor, not by path string, same as every other agent-writable mount
  // in this file. `root` must be `providerStateVolumeRoot`, not
  // `providerStateVolumePath`: the latter already has `volume.directory`
  // baked in, and AnchoredDir.open's own root argument is host-owned by
  // design (opened without O_NOFOLLOW) — passing a volume path there would
  // leave `volume.directory` itself unprotected, exactly the segment this
  // comment above says is agent-writable. Every untrusted segment, including
  // `volume.directory`, must instead be walked through AnchoredDir's
  // protected traversal, matching initializeFile's own pattern above.
  if (file.prepare.operation === 'append-open-close') {
    const root = providerStateVolumeRoot(volume, agentGroupId, sessionDirectory);
    const filePath = resolveWithinRoot(
      providerStateVolumePath(volume, agentGroupId, sessionDirectory),
      file.relativePath,
    );
    const dir = AnchoredDir.open(root, segmentsWithinRoot(root, path.dirname(filePath)), true);
    if (!dir) throw new Error(`Provider prepared file directory is missing: '${filePath}'`);
    try {
      dir.appendFile(path.basename(filePath), new Uint8Array(0));
    } finally {
      dir.close();
    }
  }
}

function providerSkillDirectory(
  backing: ProviderSkillBacking,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
): string {
  return resolveWithinRoot(
    skillBackingPath(backing.location, volumes, agentGroupId, groupDir),
    backing.skillsSubdirectory,
  );
}

function skillBackingPath(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  if (location.kind === 'group-directory') {
    return resolveWithinRoot(groupDir, location.directory, location.subdirectory);
  }
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return resolveWithinRoot(providerStateVolumePath(volume, agentGroupId, sessionDirectory), location.subdirectory);
}

function skillBackingContainmentRoot(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  // False positive: `groupDir` is the host-constructed group folder path
  // (container-runner.ts), never raw external input — this returns a
  // trusted root for `resolveWithinRoot` to check untrusted segments
  // against, same disposition as this project's other
  // path-join-resolve-traversal false positives (see .github/workflows/
  // ci.yml's semgrep-scope comment).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  if (location.kind === 'group-directory') return path.resolve(groupDir);
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return providerStateVolumePath(volume, agentGroupId, sessionDirectory);
}

/**
 * The host-owned directory the skills sync anchors to: a dir the container
 * cannot swap, so AnchoredDir can safely follow it as a root and treat every
 * component below as untrusted. The group's entry (its parent is unmounted)
 * and the state-volume root (`data/v2-sessions/<group>` or the session dir)
 * both qualify; the volume's own `directory` does not — it lives inside a
 * writable mount — so it becomes a path segment, not the anchor.
 */
function skillBackingAnchorRoot(
  location: ProviderSkillBackingLocation,
  volumes: ReadonlyMap<string, ProviderStateVolume>,
  agentGroupId: string,
  groupDir: string,
  sessionDirectory?: string,
): string {
  // False positive: `groupDir` is the host-resolved group directory the
  // caller already computed, never external input. Same disposition as this
  // project's other path-join-resolve-traversal false positives (see
  // .github/workflows/ci.yml's semgrep-scope comment).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  if (location.kind === 'group-directory') return path.resolve(groupDir);
  const volume = volumes.get(location.volumeId);
  if (!volume) throw new Error(`Provider skill backing references unknown volume '${location.volumeId}'`);
  return providerStateVolumeRoot(volume, agentGroupId, sessionDirectory);
}

/**
 * Reconcile the shared-skill symlinks in `root/segments...`: drop links no
 * longer selected, add missing ones pointing at the container's /app/skills.
 * Also the body of the legacy Claude path (`syncSkillSymlinks` in
 * container-runner.ts).
 *
 * `root` is a mount point and every name below it belongs to the container,
 * so the skills dir is opened as an AnchoredDir. A symlinked component is
 * refused with a warning and nothing is synced: returns false.
 */
export function syncSharedSkillLinks(
  root: string,
  segments: readonly string[],
  desiredSkills: readonly string[],
  warnOnConflict: boolean,
): boolean {
  // False positive: `skillsPath` is only ever used in log messages below —
  // the real access goes through AnchoredDir.open(root, segments, true)
  // (descriptor-guarded, symlinks refused) right after. Same disposition as
  // this project's other path-join-resolve-traversal false positives (see
  // .github/workflows/ci.yml's semgrep-scope comment).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const skillsPath = path.join(root, ...segments);
  let skillsDir: AnchoredDir | null;
  try {
    skillsDir = AnchoredDir.open(root, segments, true);
  } catch (err) {
    log.warn('Shared skills not synced: unsafe skills directory', { path: skillsPath, err });
    return false;
  }
  if (!skillsDir) return false;

  try {
    const desired = new Set(desiredSkills);
    for (const entry of skillsDir.entries()) {
      let isSymlink = false;
      try {
        isSymlink = skillsDir.lstat(entry).isSymbolicLink();
      } catch {
        continue;
      }
      if (isSymlink && !desired.has(entry)) skillsDir.unlink(entry);
    }

    for (const skill of desiredSkills) {
      let entry: fs.Stats | undefined;
      try {
        entry = skillsDir.lstat(skill);
      } catch {
        /* missing */
      }
      if (!entry) {
        skillsDir.symlink(`/app/skills/${skill}`, skill);
      } else if (!entry.isSymbolicLink() && warnOnConflict) {
        log.warn(
          'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
          // False positive: log-message-only path, same reasoning as
          // `skillsPath` above. Same disposition as this project's other
          // path-join-resolve-traversal false positives (see
          // .github/workflows/ci.yml's semgrep-scope comment).
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
          { skill, path: path.join(skillsPath, skill) },
        );
      }
    }
  } finally {
    skillsDir.close();
  }
  return true;
}

/** `directory` as path segments below `root`; throws if it lexically escapes. */
function segmentsWithinRoot(root: string, directory: string): string[] {
  // False positive: this line IS the containment-guard computation —
  // `relative` is passed to resolveWithinRoot immediately below, which
  // throws on any lexical escape. Same disposition as this project's other
  // path-join-resolve-traversal false positives (see
  // .github/workflows/ci.yml's semgrep-scope comment).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  resolveWithinRoot(root, relative);
  return relative.split(path.sep).filter(Boolean);
}

// False positive on both calls below: this IS the containment check
// (mirrors Go's `underRoot` pattern) — it resolves both paths, then
// explicitly rejects anything that escapes `resolvedRoot` a few lines down,
// rather than being an unguarded join/resolve the rule should flag.
function resolveWithinRoot(root: string, ...segments: string[]): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolvedRoot = path.resolve(root);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolved = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Provider contract path escapes its resolved root: '${segments.join('/')}'`);
  }
  return resolved;
}

function ensureDirectoryWithinRoot(root: string, directory: string): void {
  // Lexical containment only: like the legacy path, symlinks placed by the
  // operator (relocated state) are followed, not rejected. The spawn-time
  // skills sync is the exception: it refuses them (syncSharedSkillLinks).
  // False positive: the two `path.resolve` calls below feed straight into
  // `resolveWithinRoot`'s own containment check, same as its callers above.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  resolveWithinRoot(root, path.relative(path.resolve(root), path.resolve(directory)));
  fs.mkdirSync(directory, { recursive: true });
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
}

function providerName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
