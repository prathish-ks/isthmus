// Package lifecycle ports P4-03's "container lifecycle management" scope:
// the already-running / start / stop / timeout / cancellation / cleanup
// decision logic that sits ABOVE the actual driver call
// (docker-driver.ts/session-events.ts), not the driver call itself.
//
// container-runner.ts's three Docker-facing functions (wakeContainer,
// buildAgentGroupImage, killContainer) are P1-04's threat-model target and
// docs/design-laws.md's LAW-07/OBJ-04 annotation is explicit that moving the
// actual execution authority behind Go is a later, more deliberate Phase 5
// security-kernel step, not this task's job. What this package ports instead
// is the lifecycle bookkeeping and decision logic that today lives in the
// SAME TypeScript process as that authority, but is itself policy-free and
// mechanism-shaped — mirroring the P4-01/P4-02 pattern of taking the actual
// side-effecting operation (spawning a container, reading a heartbeat file,
// touching the DB) as a caller-supplied value or function, and owning only
// the decision/dedup/bookkeeping logic around it:
//
//   - src/container-runner.ts: wakeContainer's already-running/in-flight-wake
//     dedup (lines 134-155, ported as Registry.Wake); ActiveSessionRuntime's
//     bookkeeping fields (lines 74-100, ported as Runtime); registerRuntime
//     (lines 277-299, ported as Registry.Register); finishAndResolve's
//     single-shot finalize guard (lines 302-311, ported as
//     Runtime.MarkFinished); killContainer's exit-callback/stop-reason
//     registration (lines 349-371, ported as Runtime.AddExitCallback/
//     SetStopReason); adoptRunningSessions' per-snapshot adopt-vs-stop
//     decision (lines 394-404, ported as DecideAdoption).
//   - src/host-sweep.ts: decideStuckAction (lines 63-109, ported verbatim as
//     DecideStuckAction — already a pure function in the TS source, and
//     docs/host-decomposition.md already names it a strong Go-kernel
//     candidate for exactly that reason); shouldCloseTaskSession (lines
//     161-167, ported as ShouldCloseTaskSession); the per-message retry-vs-
//     fail branch inside resetStuckProcessingRows (lines 305-340, ported as
//     DecideRetry).
//
// What is deliberately NOT here, because it is either a customization hook,
// DB/filesystem I/O, or the actual Docker-facing authority itself: reading
// the heartbeat file's mtime or a session's container_state row (the
// caller's job — this package takes already-read values); the mailbox
// maintenance sweep (scheduling recurrence, cross-session-echo pruning,
// approvals-reason sweep — separate, unrelated modules threaded through
// host-sweep.ts's sweepSession/maintainSessionMailbox); the actual driver
// prepare()/start()/stop() calls and the SessionEventsHub's at-most-once
// terminal-verification machinery (drivers/session-events.ts) — a strong Go
// candidate in its own right, but one that requires owning the real driver
// watch-stream/status() round trip, which stays out of scope until Go
// itself holds spawn authority (Phase 5); buildAgentGroupImage (image
// building is a separate, Docker-CLI-shelling concern container-runner.ts
// itself notes is "not on the runtime path").
package lifecycle

