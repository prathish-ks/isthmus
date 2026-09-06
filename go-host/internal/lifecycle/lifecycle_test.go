package lifecycle

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
)

func strp(s string) *string { return &s }
func i64p(v int64) *int64   { return &v }

// base mirrors host-sweep-grace.test.ts's BASE constant so the numbers here
// read the same way the TS fixtures do.
var base = time.Date(2026, time.April, 20, 12, 0, 0, 0, time.UTC).UnixMilli()

const (
	justWithinCeilingMs = AbsoluteCeilingMs - 1
	justOverCeilingMs   = AbsoluteCeilingMs + 1
)

// claimAt builds a Claim whose StatusChanged is `offsetMs` before base, in
// this Go host's canonical timestamp format — mirrors host-sweep.test.ts's
// own `claim(id, offsetMs)` helper.
func claimAt(id string, offsetMs int64) Claim {
	return Claim{MessageID: id, StatusChanged: mailbox.FormatTimestamp(time.UnixMilli(base - offsetMs))}
}

// --- DecideStuckAction — mirrors host-sweep.test.ts's decideStuckAction suite ---

func TestDecideStuckAction_OkWithinCeiling(t *testing.T) {
	got := DecideStuckAction(base, base-justWithinCeilingMs, nil, nil, nil)
	if got.Action != StuckOK {
		t.Fatalf("expected ok within ceiling, got %+v", got)
	}
}

func TestDecideStuckAction_KillCeilingOverThreshold(t *testing.T) {
	got := DecideStuckAction(base, base-justOverCeilingMs, nil, nil, nil)
	if got.Action != StuckKillCeiling || got.HeartbeatAgeMs != justOverCeilingMs || got.CeilingMs != AbsoluteCeilingMs {
		t.Fatalf("expected kill-ceiling with age=%d ceiling=%d, got %+v", justOverCeilingMs, AbsoluteCeilingMs, got)
	}
}

func TestDecideStuckAction_SkipsCeilingWhenNoHeartbeatOrFallback(t *testing.T) {
	got := DecideStuckAction(base, 0, nil, nil, nil)
	if got.Action != StuckOK {
		t.Fatalf("expected ok when no heartbeat and no spawn-time fallback, got %+v", got)
	}
}

func TestDecideStuckAction_SpawnFallbackWithinCeiling(t *testing.T) {
	got := DecideStuckAction(base, 0, i64p(base-justWithinCeilingMs), nil, nil)
	if got.Action != StuckOK {
		t.Fatalf("expected ok using spawn-time fallback within ceiling, got %+v", got)
	}
}

func TestDecideStuckAction_KillCeilingUsingSpawnFallback(t *testing.T) {
	got := DecideStuckAction(base, 0, i64p(base-justOverCeilingMs), nil, nil)
	if got.Action != StuckKillCeiling {
		t.Fatalf("expected kill-ceiling using spawn-time fallback, got %+v", got)
	}
}

func TestDecideStuckAction_HeartbeatPreferredOverSpawnFallback(t *testing.T) {
	got := DecideStuckAction(base, base-justWithinCeilingMs, i64p(base-justOverCeilingMs), nil, nil)
	if got.Action != StuckOK {
		t.Fatalf("expected heartbeat (fresh) to win over a stale spawn-time fallback, got %+v", got)
	}
}

func TestDecideStuckAction_KillClaimWhenHeartbeatAbsent(t *testing.T) {
	claimedAgeMs := ClaimStuckMs + 5_000
	got := DecideStuckAction(base, 0, nil, nil, []Claim{claimAt("msg-1", claimedAgeMs)})
	if got.Action != StuckKillClaim {
		t.Fatalf("expected kill-claim, got %+v", got)
	}
}

func TestDecideStuckAction_CeilingExtendedByDeclaredBashTimeout(t *testing.T) {
	twoHrMs := int64(2 * 60 * 60 * 1000)
	got := DecideStuckAction(base, base-45*60*1000, nil, &ContainerState{CurrentTool: "Bash", ToolDeclaredTimeoutMs: twoHrMs}, nil)
	if got.Action != StuckOK {
		t.Fatalf("expected ok — 45min heartbeat age is under a declared 2h Bash timeout, got %+v", got)
	}
}

