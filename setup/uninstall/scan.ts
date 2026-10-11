/**
 * Uninstall inventory scan — find every artifact this checkout created.
 *
 * Everything NanoClaw creates is tagged with the per-checkout install slug
 * (sha1(projectRoot)[:8]), so several copies can coexist on one machine.
 * The scan reports ONLY things belonging to the given project root; shared
 * tools (the OneCLI app/vault, shell PATH lines, host-wide config) are
 * never inventoried.
 *
 * External commands (docker, onecli) go through the injected `runCommand`
 * so tests can fake them; filesystem checks are real — tests use temp dirs.
 * A missing/down docker daemon degrades to an empty result plus a note with
 * manual cleanup commands; it never throws.
 *
 * Deliberately does NOT import src/config.ts (import-time side effects).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import {
  listVaultAgents,
  readAgentGroupIds,
  splitVaultAgents,
  type RunCommand,
  type VaultAgent,
} from './onecli-agents.js';

export interface PathItem {
  /** Human label, e.g. "Database & conversations". */
  what: string;
  /** Display location (tilde-abbreviated). */
  where: string;
  /** Absolute path to remove. */
  path: string;
}

export interface ServiceInventory {
  launchdPlist?: string;
  systemdUserUnit?: string;
  systemdSystemUnit?: string;
  pidFile?: string;
  containerIds: string[];
  image?: string;
  nclSymlink?: string;
}

export interface OnecliInventory {
  mine: VaultAgent[];
  orphans: VaultAgent[];
  /** False when agent_groups couldn't be read — orphan labels are then unreliable. */
  idsKnown: boolean;
}

export interface Inventory {
  slug: string;
  projectRoot: string;
  containerRuntime: string;
  service: ServiceInventory;
  /** Group 2: app data, logs & secrets. */
  data: PathItem[];
  /**
   * dist/ + node_modules/ — displayed with the data group but removed dead
   * last: the uninstaller itself runs on tsx out of node_modules.
   */
  runtime: PathItem[];
  /** Group 3: groups/ and store/ — user content, unrecoverable. */
  user: PathItem[];
  onecli: OnecliInventory;
  /**
   * Volumes and networks of the Compose projects this copy's labeled
   * containers belong to; removed with the data group.
   */
  projects?: ProjectInventory;
  notes: string[];
}

export interface ProjectInventory {
  /**
   * Compose project names — from the containers carrying this copy's
   * install label, plus (when this copy ever installed Iron Control)
   * its own deterministic project name, checked directly: Compose stamps
   * its own project label on everything it creates regardless of this
   * fork's own labels, so this also finds an install whose containers
   * predate those labels, or whose database volume survived an earlier
   * containers-only removal.
   */
  names: string[];
  /** Container names; removed with the volumes even when the service group was declined. */
  containers: string[];
  volumes: string[];
  networks: string[];
}

/** The label Compose stamps on every container, volume and network of a project. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface ScanDeps {
  projectRoot: string;
  home: string;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}

export function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function scanInstall(deps: ScanDeps): Inventory {
  const { projectRoot, home, runCommand } = deps;
  const slug = getInstallSlug(projectRoot);
  const containerRuntime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const notes: string[] = [];

  const service = scanService(deps, slug, containerRuntime, notes);
  const projects = scanProjects(runCommand, projectRoot, slug, containerRuntime, notes);

  const data = existingItems(projectRoot, home, [
    { rel: 'data', what: 'Database & conversations' },
    { rel: 'logs', what: 'Logs' },
    { rel: '.env', what: 'Secrets / API keys (.env)', where: 'backed up before removal' },
    { rel: 'start-nanoclaw.sh', what: 'Start script', where: 'start-nanoclaw.sh' },
    { rel: 'nanoclaw.pid', what: 'PID file', where: 'nanoclaw.pid' },
  ]);
  const updates = path.join(path.dirname(projectRoot), '.nanoclaw-updates', slug);
  if (fs.existsSync(updates)) {
    data.push({
      what: 'Update rollback snapshots',
      where: `${tilde(updates, home)}/`,
      path: updates,
    });
  }

  const runtime = existingItems(projectRoot, home, [
    { rel: 'dist', what: 'Build output' },
    { rel: 'node_modules', what: 'Installed dependencies' },
  ]);

  const user = existingItems(projectRoot, home, [
    { rel: 'groups', what: 'Agent memory & files' },
    { rel: 'store', what: 'Migrated data store' },
  ]);

  const onecli = scanOnecli(projectRoot, runCommand, notes);

  return {
    slug,
    projectRoot,
    containerRuntime,
    service,
    data,
    runtime,
    user,
    onecli,
    ...(projects ? { projects } : {}),
    notes,
  };
}

/**
 * Cheap existing-install probe for mid-setup detection: service registration
 * (per-platform) or a central DB. No docker or onecli calls.
 */
