/**
 * Docker driver — the permanent OSS/dev realization.
 *
 * Everything an orchestrator-backed driver would get for free (ordering, GC,
 * admission) is done here explicitly, in code. That asymmetry is the point:
 * same spec in, same observable semantics out, different amount of
 * choreography.
 *
 * This file is where `container-runtime.ts`'s helpers and the runtime half of
 * `container-runner.ts` (argv assembly, kill/stop, orphan listing) end up.
 * `container-runner.ts` keeps composition and lifecycle policy only.
 *
 * Network topology note: on Docker the containers of a session do NOT share a
 * network namespace — an auxiliary container's uplink here is a routable bridge, so
 * a netns-join would hand the agent the whole internet and delete the lockdown
 * the private network provides. `capabilities.sharedNetworkNamespace = false`
 * is how an egress overlay learns to address such a container by name here rather
 * than by localhost.
 */
import { createHash } from 'crypto';
import fs from 'fs';

import { log } from '../log.js';
import { KernelClient, KernelError, type KernelClientLike } from '../kernel/client.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import { JsonDocumentStream } from './json-stream.js';
import {
  LABELS,
  asFailureError,
  deniedByPolicy,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type GuardContext,
  type MountPolicy,
  type MountSpec,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

export interface DockerDriverOptions extends MountPolicy {
  cli?: Cli;
  /** Docker network the session's containers attach to, resolved by the overlay. */
  networkArgsFor?: (spec: SessionSpec) => string[];
  /**
   * EC-02 (Phase 9): the client this driver uses for the three privileged
   * operations `internal/kernel` now enforces exclusively (create, destroy,
   * build — see ADR-016). Defaults to a real `KernelClient` against
   * `KERNEL_SOCKET_PATH`; tests inject a fake the same way they already
   * inject `cli`.
   */
  kernelClient?: KernelClientLike;
}

/** Watch reconnection: bounded backoff, never give up (see `watchSessions`). */
const WATCH_RECOVERY_BASE_MS = 1_000;
const WATCH_RECOVERY_MAX_MS = 30_000;

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  attempt: number;
}

export class DockerSessionDriver implements SessionDriver {
  readonly kind = 'docker' as const;
  readonly #cli: Cli;
  readonly #kernelClient: KernelClientLike;
  readonly #policy: MountPolicy;
  /** One `docker events` subscription per install slug — never per session. */
  readonly #watches = new Map<string, InstallWatch>();
  /**
   * Every key this driver ever handed out (prepare or list), per install.
   * `#reconcileWatchGap` hints these on watch reconnect: a `--rm` container
   * that died while the subscription was down is gone from `ps -a` too, so
   * the re-list alone cannot name it — only this registry can.
   */
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();