import (
	"context"
	"sync"

	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// Thresholds mirroring host-sweep.ts's own top-level constants (lines 42-51).
// AbsoluteCeilingMs, ClaimStuckMs, MaxTries, and BackoffBaseMs are exported so
// a caller assembling the real inputs (heartbeat mtimes, retry counts) can
// reconstruct the exact same schedule without hand-copying the numbers.
const (
	AbsoluteCeilingMs int64 = 30 * 60 * 1000
	ClaimStuckMs      int64 = 60 * 1000
	MaxTries          int   = 5
	BackoffBaseMs     int64 = 5000
)

// ContainerState is the subset of the container_state row decideStuckAction
// actually reads (host-sweep.ts's bashTimeoutMs, lines 254-257) — currently
// running tool and its declared timeout. A nil *ContainerState means no row
// (never wrote one, or a driver that doesn't track it).
type ContainerState struct {
	CurrentTool           string
	ToolDeclaredTimeoutMs int64
}

// Claim is one row from outbound.db's processing_ack table, as
// decideStuckAction consumes it (host-sweep.ts's `claims` parameter).
type Claim struct {
	MessageID     string
	StatusChanged string // canonical timestamp string, as written by the host
}

// StuckAction is decideStuckAction's verdict.
type StuckAction int

const (
	// StuckOK means no claim or heartbeat has exceeded its tolerance —
	// nothing to do.
	StuckOK StuckAction = iota
	// StuckKillCeiling means the heartbeat age exceeded the absolute
	// ceiling — kill regardless of any in-flight claim.
	StuckKillCeiling
	// StuckKillClaim means a specific claim's age exceeded its tolerance
	// while the heartbeat itself did not — kill for that claim.
	StuckKillClaim
)

// StuckDecision mirrors host-sweep.ts's StuckDecision union (lines 53-56).
// Only the fields relevant to Action are meaningful.
type StuckDecision struct {
	Action StuckAction

	// Set when Action == StuckKillCeiling.
	HeartbeatAgeMs int64
	CeilingMs      int64

	// Set when Action == StuckKillClaim.
	MessageID   string
	ClaimAgeMs  int64
	ToleranceMs int64
}

// DecideStuckAction is a verbatim port of host-sweep.ts's decideStuckAction
// (lines 63-109) — see that function's own doc comment for the full
// reasoning behind the heartbeat-vs-spawn-time fallback and the two-tier
// ceiling/claim-tolerance check. now, heartbeatMtimeMs, and
// containerStartedAtMs are all Unix milliseconds, matching Date.now()/
// fs.statSync(...).mtimeMs's units directly; heartbeatMtimeMs is 0 when no
// heartbeat file exists yet, exactly as the TS caller passes it.
//
// One documented divergence: each claim's StatusChanged is parsed with
// internal/mailbox.ParseTimestamp (this Go host's canonical, strict
// timestamp format — the same one every other package in this module uses)
// rather than JavaScript's lenient Date.parse. In production every
// StatusChanged value was itself written by the host in canonical form, so
// this is not expected to change behavior on real data; it only means an
// adversarial or corrupted timestamp string that Date.parse would loosely
// accept and Go's strict parser would reject is treated as unparseable here
// (the claim is skipped, exactly as decideStuckAction's own
// `Number.isNaN(claimedAt)` branch already does for a genuinely unparseable
// string) — a stricter, not looser, failure mode.
func DecideStuckAction(
	now int64,
	heartbeatMtimeMs int64,
	containerStartedAtMs *int64,
	containerState *ContainerState,
	claims []Claim,
) StuckDecision {
	var declaredBashMs int64
	if containerState != nil && containerState.CurrentTool == "Bash" {
		declaredBashMs = containerState.ToolDeclaredTimeoutMs
	}

	effectiveHeartbeatMs := heartbeatMtimeMs
	if effectiveHeartbeatMs == 0 && containerStartedAtMs != nil {
		effectiveHeartbeatMs = *containerStartedAtMs
	}
	if effectiveHeartbeatMs != 0 {
		heartbeatAge := now - effectiveHeartbeatMs
		ceiling := AbsoluteCeilingMs
		if declaredBashMs > ceiling {
			ceiling = declaredBashMs
		}
		if heartbeatAge > ceiling {
			return StuckDecision{Action: StuckKillCeiling, HeartbeatAgeMs: heartbeatAge, CeilingMs: ceiling}
		}
	}

	tolerance := ClaimStuckMs
	if declaredBashMs > tolerance {
		tolerance = declaredBashMs
	}
	for _, c := range claims {
		claimedAt, err := mailbox.ParseTimestamp(c.StatusChanged)
		if err != nil {
			continue
		}
		claimedAtMs := claimedAt.UnixMilli()
		claimAge := now - claimedAtMs
		if claimAge <= tolerance {
			continue
		}
		if heartbeatMtimeMs > claimedAtMs {
			continue
		}
		return StuckDecision{Action: StuckKillClaim, MessageID: c.MessageID, ClaimAgeMs: claimAge, ToleranceMs: tolerance}
	}

	return StuckDecision{Action: StuckOK}
}

// ShouldCloseTaskSession is a verbatim port of host-sweep.ts's
// shouldCloseTaskSession (lines 161-167): a per-task session with no live
// tasks and no running container is spent and should be closed.
func ShouldCloseTaskSession(threadID *string, containerRunning bool, liveTaskCount int) bool {
	return session.IsTaskThread(threadID) && !containerRunning && liveTaskCount == 0
}

// RetryOutcome is DecideRetry's verdict.
type RetryOutcome int

const (
	// RetrySkip means the message is already rescheduled for a future
	// retry (process_after is still ahead of now) — leave it alone
	// entirely. Mirrors host-sweep.ts:320's `if (msg.processAfter && ...
	// > now) continue;` skip, which neither bumps tries nor touches the
	// row.
	RetrySkip RetryOutcome = iota
	// RetryFailed means tries has reached MaxTries — mark the message
	// permanently failed (host-sweep.ts:322-328).
	RetryFailed
	// RetryBackoff means reschedule with exponential backoff
	// (host-sweep.ts:329-338).
	RetryBackoff
)

// RetryDecision mirrors resetStuckProcessingRows' per-message branch
// (host-sweep.ts:313-339).
type RetryDecision struct {
	Outcome RetryOutcome
	// Set when Outcome == RetryBackoff: BackoffBaseMs * 2^tries, in whole
	// seconds (host-sweep.ts:330-331's `Math.floor(backoffMs / 1000)`).
	BackoffSeconds int64
}

// DecideRetry ports resetStuckProcessingRows' per-message decision
// (host-sweep.ts:313-339) as a pure function: given how many times a
// message has already been tried, whether it carries a future
// process_after, and the current time, decide whether to leave it alone
// (already rescheduled), fail it permanently (tries exhausted), or
// reschedule it with exponential backoff. Reading the message row and
// applying the decision (markMessageFailed / retryWithBackoff) stay the
// caller's job — those are mailbox/DB writes, not decision logic.
func DecideRetry(tries int, processAfterMs *int64, nowMs int64) RetryDecision {
	if processAfterMs != nil && *processAfterMs > nowMs {
		return RetryDecision{Outcome: RetrySkip}
	}
	if tries >= MaxTries {
		return RetryDecision{Outcome: RetryFailed}
	}
	backoffMs := BackoffBaseMs
	for i := 0; i < tries; i++ {
		backoffMs *= 2
	}
	return RetryDecision{Outcome: RetryBackoff, BackoffSeconds: backoffMs / 1000}
}

// AdoptionAction is DecideAdoption's verdict.
type AdoptionAction int

const (
	// Adopt means the session is active and its container is running —
	// leave it running under host management rather than stopping it.
	Adopt AdoptionAction = iota
	// StopOrphan means the session is not active/running — stop the
	// container as an orphan rather than adopting it.
	StopOrphan
)

// DecideAdoption ports adoptRunningSessions' per-snapshot branch
// (container-runner.ts:394-404) verbatim:
//
//	if (!session || session.status !== 'active' || phase !== 'running')
//	  → stop as orphan
//	else
//	  → adopt
//
// sessionFound/sessionStatus are the result of the central-DB lookup keyed
// by the listed handle's session id (nil/false when no session row exists
// at all — container-runner.ts's `!session` arm); phase is the listing
// snapshot's own phase string ("running", "terminal", etc., from
// SupervisedSnapshot). All three are read by the caller; this function only
// owns the combination.
func DecideAdoption(sessionFound bool, sessionStatus string, phase string) AdoptionAction {
	if !sessionFound || sessionStatus != "active" || phase != "running" {
		return StopOrphan
	}
	return Adopt
}

// Runtime is the Go mirror of container-runner.ts's ActiveSessionRuntime
// (lines 74-100), minus the `handle` field itself — a session that is not a
// child process of this host (an adopted runtime, a future non-Docker
// driver) has no single "handle" shape this package should assume; owning
// that stays the caller's job, exactly as the TS comment on that field
// already explains it replaced an earlier `process: ChildProcess` field for
// the identical reason.
type Runtime struct {
	// ContainerName, StartedAtMs, and Adopted are read-only bookkeeping set
	// at construction — mirrors the corresponding TS fields verbatim.
	ContainerName string
	StartedAtMs   int64
	Adopted       bool

	mu               sync.Mutex
	finished         bool
	stopReason       string
	stopGraceSeconds int
	exitCallbacks    []func()
}

// NewRuntime constructs a Runtime — mirrors registerRuntime's object
// literal (container-runner.ts:283-296), minus the finished-promise
// plumbing (Go callers use MarkFinished's return value directly instead of
// a resolve callback).
func NewRuntime(containerName string, startedAtMs int64, adopted bool) *Runtime {
	return &Runtime{ContainerName: containerName, StartedAtMs: startedAtMs, Adopted: adopted}
}

// AddExitCallback mirrors killContainer's onExit registration
// (container-runner.ts:353-355).
func (rt *Runtime) AddExitCallback(cb func()) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.exitCallbacks = append(rt.exitCallbacks, cb)
}

