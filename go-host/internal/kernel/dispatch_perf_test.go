package kernel

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// PERF-GATE: bounds route.request dispatch overhead — the pure Isthmus-added
// latency of the Go security kernel sitting in front of every inbound
// message, on top of what plain upstream NanoClaw does (upstream has no
// such layer at all, so this is the most direct answer to "did maintaining
// Isthmus make message routing slower than upstream"). Picked up by the CI
// `performance-gate` job the same way as the TS-side convention (see
// src/router-engage-pattern-redos.test.ts) — grep for this tag.
//
// Runs a batch of realistic wiring dispatches (envelope decode + route
// handling + audit trace record) against a Kernel built once outside the
// loop, and asserts the total wall time stays comfortably bounded.
func TestDispatch_RouteRequestPerfBudget(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	ctx := context.Background()

	payload, err := json.Marshal(RouteRequestPayload{
		Kind: "wiring", EngageMode: "mention", IsMention: true,
		AccessAllowed: true, ScopeAllowed: true,
		ConfiguredMode: "shared", MessageID: "m1", AgentGroupID: "ag-1",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	const iterations = 2000
	start := time.Now()
	for i := 0; i < iterations; i++ {
		env := Envelope{
			Version:   ProtocolVersion,
			Op:        OpRouteRequest,
			RequestID: "perf-req",
			Payload:   payload,
		}
		resp := k.Dispatch(ctx, env)
		if !resp.OK {
			t.Fatalf("dispatch %d unexpectedly denied: %+v", i, resp)
		}
	}
	elapsed := time.Since(start)

	// This file is an ordinary _test.go in package kernel, so besides
	// performance-gate's own targeted, non-race `go test -run` invocation,
	// it ALSO runs — unavoidably, unintentionally at first — inside the
	// required go-host job's blanket `go test -race ./...` sweep. The race
	// detector's instrumentation is genuinely, substantially slower (every
	// memory access gets checked, and this call path is mutex-guarded via
	// k.auditMu): confirmed on a real CI run (2026-09-20) at 85ms under
	// -race vs. ~4ms without it in the same run's performance-gate job,
	// and 118-215ms across several -race runs on this exercise's own dev
	// machine. A budget tuned only against the non-race number (50ms, the
	// original value here) fails go-host's race run every time, which is
	// exactly what happened. 400ms gives ~1.9x headroom over the worst
	// -race number actually observed (215ms) and ~4.7x over the real CI
	// -race measurement (85ms) — tighter than an earlier 1000ms value
	// tried here, chosen deliberately over 100ms (would sit inside the
	// observed 85-215ms -race range and likely still flake).
	const budget = 400 * time.Millisecond

	// PERF-RESULT is a fixed-format marker (see .github/workflows/ci.yml's
	// performance-gate job) that the CI report step greps out of raw test
	// output to build a human-readable results-vs-budget table on the run
	// summary page — keep the "name=" / "elapsed_ms=" / "budget_ms="
	// fields exactly as shown if this line is ever edited. Logged BEFORE
	// the budget check below (not after) so a genuine regression still
	// shows up in the report instead of t.Fatalf's Goexit skipping past
	// this line.
	t.Logf("PERF-RESULT: name=\"Go kernel: route.request dispatch\" elapsed_ms=%d budget_ms=%d", elapsed.Milliseconds(), budget.Milliseconds())
	t.Logf("route.request dispatch: %d iterations in %v (%v/dispatch)", iterations, elapsed, elapsed/iterations)

	if elapsed > budget {
		t.Fatalf("route.request dispatch got slower than budget: %d iterations took %v, budget is %v (%v/dispatch)", iterations, elapsed, budget, elapsed/iterations)
	}
}