  constructor(private readonly opts: DockerDriverOptions) {
    this.#cli = opts.cli ?? realCli('docker');
    this.#kernelClient = opts.kernelClient ?? new KernelClient();
    this.#policy = opts;
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false, // mount pinning is enforced in code, not structurally
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      // Realizes the agent container only, and REFUSES specs carrying more —
      // see the role check in `prepare`. Flips only when this driver actually
      // manages auxiliary containers, never before.
      auxiliaryContainers: false,
      // The daemon this driver shells for sessions is the same one
      // buildAgentGroupImage builds against; rebuild-in-place is real here.
      imageBuild: true,
    };
  }

  async ensureReady(): Promise<void> {
    ensureDockerRunning(this.#cli);
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());

    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      // Refusal, not omission. This driver realizes the agent container only,
      // and a spec is a statement of what the session IS — realizing a subset
      // would validate containers that never exist, leaving (say) a dead proxy
      // address in the agent's env to be discovered at first egress instead of
      // here. Composition gates on capabilities().auxiliaryContainers, so this
      // is the backstop for a composer that did not.
      throw specInvalid(
        `docker driver does not manage container role '${extra[0].role}'; ` +
          `auxiliary containers require a driver with capabilities().auxiliaryContainers`,
      );
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    // Predicted locally for the idempotency check below — byte-identical to
    // `internal/kernel`'s own `ContainerName` port (EC-02), so this never
    // drifts from what the kernel actually derives. Discovery/inspection
    // stays a TypeScript-side, read-only responsibility per ADR-016; only
    // the actual create+start is delegated to the kernel below, and the
    // realized handle uses the NAME THE KERNEL RETURNED, never this
    // prediction, once that call succeeds.
    const predictedName = validateRuntimeName(agentContainerName(spec), 'container');

    this.#remember(spec.key);

    // Idempotency on key: an existing live container for this key is the session.
    if (this.#existingSession(predictedName, spec.key)) {
      return new DockerHandle(spec.key, predictedName, this.#cli, null, this.#emit, this.#kernelClient);
    }

    // Composition existsSync-gates mount sources; re-check here so a
    // realization cannot silently invent one (Docker mounts a missing source
    // as a fresh empty directory — see `assertMountSourcesExist`). After the
    // idempotency return: an existing container's mounts are already bound,
    // and a source deleted since must not refuse adoption of a live session.
    assertMountSourcesExist(agent.mounts);

    // Network topology is driver-private: injected at registration (see
    // `drivers/index.ts`), never carried on the spec. EC-02 moves the actual
    // `docker create`+`docker start` behind `internal/kernel` (ADR-016); the
    // network flag becomes kernel STARTUP configuration (the `-docker-network`
    // flag `nanogo serve` reads), not a per-request field here — this driver
    // no longer appends it to an argv it no longer builds. An overlay's
    // `networkArgsFor` is retained on `DockerDriverOptions` for API
    // compatibility and any TS-native realization step that still shells
    // `docker` directly (none does today), but no longer participates in
    // container creation itself.
    let woken: { containerId: string; containerName: string };
    try {
      // No GuardContext here: no real TypeScript call site holds a hold-
      // satisfying grant at wake time (the CLI `restart` command's own wake,
      // via `onDoneCallback`, runs decoupled and asynchronously after the
      // container has already exited — it is not part of the guarded
      // operation; see the restart handler and ADR-015/016). container.kill
      // is where CLIRestartGuardContext actually applies.
      woken = await this.#kernelClient.wake(spec);
    } catch (error) {
      throw translateKernelError(error);
    }
    return new DockerHandle(spec.key, woken.containerName, this.#cli, spec, this.#emit, this.#kernelClient);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    // Adoption contract: reconstruct handles from labels alone. `{{.State}}`
    // rides along because `ps -a` includes exited/created containers, and a
    // caller must be able to tell an adoptable session from a corpse without
    // a per-handle status() round trip.
    let out: string;
    try {
      out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        `label=${LABELS.role}=agent`,
        '--format',
        `{{.Names}}|{{.State}}|{{.Label "${LABELS.group}"}}|{{.Label "${LABELS.session}"}}`,
      ]);
    } catch (error) {
      throw normalizeDockerError(error);
    }
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, state, agentGroupId, sessionId] = line.split('|');
        const key: SessionKey = { installSlug, agentGroupId, sessionId };
        this.#remember(key);
        return {
          handle: new DockerHandle(key, name, this.#cli, null, this.#emit, this.#kernelClient),
          phase: dockerStatePhase(state),
        };
      });
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      // Lazy: the subscription process exists only once someone is listening.
      watch = { subscribers: new Set(), attempt: 0 };
      this.#watches.set(installSlug, watch);
      this.#connectWatch(installSlug, watch);
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
      },
    };
  }

  /**
   * The one driver-level watch: a `docker events` subscription filtered by the
   * install and agent-role labels. Emits best-effort hints for every observed
   * transition — including ends the host itself requested; intent filtering is
   * the session-events hub's job, not this driver's.
   */
  #connectWatch(installSlug: string, watch: InstallWatch, reconnected = false): void {
    const stream = new JsonDocumentStream();
    const proc = this.#cli.start(
      [
        'events',
        '--filter',
        'type=container',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        `label=${LABELS.role}=agent`,
        '--format',
        '{{json .}}',
      ],
      { captureStdout: true },
    );
    proc.onStdout((chunk) => {
      // Data flowing means the subscription is healthy again.
      watch.attempt = 0;
      for (const doc of stream.push(chunk)) {
        const event = dockerEventToSessionEvent(doc, installSlug);
        if (!event) continue;
        for (const subscriber of watch.subscribers) subscriber(event);
      }
    });
    proc.onExit(() => {
      if (this.#watches.get(installSlug) !== watch) return;
      // Bounded backoff, never give up: an unrecovered drop would end
      // supervision for every session of the install at once.
      const delay = Math.min(WATCH_RECOVERY_BASE_MS * 2 ** watch.attempt, WATCH_RECOVERY_MAX_MS);
      watch.attempt += 1;
      const timer = setTimeout(() => this.#connectWatch(installSlug, watch, true), delay);
      timer.unref?.();
    });
    if (reconnected) void this.#reconcileWatchGap(installSlug, watch);
  }

  /**
   * A dropped subscription is a gap: the fresh `docker events` stream starts
   * from now, so a terminal that happened while it was down was never emitted
   * — and for an adopted session the stream is the ONLY terminal source (no
   * attach process backstop). Close the gap with synthetic hints: re-list
   * once, hint every corpse the list shows and every known key it no longer
   * shows (`--rm` already removed it), and let the hub's truth reads sort
   * spurious from real — hints may duplicate, never fire directly. Gated on
   * the re-list succeeding so a daemon that is still down (where inspect
   * cannot tell removed from unreachable) produces no false terminals; that
   * same dead daemon exits the events process too, and the next reconnect
   * retries this.
   */
  async #reconcileWatchGap(installSlug: string, watch: InstallWatch): Promise<void> {
    if (this.#watches.get(installSlug) !== watch) return;
    let snapshots: SessionSnapshot[];
    try {
      snapshots = await this.listSessions(installSlug);
    } catch {
      return;
    }
    const listed = new Set(snapshots.map((s) => keyId(s.handle.key)));
    const gapKeys = snapshots.filter((s) => s.phase === 'terminal').map((s) => s.handle.key);
    for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
      if (!listed.has(id)) gapKeys.push(key);
    }
    for (const key of gapKeys) this.#emit({ key, kind: 'terminal' });
  }

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  /** Handle-observed transitions (the `start --attach` exit) ride the same stream. */
  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  /**
   * Residue a stopped session cannot clean up itself: install-labeled networks
   * whose containers are already gone. `stop()` is full teardown for a live
   * session; this covers a host that died between the two.
   */
  async reapResidue(installSlug: string): Promise<void> {
    // Containers first: an auxiliary container whose host died has no owner left
    // to close it. Only non-running ones — an adopted session's are still serving it.
    try {
      const out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        'status=exited',
        '--filter',
        'status=created',
        '--filter',
        'status=dead',
        '--format',
        '{{.Names}}',
      ]);
      const stale = out.trim().split('\n').filter(Boolean);
      for (const name of stale) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (stale.length > 0) log.info('Removed orphaned containers', { count: stale.length, names: stale });
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }

    // Pre-seam residue: containers spawned before the driver seam carry the
    // install label but not the session label, so `listSessions` cannot see
    // them — they can be neither adopted nor matched to a session. Left alone
    // they would run forever AND race a freshly-named replacement for the same
    // session directory. Stopping them is exactly what the old
    // `cleanupOrphans()` did to every container on every start.
    try {
      const out = this.#cli.run([
        'ps',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        `{{.Names}}|{{.Label "${LABELS.session}"}}`,
      ]);
      const preSeam = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|'))
        .filter(([, sessionId]) => !sessionId)
        .map(([name]) => name);
      for (const name of preSeam) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (preSeam.length > 0) log.info('Stopped pre-seam containers', { count: preSeam.length, names: preSeam });
    } catch (err) {
      log.warn('Failed to clean up pre-seam containers', { err });
    }

    let names: string[] = [];
    try {
      const out = this.#cli.run([
        'network',
        'ls',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        '{{.Name}}',
      ]);
      names = out.trim().split('\n').filter(Boolean);
    } catch (err) {
      log.warn('Failed to list install-owned networks', { err });
      return;
    }
    const removed: string[] = [];
    for (const name of names) {
      try {
        this.#cli.run(['network', 'rm', validateRuntimeName(name, 'network')]);
        removed.push(name);
      } catch {
        /* still in use by a live session, or already gone */
      }
    }
    if (removed.length > 0) log.info('Removed orphaned networks', { count: removed.length, names: removed });
  }

  /**
   * Name-existence alone cannot answer "is this MY session": the name is
   * key-derived, but a foreign container can wear it — another install sharing
   * this daemon whose truncated identity collides, or an operator's hand-made
   * container. Adopting one by name would attach this session to a runtime it
   * does not own, so the canonical labels are verified and a mismatch refuses
   * loudly instead of aliasing.
   */
  #existingSession(name: string, key: SessionKey): boolean {
    let out: string;
    try {
      out = this.#cli.run([
        'inspect',
        '--format',
        `{{index .Config.Labels "${LABELS.install}"}}|{{index .Config.Labels "${LABELS.group}"}}|{{index .Config.Labels "${LABELS.session}"}}`,
        name,
      ]);
    } catch {
      return false;
    }
    const [install, group, session] = out.trim().split('|');
    if (install === key.installSlug && group === key.agentGroupId && session === key.sessionId) return true;
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: { install, group, session },
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

class DockerHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  /** Log hygiene only — events are never intent-filtered here (that is the hub's job). */
  #stopping = false;
  /** Exit code the attach process observed; undefined until it exits. */
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pendingSpec: SessionSpec | null,
    private readonly emit: (event: SessionEvent) => void,
    private readonly kernelClient: KernelClientLike,
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return; // idempotent
    // EC-02 (Phase 9, ADR-016): `internal/kernel`'s Wake already performed
    // `docker create` (the full validated argv) then a plain, non-attached
    // `docker start` — the container this handle names is already running
    // by the time this method runs. `attach`, not `start --attach`: this
    // driver's job is now supervision of an already-live container, not
    // starting it. `--no-stdin` because this attach is for stdout/stderr/
    // exit-code observation only, never interactive input. Exit code and
    // stderr streaming behave identically either way — `docker attach`
    // exits when the container does, exactly as `start --attach` did.
    const proc = this.cli.start(['attach', '--no-stdin', this.name]);
    this.#proc = proc;
    proc.onStderr((line) => {
      log.debug(line, { container: this.name });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
    proc.onExit((code) => {
      this.#attachExitCode = code;
      if (!this.#stopping && code !== 0 && code !== null && this.#stderrTail.length > 0) {
        log.warn('Container exited non-zero', { containerName: this.name, code, stderrTail: this.#stderrTail });
      }
      // Every observed terminal transition rides the driver-level stream —
      // even ends the host requested. Intent filtering is the hub's job.
      this.emit({ key: this.key, kind: 'terminal' });
    });
  }

  async status(): Promise<SessionStatus> {
    let state: string;
    try {
      state = this.cli.run(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', this.name]).trim();
    } catch {
      // `--rm` means an exited container has already been removed; the attach
      // exit code is the only record of how it ended. A host-requested stop is
      // not a failure, whatever code the runtime used to end the process.
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        // The container is gone but the attach process has not exited yet —
        // and that process holds the only record of HOW the session ended. The
        // events stream can outrun it (a 'die' event lands before the attach
        // exit), and concluding 'stopped' here would let the hub spend its
        // at-most-once terminal delivery without the exit code. Report running:
        // the attach exit always emits its own hint, so deferral converges
        // within one process exit.
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const [status, exit] = state.split('|');
    if (status === 'running') return { phase: 'running' };
    if (status === 'created') return { phase: 'ready' };
    if (status === 'exited' && exit !== '0') {
      return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: Number(exit) } };
    }
    return { phase: 'stopped' };
  }

  /**
   * Full teardown. That this blocks until the container is gone is an
   * implementation behavior (it happens to serialize workspace single-writer
   * during termination), not a contract guarantee — see `SessionHandle.stop`.
   *
   * EC-02 (Phase 9, ADR-016): the actual stop-then-remove is delegated to
   * `internal/kernel`'s container.kill, which performs the identical
   * `docker stop -t <grace>` (tolerating failure) then best-effort
   * `docker rm --force` sequence server-side, using grace seconds it
   * recorded at wake time from the validated spec — never re-asserted by
   * this caller. `guard` carries `CLIRestartGuardContext` for the one
   * guarded call site (the CLI `restart` command's agent-actor branch);
   * every other caller passes none, matching today's TypeScript, which
   * never gated those kills either.
   */
  async stop(reason: string, guard?: GuardContext): Promise<void> {
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    try {
      await this.kernelClient.kill(this.key.sessionId, reason, guard);
      return;
    } catch (error) {
      if (error instanceof KernelError && error.code === 'unknown-session') {
        // Named v1 limitation (ADR-016 addendum): the kernel's session
        // registry is in-memory, scoped to one kernel process. If the
        // kernel restarted (e.g. host reboot) while this Docker container
        // kept running, it has no record of a session it did not itself
        // wake — `unknown-session` here does not mean "already gone", it
        // means "this kernel process never heard of it". Falling back to a
        // direct stop/rm is not a new admission bypass: it tears down an
        // ALREADY-EXISTING container by name, which is a fundamentally
        // different operation from a create-time admission decision, and
        // it restores exactly the adoption/crash-recovery resilience the
        // pre-EC-02 driver had.
        log.warn('Kernel has no record of this session (likely a kernel restart) — falling back to direct stop/rm', {
          containerName: this.name,
          sessionId: this.key.sessionId,
        });
        const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
        try {
          this.cli.run(['stop', '-t', grace, this.name]);
        } catch {
          this.#proc?.kill();
        }
        try {
          this.cli.run(['rm', '--force', this.name]);
        } catch {
          /* `--rm` usually got there first */
        }
        return;
      }
      // Any OTHER kernel error (a real denial included) is a genuine
      // failure to surface, never silently worked around locally — falling
      // back here for a 'denied' response would bypass the exact decision
      // this call was meant to re-verify. Kill the attach process so
      // supervision does not hang waiting for an exit that cannot come, and
      // propagate.
      this.#proc?.kill();
      throw error;
    }
  }

  /** `docker exec` against this session's container — see `SessionExecSpec`. */
  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'docker',
      argsTty: ['exec', '-it', this.name, ...command],
      argsPlain: ['exec', '-i', this.name, ...command],
    };
  }
}