func TestDecideStuckAction_KillClaimPastToleranceWithStaleHeartbeat(t *testing.T) {
	claimedAgeMs := ClaimStuckMs + 10_000
	got := DecideStuckAction(base, base-claimedAgeMs-5_000, nil, nil, []Claim{claimAt("msg-1", claimedAgeMs)})
	if got.Action != StuckKillClaim || got.MessageID != "msg-1" || got.ToleranceMs != ClaimStuckMs {
		t.Fatalf("expected kill-claim msg-1 tolerance=%d, got %+v", ClaimStuckMs, got)
	}
}

func TestDecideStuckAction_OkWhenHeartbeatTouchedSinceClaim(t *testing.T) {
	claimedAgeMs := ClaimStuckMs + 10_000
	got := DecideStuckAction(base, base-2_000, nil, nil, []Claim{claimAt("msg-1", claimedAgeMs)})
	if got.Action != StuckOK {
		t.Fatalf("expected ok — heartbeat is fresher than the claim, got %+v", got)
	}
}

func TestDecideStuckAction_OkWhenClaimBelowTolerance(t *testing.T) {
	got := DecideStuckAction(base, base-ClaimStuckMs-10_000, nil, nil, []Claim{claimAt("msg-1", 5_000)})
	if got.Action != StuckOK {
		t.Fatalf("expected ok — claim is recent even though heartbeat is old, got %+v", got)
	}
}

func TestDecideStuckAction_ClaimToleranceWidenedByBashTimeout(t *testing.T) {
	tenMinMs := int64(10 * 60 * 1000)
	got := DecideStuckAction(
		base,
		base-5*60*1000-5_000,
		nil,
		&ContainerState{CurrentTool: "Bash", ToolDeclaredTimeoutMs: tenMinMs},
		[]Claim{claimAt("msg-1", 5*60*1000)},
	)
	if got.Action != StuckOK {
		t.Fatalf("expected ok — 5min claim age is under the declared 10min Bash timeout, got %+v", got)
	}
}

func TestDecideStuckAction_IgnoresUnparseableClaimTimestamps(t *testing.T) {
	got := DecideStuckAction(base, base-5_000, nil, nil, []Claim{{MessageID: "x", StatusChanged: "not-a-date"}})
	if got.Action != StuckOK {
		t.Fatalf("expected an unparseable claim timestamp to be skipped, not crash or kill, got %+v", got)
	}
}

// --- ShouldCloseTaskSession ---

func TestShouldCloseTaskSession(t *testing.T) {
	taskThread := session_TasksSystemThreadID + ":task-1"
	if !ShouldCloseTaskSession(strp(taskThread), false, 0) {
		t.Fatalf("expected a spent task session (no tasks, no container) to close")
	}
	if ShouldCloseTaskSession(strp(taskThread), false, 1) {
		t.Fatalf("expected a task session with a live task to stay open")
	}
	if ShouldCloseTaskSession(strp(taskThread), true, 0) {
		t.Fatalf("expected a task session with a running container to stay open")
	}
	if ShouldCloseTaskSession(strp("telegram:12345"), false, 0) {
		t.Fatalf("expected a non-task thread never to close via this rule")
	}
	if ShouldCloseTaskSession(nil, false, 0) {
		t.Fatalf("expected a nil thread id never to close via this rule")
	}
}

// --- DecideRetry ---

func TestDecideRetry_SkipsWhenAlreadyRescheduled(t *testing.T) {
	future := base + 60_000
	got := DecideRetry(1, i64p(future), base)
	if got.Outcome != RetrySkip {
		t.Fatalf("expected skip for a future process_after, got %+v", got)
	}
}

func TestDecideRetry_FailsAtMaxTries(t *testing.T) {
	got := DecideRetry(MaxTries, nil, base)
	if got.Outcome != RetryFailed {
		t.Fatalf("expected failed at tries=MaxTries, got %+v", got)
	}
}

func TestDecideRetry_BackoffFormula(t *testing.T) {
	cases := []struct {
		tries   int
		seconds int64
	}{
		{0, 5},  // 5000 * 2^0 / 1000
		{1, 10}, // 5000 * 2^1 / 1000
		{4, 80}, // 5000 * 2^4 / 1000
	}
	for _, tc := range cases {
		got := DecideRetry(tc.tries, nil, base)
		if got.Outcome != RetryBackoff || got.BackoffSeconds != tc.seconds {
			t.Fatalf("tries=%d: expected backoff %ds, got %+v", tc.tries, tc.seconds, got)
		}
	}
}