// ExitCallbacks returns a snapshot of the registered callbacks for the
// caller to invoke — mirrors finish()'s callback loop
// (container-runner.ts:339-345). Invocation order and per-callback
// failure-swallowing (the TS original wraps each call in its own try/catch)
// stay the caller's job; this method only hands back what was registered.
func (rt *Runtime) ExitCallbacks() []func() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	out := make([]func(), len(rt.exitCallbacks))
	copy(out, rt.exitCallbacks)
	return out
}

// SetStopReason mirrors killContainer's `entry.stopReason = reason`
// (container-runner.ts:357).
func (rt *Runtime) SetStopReason(reason string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopReason = reason
}

// StopReason returns the reason set by SetStopReason, or "" if none.
func (rt *Runtime) StopReason() string {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.stopReason
}

// SetStopGraceSeconds records the grace period (SessionSpec.stopGraceSeconds,
// types.ts:142) the kernel used at wake time (EC-02, Phase 9), so a later
// kill reads the real value from this registry entry rather than trusting a
// caller-supplied grace period at kill time — the same "resolve the fact
// ourselves" discipline ContainerName resolution already established for
// this type.
func (rt *Runtime) SetStopGraceSeconds(seconds int) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.stopGraceSeconds = seconds
}

// StopGraceSeconds returns the value set by SetStopGraceSeconds, or 0 if
// none was ever set (callers should treat 0 as "use the documented
// default" — see internal/kernel's use of this value).
func (rt *Runtime) StopGraceSeconds() int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.stopGraceSeconds
}

