package restart

import (
	"slices"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/lifecycle"
)

// --- AttemptTracker -------------------------------------------------------

func TestAttemptTracker_RecordFailureMirrorsNextAttempt(t *testing.T) {
	tr := NewAttemptTracker()

	attempts, giveUp := tr.RecordFailure("msg-1")
	if attempts != 1 || giveUp {
		t.Fatalf("1st failure: got (%d, %v), want (1, false)", attempts, giveUp)
	}
	attempts, giveUp = tr.RecordFailure("msg-1")
	if attempts != 2 || giveUp {
		t.Fatalf("2nd failure: got (%d, %v), want (2, false)", attempts, giveUp)
	}
	attempts, giveUp = tr.RecordFailure("msg-1")
	if attempts != 3 || !giveUp {
		t.Fatalf("3rd failure: got (%d, %v), want (3, true)", attempts, giveUp)
	}
	if got := tr.Count("msg-1"); got != 0 {
		t.Fatalf("Count after give-up = %d, want 0 (forgotten)", got)
	}
}

func TestAttemptTracker_ForgetOnSuccessMirrorsDeliveryTsLine226(t *testing.T) {
	tr := NewAttemptTracker()
	tr.RecordFailure("msg-1")
	tr.RecordFailure("msg-1")
	if got := tr.Count("msg-1"); got != 2 {
		t.Fatalf("Count before Forget = %d, want 2", got)
	}
	tr.Forget("msg-1")
	if got := tr.Count("msg-1"); got != 0 {
		t.Fatalf("Count after Forget = %d, want 0", got)
	}
	// A subsequent failure starts a fresh count, exactly as a never-seen id would.
	attempts, giveUp := tr.RecordFailure("msg-1")
	if attempts != 1 || giveUp {
		t.Fatalf("post-Forget failure: got (%d, %v), want (1, false)", attempts, giveUp)
	}
}

func TestAttemptTracker_IndependentMessagesTrackedSeparately(t *testing.T) {
	tr := NewAttemptTracker()
	tr.RecordFailure("msg-a")
	tr.RecordFailure("msg-a")
	tr.RecordFailure("msg-b")
	if got := tr.Count("msg-a"); got != 2 {
		t.Fatalf("msg-a count = %d, want 2", got)
	}
	if got := tr.Count("msg-b"); got != 1 {
		t.Fatalf("msg-b count = %d, want 1", got)
	}
}

// TestAttemptTracker_ResetsAcrossSimulatedRestart pins the accepted,
// documented behavior: a host restart is a brand new AttemptTracker, so a
// message that had accumulated failures pre-restart starts completely over
// post-restart — never carrying over a stale count, and in particular never
// starting "half exhausted."
func TestAttemptTracker_ResetsAcrossSimulatedRestart(t *testing.T) {
	preRestart := NewAttemptTracker()
	preRestart.RecordFailure("msg-1") // attempts=1
	preRestart.RecordFailure("msg-1") // attempts=2, one short of giving up

	// Simulate a host restart: the process ends, a brand new one starts.
	postRestart := NewAttemptTracker()

	attempts, giveUp := postRestart.RecordFailure("msg-1")
	if attempts != 1 || giveUp {
		t.Fatalf("post-restart 1st failure: got (%d, %v), want (1, false) — attempt count must not survive a restart", attempts, giveUp)
	}
	// Confirms it takes a full fresh 3 attempts post-restart, not just 1 more
	// (which would happen if state had somehow carried over).
	postRestart.RecordFailure("msg-1") // attempts=2
	attempts, giveUp = postRestart.RecordFailure("msg-1")
	if attempts != 3 || !giveUp {
		t.Fatalf("post-restart 3rd failure: got (%d, %v), want (3, true)", attempts, giveUp)
	}
}

// --- FilterUndelivered ------------------------------------------------------

func TestFilterUndelivered_EmptyDeliveredSetKeepsAllDue(t *testing.T) {
	due := []string{"a", "b", "c"}
	got := FilterUndelivered(due, map[string]bool{})
	if len(got) != 3 {
		t.Fatalf("got %v, want all 3 due messages kept (fresh session, nothing delivered yet)", got)
	}
}