func TestDecideRetry_PastProcessAfterDoesNotSkip(t *testing.T) {
	past := base - 60_000
	got := DecideRetry(0, i64p(past), base)
	if got.Outcome != RetryBackoff {
		t.Fatalf("expected a past process_after not to trigger skip, got %+v", got)
	}
}

// --- DecideAdoption ---

func TestDecideAdoption_NoSessionRowStops(t *testing.T) {
	if DecideAdoption(false, "", "running") != StopOrphan {
		t.Fatalf("expected a missing session row to stop the orphan")
	}
}

func TestDecideAdoption_InactiveSessionStops(t *testing.T) {
	if DecideAdoption(true, "closed", "running") != StopOrphan {
		t.Fatalf("expected an inactive session to stop the orphan even if the phase is running")
	}
}

func TestDecideAdoption_NonRunningPhaseStops(t *testing.T) {
	if DecideAdoption(true, "active", "terminal") != StopOrphan {
		t.Fatalf("expected a non-running phase to stop the orphan even for an active session")
	}
}

func TestDecideAdoption_ActiveAndRunningAdopts(t *testing.T) {
	if DecideAdoption(true, "active", "running") != Adopt {
		t.Fatalf("expected an active session with a running phase to be adopted")
	}
}

// --- Runtime ---

func TestRuntime_MarkFinishedOnlyOnce(t *testing.T) {
	rt := NewRuntime("nanoclaw-v2-test-123", base, false)
	if !rt.MarkFinished() {
		t.Fatalf("expected the first MarkFinished to succeed")
	}
	if rt.MarkFinished() {
		t.Fatalf("expected a second MarkFinished to be a no-op")
	}
	if !rt.Finished() {
		t.Fatalf("expected Finished() to report true after MarkFinished")
	}
}

func TestRuntime_ExitCallbacksSnapshot(t *testing.T) {
	rt := NewRuntime("c", base, false)
	var calls []int
	rt.AddExitCallback(func() { calls = append(calls, 1) })
	rt.AddExitCallback(func() { calls = append(calls, 2) })

	cbs := rt.ExitCallbacks()
	if len(cbs) != 2 {
		t.Fatalf("expected 2 registered callbacks, got %d", len(cbs))
	}
	for _, cb := range cbs {
		cb()
	}
	if len(calls) != 2 || calls[0] != 1 || calls[1] != 2 {
		t.Fatalf("expected callbacks to run in registration order, got %v", calls)
	}

	// Adding a third after the snapshot must not retroactively appear in it.
	rt.AddExitCallback(func() { calls = append(calls, 3) })
	if len(cbs) != 2 {
		t.Fatalf("expected the earlier snapshot to stay length 2, got %d", len(cbs))
	}
}

func TestRuntime_StopReason(t *testing.T) {
	rt := NewRuntime("c", base, false)
	if rt.StopReason() != "" {
		t.Fatalf("expected an empty stop reason before SetStopReason")
	}
	rt.SetStopReason("absolute-ceiling")
	if rt.StopReason() != "absolute-ceiling" {
		t.Fatalf("expected StopReason() to return what was set, got %q", rt.StopReason())
	}
}

// --- Registry ---

func TestRegistry_IsRunningAndUnregisterIdentityGuard(t *testing.T) {
	r := NewRegistry()
	if r.IsRunning("sess-1") {
		t.Fatalf("expected a fresh registry to report nothing running")
	}
	rt1 := NewRuntime("c1", base, false)
	r.Register("sess-1", rt1)
	if !r.IsRunning("sess-1") {
		t.Fatalf("expected IsRunning to be true after Register")
	}

	// A respawn supersedes the entry for the same session id.
	rt2 := NewRuntime("c2", base, false)
	r.Register("sess-1", rt2)

	// Unregistering the STALE runtime must not evict the newer one — mirrors
	// finish()'s `if (activeContainers.get(sessionId) === runtime)` guard.
	r.Unregister("sess-1", rt1)
	got, ok := r.Get("sess-1")
	if !ok || got != rt2 {
		t.Fatalf("expected the newer runtime to survive an unregister of the stale one, got %+v ok=%v", got, ok)
	}

	r.Unregister("sess-1", rt2)
	if r.IsRunning("sess-1") {
		t.Fatalf("expected the matching unregister to actually remove the runtime")
	}
}