/** Collision-proof key identity for driver-internal maps (NUL cannot appear in a key part). */
function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

// ---------- realization helpers (absorbed from container-runtime.ts) ----------

/**
 * `docker ps` state → seam phase. 'created' is prepared-not-started — an
 * adoption-adjacent incarnation, NOT a corpse; treating it as terminal would
 * have adoption tear down freshly-prepared sessions.
 */
export function dockerStatePhase(state: string): SessionPhase {
  if (state === 'running' || state === 'paused' || state === 'restarting') return 'running';
  if (state === 'created') return 'starting';
  // exited, dead, removing — self-ended corpses awaiting cleanup.
  return 'terminal';
}

interface DockerEventDoc {
  Action?: string;
  Actor?: { Attributes?: Record<string, string> };
}

/**
 * One `docker events` document → one best-effort hint, keyed from the labels
 * the event carries (the adoption contract, again: labels are the identity).
 * Unknown actions and label-less events are dropped — hints may drop.
 */
export function dockerEventToSessionEvent(doc: unknown, installSlug: string): SessionEvent | null {
  const event = doc as DockerEventDoc;
  const attrs = event.Actor?.Attributes ?? {};
  const agentGroupId = attrs[LABELS.group];
  const sessionId = attrs[LABELS.session];
  if (!agentGroupId || !sessionId) return null;
  const action = event.Action ?? '';
  const kind =
    action === 'die' || action === 'destroy'
      ? ('terminal' as const)
      : action === 'create' || action === 'start' || action === 'restart'
        ? ('phase' as const)
        : action === 'kill' || action === 'stop' || action === 'oom' || action === 'pause' || action === 'unpause'
          ? ('hint' as const)
          : null;
  if (!kind) return null;
  return { key: { installSlug, agentGroupId, sessionId }, kind };
}