export function detectExistingInstall(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, 'data', 'v2.db'))) return true;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`));
  }
  if (process.platform === 'linux') {
    const unit = getSystemdUnit(projectRoot);
    return (
      fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${unit}.service`)) ||
      fs.existsSync(`/etc/systemd/system/${unit}.service`)
    );
  }
  return false;
}

function scanService(deps: ScanDeps, slug: string, containerRuntime: string, notes: string[]): ServiceInventory {
  const { projectRoot, home, platform, runCommand } = deps;
  const service: ServiceInventory = { containerIds: [] };

  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`);
    if (fs.existsSync(plist)) service.launchdPlist = plist;
  } else if (platform === 'linux') {
    const unit = getSystemdUnit(projectRoot);
    const userUnit = path.join(home, '.config', 'systemd', 'user', `${unit}.service`);
    const systemUnit = `/etc/systemd/system/${unit}.service`;
    if (fs.existsSync(userUnit)) service.systemdUserUnit = userUnit;
    if (fs.existsSync(systemUnit)) service.systemdSystemUnit = systemUnit;
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) service.pidFile = pidFile;
  }

  // Container label matches what container-runner.ts stamps at spawn time.
  const installLabel = `nanoclaw-install=${slug}`;
  const image = `${getContainerImageBase(projectRoot)}:latest`;
  let runtimeOk = true;
  try {
    const ps = runCommand(containerRuntime, ['ps', '-aq', '--filter', `label=${installLabel}`]);
    if (ps.status === 0) {
      service.containerIds = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      runtimeOk = false;
    }
  } catch {
    runtimeOk = false;
  }
  if (runtimeOk) {
    try {
      const inspect = runCommand(containerRuntime, ['image', 'inspect', image]);
      if (inspect.status === 0) service.image = image;
    } catch {
      runtimeOk = false;
    }
  }
  if (!runtimeOk) {
    notes.push(
      `Containers/image: '${containerRuntime}' unavailable; remove later with: ` +
        `${containerRuntime} ps -aq --filter label=${installLabel} | xargs -r ${containerRuntime} rm -f; ` +
        `${containerRuntime} rmi ${image}`,
    );
  }

  const link = path.join(home, '.local', 'bin', 'ncl');
  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(link);
  } catch {
    linkStat = null;
  }
  if (linkStat?.isSymbolicLink()) {
    let target = fs.readlinkSync(link);
    if (!path.isAbsolute(target)) {
      target = path.resolve(path.dirname(link), target);
    }
    if (path.resolve(target) === path.join(projectRoot, 'bin', 'ncl')) {
      service.nclSymlink = link;
    } else {
      notes.push(`ncl command ${tilde(link, home)} points to another NanoClaw copy; left untouched.`);
    }
  }

  return service;
}

/** Non-empty trimmed stdout lines, or null when the runtime did not answer. */
function listLines(runCommand: RunCommand, runtime: string, args: string[]): string[] | null {
  let res: { status: number | null; stdout: string };
  try {
    res = runCommand(runtime, args);
  } catch {
    return null;
  }
  if (res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A project's containers, volumes and networks by its Compose label; null when a listing failed. */
export function listProject(
  runCommand: RunCommand,
  runtime: string,
  project: string,
): { containerIds: string[]; containers: string[]; volumes: string[]; networks: string[] } | null {
  const filter = `label=${COMPOSE_PROJECT_LABEL}=${project}`;
  // IDs to remove (a name can be reused between listing and removal), names to show.
  const rows = listLines(runCommand, runtime, ['ps', '-a', '--filter', filter, '--format', '{{.ID}}|{{.Names}}']);
  const volumes = listLines(runCommand, runtime, ['volume', 'ls', '-q', '--filter', filter]);
  const networks = listLines(runCommand, runtime, ['network', 'ls', '--filter', filter, '--format', '{{.Name}}']);
  if (!rows || !volumes || !networks) return null;
  const split = rows.map((row) => row.split('|'));
  return {
    containerIds: split.map(([id]) => id),
    containers: split.map(([id, name = id]) => name),
    volumes,
    networks,
  };
}

/** One pasteable line per project; `;` so an empty listing doesn't skip the rest. */
export function projectCleanup(runtime: string, project: string): string {
  const filter = `--filter label=${COMPOSE_PROJECT_LABEL}=${project}`;
  return (
    `${runtime} ps -aq ${filter} | xargs -r ${runtime} rm -f; ` +
    `${runtime} volume ls -q ${filter} | xargs -r ${runtime} volume rm; ` +
    `${runtime} network ls -q ${filter} | xargs -r ${runtime} network rm`
  );
}

/**
 * Iron Control's own project name, derived the same way `controlPaths()`
 * does (`.claude/skills/add-iron-proxy/scripts/control.ts`) — duplicated as
 * a literal rather than imported, the same deliberate layering choice this
 * fork already makes elsewhere (e.g. `main.go` not importing
 * `provider-contracts/registry.ts`): generic trunk uninstall code must not
 * hard-depend on an optional, skill-installed module that may not exist in
 * this checkout. Checked only when this copy ever installed Iron Control
 * (its session-materials directory exists), so a copy that never ran
 * `/add-iron-proxy` never queries Docker for a project it couldn't have.
 */
function ironControlProjectName(projectRoot: string, slug: string): string | undefined {
  return fs.existsSync(path.join(projectRoot, 'data', 'session-materials', 'iron-control'))
    ? `nanoclaw-iron-control-${slug}`
    : undefined;
}

/**
 * The Compose projects of this copy's labeled containers, plus — exact
 * name, never a broad match — Iron Control's own deterministic project
 * name. A gateway names its project after the install slug, so the project
 * is this copy's alone; a project shared by two copies would be removed
 * with this one.
 *
 * The label-derived names alone miss two real cases: an Iron Control
 * install whose containers predate this fork's `nanoclaw-install` label
 * (never recreated since), and a database volume that outlived its
 * containers (the documented containers-only removal in
 * `.claude/skills/add-iron-proxy/REMOVE.md`, or an earlier service-only
 * uninstall of this same copy). Both are covered by checking Iron
 * Control's deterministic name directly: Docker Compose stamps its own
 * `com.docker.compose.project` label on every container, volume and
 * network it creates, with or without this fork's own labels — so
 * `listProject()`'s exact label filter finds them either way.
 */
function scanProjects(
  runCommand: RunCommand,
  projectRoot: string,
  slug: string,
  runtime: string,
  notes: string[],
): ProjectInventory | undefined {
  const names = listLines(runCommand, runtime, [
    'ps',
    '-a',
    '--filter',
    `label=nanoclaw-install=${slug}`,
    '--format',
    `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
  ]);
  if (!names) {
    notes.push(
      `Service volumes/networks: '${runtime}' unavailable; for each project of this copy's containers ` +
        `(${runtime} ps -a --filter label=nanoclaw-install=${slug} --format '{{.Label "${COMPOSE_PROJECT_LABEL}"}}') ` +
        `remove later with: ${projectCleanup(runtime, '<project>')}`,
    );
    return undefined;
  }
  const ironControl = ironControlProjectName(projectRoot, slug);
  const candidates = [...new Set([...names, ...(ironControl ? [ironControl] : [])])].sort();
  const found: ProjectInventory = { names: [], containers: [], volumes: [], networks: [] };
  for (const project of candidates) {
    const listed = listProject(runCommand, runtime, project);
    if (!listed) {
      notes.push(
        `Project ${project}: '${runtime}' listing failed; remove later with: ${projectCleanup(runtime, project)}`,
      );
      continue;
    }
    // The deterministic candidate may name a project that was never
    // actually created (Iron Control installed, then fully removed by
    // hand) — nothing found for it is not a listing failure.
    if (listed.containers.length === 0 && listed.volumes.length === 0 && listed.networks.length === 0) continue;
    found.names.push(project);
    found.containers.push(...listed.containers);
    found.volumes.push(...listed.volumes);
    found.networks.push(...listed.networks);
  }
  return found.names.length > 0 ? found : undefined;
}

function scanOnecli(projectRoot: string, runCommand: RunCommand, notes: string[]): OnecliInventory {
  const vault = listVaultAgents(runCommand);
  if (!vault.available || vault.agents.length === 0) {
    return { mine: [], orphans: [], idsKnown: false };
  }

  const { ids, known } = readAgentGroupIds(path.join(projectRoot, 'data', 'v2.db'));
  const { mine, orphans } = splitVaultAgents(vault.agents, ids, known);
  if (!known && orphans.length > 0) {
    notes.push(
      "Couldn't read agent_groups from data/v2.db; OneCLI agents shown as 'orphan' may actually belong to this copy.",
    );
  }
  return { mine, orphans, idsKnown: known };
}

function existingItems(
  projectRoot: string,
  home: string,
  specs: { rel: string; what: string; where?: string }[],
): PathItem[] {
  const items: PathItem[] = [];
  for (const spec of specs) {
    const p = path.join(projectRoot, spec.rel);
    if (!fs.existsSync(p)) continue;
    items.push({
      what: spec.what,
      where: spec.where ?? `${tilde(p, home)}/`,
      path: p,
    });
  }
  return items;
}