func TestRegistry_WakeAlreadyRunningNoOpsSpawn(t *testing.T) {
	r := NewRegistry()
	r.Register("sess-1", NewRuntime("c1", base, false))

	var spawnCalls int32
	ok, err := r.Wake(context.Background(), "sess-1", func(context.Context) error {
		atomic.AddInt32(&spawnCalls, 1)
		return nil
	})
	if !ok || err != nil {
		t.Fatalf("expected (true, nil) for an already-running session, got (%v, %v)", ok, err)
	}
	if atomic.LoadInt32(&spawnCalls) != 0 {
		t.Fatalf("expected spawn never to be called for an already-running session")
	}
}

func TestRegistry_WakeSpawnsOnceAndRegisters(t *testing.T) {
	r := NewRegistry()
	var spawnCalls int32
	ok, err := r.Wake(context.Background(), "sess-1", func(context.Context) error {
		atomic.AddInt32(&spawnCalls, 1)
		r.Register("sess-1", NewRuntime("c1", base, false))
		return nil
	})
	if !ok || err != nil {
		t.Fatalf("expected (true, nil) on a successful spawn, got (%v, %v)", ok, err)
	}
	if atomic.LoadInt32(&spawnCalls) != 1 {
		t.Fatalf("expected spawn to be called exactly once, got %d", spawnCalls)
	}
	if !r.IsRunning("sess-1") {
		t.Fatalf("expected the registry to reflect the spawn's own Register call")
	}
}

func TestRegistry_WakeSpawnFailurePropagatesExplicitError(t *testing.T) {
	r := NewRegistry()
	wantErr := errors.New("gateway unreachable")
	ok, err := r.Wake(context.Background(), "sess-1", func(context.Context) error {
		return wantErr
	})
	if ok {
		t.Fatalf("expected false on a spawn failure")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the exact spawn error to propagate, got %v", err)
	}
	if r.IsRunning("sess-1") {
		t.Fatalf("expected a failed spawn never to register a runtime")
	}
}

func TestRegistry_WakeJoinsInFlightSpawnExactlyOnce(t *testing.T) {
	r := NewRegistry()
	var spawnCalls int32
	release := make(chan struct{})
	spawn := func(context.Context) error {
		atomic.AddInt32(&spawnCalls, 1)
		<-release
		r.Register("sess-1", NewRuntime("c1", base, false))
		return nil
	}

	type result struct {
		ok  bool
		err error
	}
	results := make(chan result, 2)
	go func() {
		ok, err := r.Wake(context.Background(), "sess-1", spawn)
		results <- result{ok, err}
	}()
	go func() {
		ok, err := r.Wake(context.Background(), "sess-1", spawn)
		results <- result{ok, err}
	}()

	// Give both goroutines a chance to reach the dedup gate before releasing.
	time.Sleep(50 * time.Millisecond)
	close(release)

	for i := 0; i < 2; i++ {
		res := <-results
		if !res.ok || res.err != nil {
			t.Fatalf("expected both joiners to see (true, nil), got %+v", res)
		}
	}
	if atomic.LoadInt32(&spawnCalls) != 1 {
		t.Fatalf("expected spawn to run exactly once for two concurrent wakes, got %d", spawnCalls)
	}
}

func TestRegistry_WakeContextCancellationOnJoinReturnsPromptly(t *testing.T) {
	r := NewRegistry()
	started := make(chan struct{})
	release := make(chan struct{})
	spawn := func(context.Context) error {
		close(started)
		<-release
		return nil
	}

	go func() { _, _ = r.Wake(context.Background(), "sess-1", spawn) }()
	<-started // the first wake is now in flight

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled — the joiner must not block on the slow spawn
	ok, err := r.Wake(ctx, "sess-1", spawn)
	if ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected a cancelled joiner to return (false, context.Canceled) promptly, got (%v, %v)", ok, err)
	}

	close(release) // let the original spawn finish so the test doesn't leak a goroutine
}

// session_TasksSystemThreadID avoids an import cycle concern in this test
// file's helper naming while still pinning the exact value ShouldCloseTaskSession
// depends on via internal/session.IsTaskThread.
const session_TasksSystemThreadID = "system:tasks"