// MarkFinished performs finishAndResolve's single-shot finalize guard
// (container-runner.ts:302-311): only the first call performs the
// transition and returns true; every later call — however many terminal
// signals a runtime observes, or a stop() completion racing a driver-side
// terminal event — is a no-op returning false. The caller gates its
// one-time cleanup effects (markContainerStopped, stopTypingRefresh,
// running the exit callbacks) on this return value, exactly as finish() is
// only ever invoked from behind this same guard in the TS original.
func (rt *Runtime) MarkFinished() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.finished {
		return false
	}
	rt.finished = true
	return true
}

// Finished reports whether MarkFinished has already succeeded once.
func (rt *Runtime) Finished() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.finished
}

// Registry tracks active session runtimes and serializes concurrent wake
// attempts per session id — the Go-native equivalent of container-runner.ts's
// two module-level maps, activeContainers and wakePromises (lines 102-111).
type Registry struct {
	mu     sync.Mutex
	active map[string]*Runtime
	waking map[string]*wakeCall
}

type wakeCall struct {
	done chan struct{}
	err  error
}

// NewRegistry constructs an empty Registry.
func NewRegistry() *Registry {
	return &Registry{active: make(map[string]*Runtime), waking: make(map[string]*wakeCall)}
}

// IsRunning mirrors isContainerRunning (container-runner.ts:117-119).
func (r *Registry) IsRunning(sessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.active[sessionID]
	return ok
}

