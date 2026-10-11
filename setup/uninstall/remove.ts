/**
 * Removal-plan executor. Each action runs in its own try/catch: a failure
 * becomes a summary note and execution continues (re-running the
 * uninstaller is idempotent — the next scan only finds what's left).
 *
 * Must stay safe to run after logs/ and node_modules/ are gone: only static
 * imports, no dynamic import(), no setup-log writes. Output goes through
 * the injected `log` callback.
 */
import fs from 'fs';
import path from 'path';

import type { RunCommand } from './onecli-agents.js';
import type { RemovalAction } from './plan.js';
import { listProject, projectCleanup } from './scan.js';

export interface ExecDeps {
  runCommand: RunCommand;
  log: (line: string) => void;
  /** True when running as root — required to remove a system-level unit. */
  isRoot: boolean;
}

/** data/ holds the only keys that can ever make an orphaned volume's contents unreadable again. */
function isDataGroupAction(action: RemovalAction): boolean {
  return action.kind === 'backup-env' || (action.kind === 'delete-path' && action.fromDataGroup);
}

export function executePlan(actions: RemovalAction[], deps: ExecDeps): { notes: string[] } {
  const notes: string[] = [];
  // Set when a rm-project-residue in this same run did not fully remove a
  // project: deleting data/'s keys next would make that project's leftover
  // volume permanently unreadable-but-undeletable-by-key, with no way back.
  // Every other action keeps this file's general "log a note and continue"
  // contract — only the data group is held back, and only by this.
  let dataGroupBlocked = false;
  for (const action of actions) {
    if (dataGroupBlocked && isDataGroupAction(action)) {
      notes.push(
        `${action.kind}: skipped — a Compose project above could not be fully removed, so data/ is being kept ` +
          `intact until it is. Fix the issue noted above (or finish its manual command), then re-run the ` +
          `uninstaller to remove data/ for real.`,
      );
      continue;
    }
    try {
      if (runAction(action, deps, notes) === false) dataGroupBlocked = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`${action.kind}: failed (${msg}) — re-run the uninstaller to retry.`);
    }
  }
  return { notes };
}

/**
 * Copy .env aside before deletion. Never clobbers an existing backup —
 * falls back to a timestamped name on collision. Returns the backup path.
 */
export function backupEnv(envPath: string): string {
  const dir = path.dirname(envPath);
  let backup = path.join(dir, '.env.bak');
  if (fs.existsSync(backup)) {
    // Local time (system TZ) — the stamp is read by the human running the
    // uninstall. sv-SE renders "YYYY-MM-DD HH:mm:ss".
    const stamp = new Date()
      .toLocaleString('sv-SE', { hour12: false })
      .replace(/[-:]/g, '')
      .replace(' ', '-')
      .slice(0, 15);
    backup = path.join(dir, `.env.bak.${stamp}`);
  }
  fs.copyFileSync(envPath, backup);
  return backup;
}