func TestFilterUndelivered_NoDueMessagesReturnsEmpty(t *testing.T) {
	got := FilterUndelivered(nil, map[string]bool{"a": true})
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestFilterUndelivered_SkipsAlreadyDelivered(t *testing.T) {
	due := []string{"a", "b", "c"}
	delivered := map[string]bool{"a": true}
	got := FilterUndelivered(due, delivered)
	want := []string{"b", "c"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// TestFilterUndelivered_NoDuplicateDeliveryAcrossSimulatedRestart is the
// package's central duplicate-risk test: it simulates a host restart
// mid-queue and confirms the persisted `delivered` set — not anything this
// package tracks in memory — is what prevents "a" and "b" from ever being
// delivered a second time, even though the queue is re-read from scratch
// after the restart exactly as a real process restart would re-read it.
func TestFilterUndelivered_NoDuplicateDeliveryAcrossSimulatedRestart(t *testing.T) {
	due := []string{"a", "b", "c"}

	// Pre-restart: nothing delivered yet. All three are pending.
	delivered := map[string]bool{}
	pending := FilterUndelivered(due, delivered)
	if !slices.Equal(pending, []string{"a", "b", "c"}) {
		t.Fatalf("pre-restart pending = %v, want all 3", pending)
	}

	// Pre-restart process successfully delivers "a" — this is the one durable
	// write (markDelivered) that survives the restart below.
	delivered["a"] = true

	// --- host restart happens here: a brand new process starts, re-reads the
	// due queue from messages_out (unchanged, "b" and "c" are still due) and
	// re-reads `delivered` from the durable table (now contains "a"). ---

	postRestartDue := []string{"a", "b", "c"} // re-read fresh; same rows still exist
	pending = FilterUndelivered(postRestartDue, delivered)
	if !slices.Equal(pending, []string{"b", "c"}) {
		t.Fatalf("post-restart pending = %v, want [b c] — \"a\" must never be redelivered", pending)
	}

	// Post-restart process now delivers "b" successfully and "c" fails
	// permanently (exhausts a fresh AttemptTracker — see the combined test
	// below for that half of the story). Either way, once "b" is durably
	// marked delivered...
	delivered["b"] = true
	pending = FilterUndelivered([]string{"a", "b", "c"}, delivered)
	if !slices.Equal(pending, []string{"c"}) {
		t.Fatalf("after b delivered = %v, want [c] — neither a nor b may reappear", pending)
	}
}

// --- Combined restart scenarios, tying AttemptTracker/FilterUndelivered to
// the lifecycle decisions already ported at P4-03 --------------------------

// TestCombined_OutboundRestartResetsAttemptsButNeverDuplicatesDelivery walks
// the full outbound story across a simulated restart: 2 of 3 attempts spent
// pre-restart, a fresh AttemptTracker post-restart, and FilterUndelivered
// throughout — pinning that a restart can only ever be MORE generous
// (more attempts) or IDENTICAL, never fewer attempts or a duplicate send.
func TestCombined_OutboundRestartResetsAttemptsButNeverDuplicatesDelivery(t *testing.T) {
	delivered := map[string]bool{}

	preRestart := NewAttemptTracker()
	due := FilterUndelivered([]string{"msg-1"}, delivered)
	if len(due) != 1 {
		t.Fatalf("expected msg-1 due pre-restart, got %v", due)
	}
	// Adapter fails twice pre-restart.
	preRestart.RecordFailure("msg-1")
	attempts, giveUp := preRestart.RecordFailure("msg-1")
	if attempts != 2 || giveUp {
		t.Fatalf("pre-restart 2nd failure: got (%d, %v), want (2, false)", attempts, giveUp)
	}

	// --- restart ---
	postRestart := NewAttemptTracker()

	// msg-1 is still due (never delivered, never permanently failed) and is
	// NOT in the delivered set, so it is correctly retried post-restart —
	// this time succeeding.
	due = FilterUndelivered([]string{"msg-1"}, delivered)
	if len(due) != 1 {
		t.Fatalf("expected msg-1 still due post-restart, got %v", due)
	}
	postRestart.Forget("msg-1") // success: delivery.ts:226
	delivered["msg-1"] = true   // success: markDelivered persists this durably

	// A third restart (or just the next poll tick) must never redeliver it.
	due = FilterUndelivered([]string{"msg-1"}, delivered)
	if len(due) != 0 {
		t.Fatalf("expected msg-1 no longer due after delivery, got %v", due)
	}
	if got := postRestart.Count("msg-1"); got != 0 {
		t.Fatalf("post-success attempt count = %d, want 0", got)
	}
}

// TestDecideRetryIsRestartTransparent pins the package doc's claim about
// internal/lifecycle.DecideRetry directly: because tries and processAfter
// are DB-durable fields, calling DecideRetry with the values a message row
// actually holds gives the identical answer whether or not a restart
// happened in between — restart-transparency is a property DecideRetry
// already had from P4-03, not something this package adds, and this test
// exists so that property is pinned by name here where the restart contract
// is actually documented.
func TestDecideRetryIsRestartTransparent(t *testing.T) {
	now := int64(1_000_000)

	// A message with 2 prior tries and no future process_after — decided
	// once "pre-restart"...
	preRestart := lifecycle.DecideRetry(2, nil, now)

	// ...and again "post-restart", as if a brand new host process read the
	// exact same durable row and evaluated it at the exact same instant.
	postRestart := lifecycle.DecideRetry(2, nil, now)

	if preRestart != postRestart {
		t.Fatalf("DecideRetry not restart-transparent: pre=%+v post=%+v", preRestart, postRestart)
	}
	if preRestart.Outcome != lifecycle.RetryBackoff {
		t.Fatalf("expected RetryBackoff for tries=2, got %v", preRestart.Outcome)
	}
}

// TestNoReprocessingAfterPermanentFailure pins the package doc's inbound
// loss/duplicate statement: once tries reaches MaxTries, DecideRetry reports
// RetryFailed regardless of how many times — across however many restarts —
// it is asked again with the same durable tries value. A permanently failed
// message is never silently retried just because the host happened to
// restart.
func TestNoReprocessingAfterPermanentFailure(t *testing.T) {
	now := int64(2_000_000)
	decision := lifecycle.DecideRetry(lifecycle.MaxTries, nil, now)
	if decision.Outcome != lifecycle.RetryFailed {
		t.Fatalf("tries==MaxTries: got %v, want RetryFailed", decision.Outcome)
	}
	// Ask again, simulating another restart — still RetryFailed, not
	// re-armed into another backoff cycle.
	decision = lifecycle.DecideRetry(lifecycle.MaxTries, nil, now+1)
	if decision.Outcome != lifecycle.RetryFailed {
		t.Fatalf("tries==MaxTries after simulated second restart: got %v, want RetryFailed", decision.Outcome)
	}
}

// TestDecideAdoptionSurvivesRestartForRunningSession pins the container
// side of the restart contract by name in this package: a session that was
// genuinely running when the host restarted is adopted, not lost — the same
// DecideAdoption verdict (P4-03) a live sweep tick would have reached had
// the host never restarted at all.
func TestDecideAdoptionSurvivesRestartForRunningSession(t *testing.T) {
	action := lifecycle.DecideAdoption(true, "active", "running")
	if action != lifecycle.Adopt {
		t.Fatalf("got %v, want Adopt for an active session with a running container snapshot", action)
	}
}

func TestDecideAdoptionStopsOrphanAfterRestart(t *testing.T) {
	// The container process died with no host watching (host was down) —
	// listSessions won't even report it as 'running', so this is the more
	// common real-restart shape than a session row gone missing.
	action := lifecycle.DecideAdoption(true, "active", "terminal")
	if action != lifecycle.StopOrphan {
		t.Fatalf("got %v, want StopOrphan for a non-running snapshot", action)
	}
}