/**
 * Derived from the key, never from a timestamp.
 *
 * `prepare` is idempotent on key, and it cannot be if the name it allocates
 * changes between calls. The install slug is part of the derivation because
 * the daemon is a shared namespace: two peer installs holding the same session
 * id must never alias one runtime object (`#existingSession` verifies labels
 * as the backstop). Over-length identities truncate-then-hash over the FULL
 * identity, so distinct keys that share a 39-byte prefix still get distinct
 * names, deterministically. The human-readable, timestamped name the host used
 * to generate survives as the `nanoclaw-container-name` lineage label.
 */
export function agentContainerName(spec: SessionSpec): string {
  const raw = `${spec.key.installSlug}-${spec.key.sessionId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, '-');
  if (raw.length <= 48) return `ncl-${raw}`;
  const hash = createHash('sha256').update(`${spec.key.installSlug} ${spec.key.sessionId}`).digest('hex').slice(0, 8);
  return `ncl-${raw.slice(0, 39)}-${hash}`;
}

// EC-02 (Phase 9, ADR-016) removed this file's own `hardeningArgs`/
// `resourceArgs`/`userArgs`/`mountArgs`/`envArgs`/`labelArgs` — the argv this
// driver used to build for `docker create` is now built inside
// `internal/kernel`'s `exec.go` (ported field-for-field: `containerdefaults.
// HardeningPosture`/`ResourceArgs`/`PidsLimitArg`/`UserArgs`, and `kernel`'s
// own `mountArgs`/`envArgs`/`labelArgs`), which is the only place that ever
// actually runs `docker create` now. Keeping a second, unexercised copy here
// would drift from the Go source of truth silently; the Go side carries its
// own tests for this logic (`internal/kernel/kernel_test.go`,
// `internal/containerdefaults`'s own test file).

/**
 * Translates a `KernelClient` failure into this driver's own `SessionFailure`
 * vocabulary — the one place EC-02's wire-level `KernelError` meets the
 * pre-existing `specInvalid`/`deniedByPolicy`/`asFailureError`/
 * `normalizeDockerError` seam, so every OTHER call site in this file (and in
 * `container-runner.ts`) keeps seeing exactly the failure shapes it always
 * has, whether the underlying operation ran via a direct CLI call or via the
 * kernel.
 */
export function translateKernelError(error: unknown): Error & SessionFailure {
  if (error instanceof KernelError) {
    switch (error.code) {
      case 'spec-invalid':
        return specInvalid(error.detail);
      case 'denied':
        return deniedByPolicy(error.detail);
      case 'exec-failed':
        // Reuse the existing message-pattern classifier so a kernel-mediated
        // wake failure is normalized exactly as a direct-CLI one always was
        // (image-unavailable / runtime-unavailable / resources-exhausted /
        // unknown) — the Go kernel's ErrExecFailed Detail carries the same
        // raw `docker create`/`docker build` stderr text this classifier was
        // written against.
        return normalizeDockerError(new Error(error.detail));
      default:
        // unknown-session, malformed-payload, unknown-op, unsupported-version,
        // unknown-capability: none of these are a wake-time outcome a caller
        // can act on specifically (unknown-session applies to kill, and the
        // rest are wire-contract bugs, not runtime states) — reported as
        // 'unknown' exactly like an unrecognized direct-CLI error.
        return asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `kernel-${error.code}-${Date.now()}` });
    }
  }
  // The kernel process itself is unreachable (not running, socket missing,
  // connection dropped) — a runtime dependency failure, not an admission
  // decision, so this is retryable like a downed Docker daemon.
  return asFailureError({ kind: 'runtime-unavailable', retryable: true });
}