// RunningSessionIDs returns the session ids this registry currently
// considers active, in no particular order. Added for P6-02's StatusTrace
// primitive (internal/kernel) — a read-only enumeration, no change to any
// existing method's behavior or signature.
func (r *Registry) RunningSessionIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(r.active))
	for id := range r.active {
		ids = append(ids, id)
	}
	return ids
}

// Get returns the active runtime for a session, if any.
func (r *Registry) Get(sessionID string) (*Runtime, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rt, ok := r.active[sessionID]
	return rt, ok
}

// Register records a runtime as active — mirrors registerRuntime's
// `activeContainers.set(sessionId, runtime)` (container-runner.ts:297). The
// caller's spawn function (passed to Wake) is expected to call this once
// the underlying session has actually started, exactly as spawnContainer
// calls registerRuntime partway through, before arming lifecycle callbacks.
func (r *Registry) Register(sessionID string, rt *Runtime) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active[sessionID] = rt
}

// Unregister removes a runtime — mirrors finish()'s identity-guarded
// `activeContainers.delete(sessionId)` (container-runner.ts:336-338): a
// runtime already superseded by a newer registration for the same session
// id (e.g. a respawn that raced this one's own teardown) is never evicted
// out from under it.
func (r *Registry) Unregister(sessionID string, rt *Runtime) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[sessionID] == rt {
		delete(r.active, sessionID)
	}
}

// Wake mirrors wakeContainer (container-runner.ts:134-155): already-running
// is a no-op success (spawn is never called); a wake already in flight for
// this session is joined rather than duplicated — the exact race the TS
// original's own comment names ("a second wake in that window... spawns a
// duplicate container against the same session directory, producing racy
// double-replies"); otherwise spawn runs exactly once and every caller
// (the one that started it, and any that joined while it was running)
// observes the same result.
//
// Unlike the TS original — which never throws and always resolves to a bare
// bool, silently swallowing the actual spawn error into a log line — Wake
// takes a context.Context and returns an explicit error alongside the bool,
// per this task's own prompt guidance to prefer context cancellation and
// explicit errors over silent failure. Cancelling ctx only affects a caller
// currently WAITING on an already-in-flight spawn: it returns ctx.Err() to
// that caller immediately instead of blocking indefinitely. It does not
// (and, without owning the actual driver call, structurally cannot) abort
// the spawn itself — the goroutine that started it runs spawn to completion
// regardless, exactly as the TS original's promise-based dedup does (there
// is no cancellation concept in the original at all; a caller just waits).
// This is precisely the gap the explicit-error/context contract closes: a
// caller with its own deadline (e.g. a request-scoped timeout) gets a
// prompt, explicit answer instead of hanging silently on someone else's
// spawn attempt.
//
// spawn is caller-supplied because composing an actual session — mounts,
// provider/gateway contribution, the driver's prepare()/start() — is
// entirely the TS host's job today (and, later, a Go-kernel driver's); this
// package owns only the dedup/registration mechanism around it. A
// successful spawn is expected to call Register before returning nil, so
// that IsRunning reflects the new runtime immediately once Wake returns.
func (r *Registry) Wake(ctx context.Context, sessionID string, spawn func(context.Context) error) (bool, error) {
	if r.IsRunning(sessionID) {
		return true, nil
	}

	r.mu.Lock()
	if call, ok := r.waking[sessionID]; ok {
		r.mu.Unlock()
		select {
		case <-call.done:
			return call.err == nil, call.err
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
	call := &wakeCall{done: make(chan struct{})}
	r.waking[sessionID] = call
	r.mu.Unlock()

	err := spawn(ctx)

	r.mu.Lock()
	delete(r.waking, sessionID)
	r.mu.Unlock()

	call.err = err
	close(call.done)

	return err == nil, err
}