/** False only for an rm-project-residue that did not fully remove a project — see isDataGroupAction. */
function runAction(action: RemovalAction, deps: ExecDeps, notes: string[]): boolean {
  const { runCommand, log } = deps;
  switch (action.kind) {
    case 'unload-service':
      switch (action.flavor) {
        case 'launchd':
          runCommand('launchctl', ['unload', action.unitPath]);
          fs.rmSync(action.unitPath, { force: true });
          log('✓ background service removed');
          break;
        case 'systemd-user':
          runCommand('systemctl', ['--user', 'disable', '--now', `${action.unitName}.service`]);
          fs.rmSync(action.unitPath, { force: true });
          runCommand('systemctl', ['--user', 'daemon-reload']);
          log('✓ background service removed');
          break;
        case 'systemd-system':
          if (!deps.isRoot) {
            log('! system service needs root — left in place');
            notes.push(`System service ${action.unitPath} — re-run with sudo to remove.`);
            break;
          }
          runCommand('systemctl', ['disable', '--now', `${action.unitName}.service`]);
          fs.rmSync(action.unitPath, { force: true });
          runCommand('systemctl', ['daemon-reload']);
          log('✓ system service removed');
          break;
      }
      break;
    case 'kill-pid': {
      let pid = NaN;
      try {
        pid = Number(fs.readFileSync(action.pidFile, 'utf-8').trim());
      } catch {
        // pidfile already gone
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
          log('✓ stopped host process');
        } catch {
          // not running
        }
      }
      break;
    }
    case 'pkill-host':
      // Exit 1 = no matching process — not a failure.
      runCommand('pkill', ['-f', action.pattern]);
      break;
    case 'rm-containers': {
      // Re-list at removal time: the host was alive during the confirm
      // phase and may have spawned containers the scan never saw.
      const ps = runCommand(action.runtime, ['ps', '-aq', '--filter', `label=${action.labelFilter}`]);
      if (ps.status !== 0) {
        notes.push(
          `Containers: '${action.runtime}' unavailable — remove later with: ` +
            `${action.runtime} ps -aq --filter label=${action.labelFilter} | xargs -r ${action.runtime} rm -f`,
        );
        break;
      }
      const ids = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) break;
      runCommand(action.runtime, ['rm', '-f', ...ids]);
      log(`✓ removed ${ids.length} container(s)`);
      break;
    }
    case 'rmi': {
      const res = runCommand(action.runtime, ['rmi', action.image]);
      if (res.status === 0) {
        log('✓ removed container image');
      } else {
        log('! could not remove image (in use?)');
        notes.push(`Image ${action.image}: not removed — retry with: ${action.runtime} rmi ${action.image}`);
      }
      break;
    }
    case 'rm-project-residue': {
      const { runtime } = action;
      let volumes = 0;
      let networks = 0;
      let allClean = true;
      for (const project of action.projects) {
        // data/'s keys are kept back when this isn't fully clean — see
        // executePlan's dataGroupBlocked — so the note points at the
        // project directly rather than assuming data/ is already gone.
        const leftover = (what: string) => {
          allClean = false;
          notes.push(`Project ${project}: ${what}. Remove it with: ` + projectCleanup(runtime, project));
        };
        const found = listProject(runCommand, runtime, project);
        if (!found) {
          leftover(`not removed ('${runtime}' unavailable)`);
          continue;
        }
        // Containers first: a declined service group leaves them holding the volumes.
        if (found.containerIds.length > 0 && runCommand(runtime, ['rm', '-f', ...found.containerIds]).status !== 0) {
          leftover('containers not removed');
          continue;
        }
        for (const volume of found.volumes) {
          if (runCommand(runtime, ['volume', 'rm', volume]).status === 0) volumes++;
          else {
            allClean = false;
            notes.push(`Volume ${volume}: not removed (in use?) — retry with: ${runtime} volume rm ${volume}`);
          }
        }
        for (const network of found.networks) {
          if (runCommand(runtime, ['network', 'rm', network]).status === 0) networks++;
          else {
            allClean = false;
            notes.push(`Network ${network}: not removed (in use?) — retry with: ${runtime} network rm ${network}`);
          }
        }
      }
      if (volumes + networks > 0) log(`✓ removed ${volumes} data volume(s) and ${networks} network(s)`);
      return allClean;
    }
    case 'rm-ncl-symlink':
      fs.rmSync(action.linkPath, { force: true });
      log('✓ removed ncl command');
      break;
    case 'delete-onecli-agent': {
      const res = runCommand('onecli', ['agents', 'delete', '--id', action.agent.uuid]);
      if (res.status === 0) {
        log(`✓ deleted OneCLI agent ${action.agent.name} (${action.agent.identifier})`);
      } else if (res.status === null) {
        // spawn failure (binary gone since the scan), not a missing agent
        log(`! couldn't run onecli for ${action.agent.identifier}`);
        notes.push(
          `OneCLI agent ${action.agent.name} (${action.agent.identifier}): couldn't run onecli — ` +
            `delete manually with: onecli agents delete --id ${action.agent.uuid}`,
        );
      } else {
        log(`! OneCLI agent ${action.agent.identifier} already gone`);
      }
      break;
    }
    case 'backup-env': {
      // Backup and removal are one action so a failed backup (which throws
      // into executePlan's catch) can never be followed by the deletion.
      const backup = backupEnv(action.envPath);
      fs.rmSync(action.envPath, { force: true });
      log(`✓ removed .env (backup at ${backup})`);
      break;
    }
    case 'delete-path':
    case 'delete-runtime-path':
      fs.rmSync(action.item.path, { recursive: true, force: true });
      log(`✓ removed ${action.item.what}`);
      break;
  }
  return true;
}