export function normalizeDockerError(error: unknown): Error & SessionFailure {
  const msg = error instanceof Error ? error.message : String(error);
  const failure: SessionFailure = /manifest unknown|pull access denied|not found: manifest|No such image/i.test(msg)
    ? { kind: 'image-unavailable', retryable: true }
    : /Cannot connect to the Docker daemon|daemon is not running/i.test(msg)
      ? { kind: 'runtime-unavailable', retryable: true }
      : /no space left|cannot allocate memory/i.test(msg)
        ? { kind: 'resources-exhausted', retryable: true }
        : // Raw runtime errors never cross the seam.
          { kind: 'unknown', retryable: false, opaqueRef: `docker-${Date.now()}` };
  return asFailureError(failure);
}

/**
 * Docker mounts a missing hostPath as a fresh empty directory, which silently
 * turns a typo'd file mount into an empty dir inside the container. Composition
 * already existsSync-gates these; the driver re-checks so a realization
 * cannot silently invent a mount source that composition never saw.
 */
export function assertMountSourcesExist(mounts: readonly MountSpec[]): void {
  for (const mount of mounts) {
    if (!fs.existsSync(mount.hostPath)) {
      throw asFailureError({
        kind: 'spec-invalid',
        retryable: false,
        detail: `mount source missing: ${mount.hostPath}`,
      });
    }
  }
}

/** Ensure the container runtime is reachable. Fatal at startup — agents cannot run without it. */
export function ensureDockerRunning(cli: Cli = realCli('docker')): void {
  try {
    cli.run(['info'], { timeoutMs: 10_000 });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}

export type { ContainerSpec };
