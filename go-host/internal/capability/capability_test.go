package capability

import (
	"testing"
	"time"
)

func fakeClock(start time.Time) (*time.Time, func() time.Time) {
	t := start
	return &t, func() time.Time { return t }
}

func TestGrantFSRead_RejectsForgedSessionID(t *testing.T) {
	m := NewManager()
	_, err := m.GrantFSRead("../../etc/passwd", "/data/g1", time.Minute, "test")
	if err == nil {
		t.Fatal("expected an error granting to a path-shaped session id")
	}
}

func TestCheckFSRead_NoGrantDenies(t *testing.T) {
	m := NewManager()
	ok, reason := m.CheckFSRead("sess-1", "/data/g1/file.txt")
	if ok {
		t.Fatal("expected denial with no grant issued")
	}
	if reason == "" {
		t.Fatal("expected a non-empty denial reason")
	}
}

// TestCheckFSRead_AccessDuringWindowThenDeniedAfterExpiry is P8-02's own
// done-when: the SAME Manager and the SAME Grant are checked twice — once
// before ExpiresAt (must allow) and once after (must deny) — with nothing
// else about the grant changed, only the injected clock advanced. This is
// the actual security property the task asks for, not just "expiry is
// checked somewhere."
func TestCheckFSRead_AccessDuringWindowThenDeniedAfterExpiry(t *testing.T) {
	start := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockVal, clock := fakeClock(start)
	m := NewManagerWithClock(clock)

	grant, err := m.GrantFSRead("sess-1", "/data/groups/g1/scratch", 15*time.Minute, "auto-approved: read-only, 15m default")
	if err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}

	// During the window: allowed.
	ok, reason := m.CheckFSRead("sess-1", "/data/groups/g1/scratch/notes.txt")
	if !ok {
		t.Fatalf("expected access during the grant window, got denial: %s", reason)
	}

	// Advance the clock past ExpiresAt.
	*clockVal = grant.ExpiresAt.Add(time.Second)

	// After expiry: denied, same grant, same path, same session.
	ok, reason = m.CheckFSRead("sess-1", "/data/groups/g1/scratch/notes.txt")
	if ok {
		t.Fatal("expected denial after the grant's ExpiresAt, got access")
	}
	if reason == "" {
		t.Fatal("expected a non-empty denial reason after expiry")
	}
}

func TestCheckFSRead_DeniesOtherSession(t *testing.T) {
	m := NewManager()
	if _, err := m.GrantFSRead("sess-1", "/data/g1", time.Hour, "test"); err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	ok, _ := m.CheckFSRead("sess-2", "/data/g1/file.txt")
	if ok {
		t.Fatal("a grant issued to sess-1 must not authorize sess-2")
	}
}

func TestCheckFSRead_DeniesSiblingDirectory(t *testing.T) {
	m := NewManager()
	if _, err := m.GrantFSRead("sess-1", "/data/g1", time.Hour, "test"); err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	// /data/g1-other is a lexical sibling, not a descendant of /data/g1 —
	// a naive strings.HasPrefix(path, resource) check would wrongly allow
	// this; covers() must not.
	ok, _ := m.CheckFSRead("sess-1", "/data/g1-other/file.txt")
	if ok {
		t.Fatal("a grant over /data/g1 must not cover the sibling directory /data/g1-other")
	}
}

func TestCheckFSRead_AllowsResourceRootItself(t *testing.T) {
	m := NewManager()
	if _, err := m.GrantFSRead("sess-1", "/data/g1", time.Hour, "test"); err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	ok, _ := m.CheckFSRead("sess-1", "/data/g1")
	if !ok {
		t.Fatal("a grant's own Resource path should itself be covered")
	}
}

func TestRevoke_InvalidatesBeforeNaturalExpiry(t *testing.T) {
	m := NewManager()
	grant, err := m.GrantFSRead("sess-1", "/data/g1", time.Hour, "test")
	if err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	ok, _ := m.CheckFSRead("sess-1", "/data/g1/x")
	if !ok {
		t.Fatal("expected access before revocation")
	}
	m.Revoke(grant.ID)
	ok, _ = m.CheckFSRead("sess-1", "/data/g1/x")
	if ok {
		t.Fatal("expected denial after revocation, well before natural expiry")
	}
}

func TestRevoke_UnknownIDIsANoOp(t *testing.T) {
	m := NewManager()
	m.Revoke("no-such-grant") // must not panic
}

func TestAudit_RecordsGrantAndBothCheckOutcomes(t *testing.T) {
	start := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockVal, clock := fakeClock(start)
	m := NewManagerWithClock(clock)

	grant, err := m.GrantFSRead("sess-1", "/data/g1", time.Minute, "test")
	if err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	m.CheckFSRead("sess-1", "/data/g1/x") // allowed
	*clockVal = grant.ExpiresAt.Add(time.Second)
	m.CheckFSRead("sess-1", "/data/g1/x") // denied, expired

	events := m.Audit()
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e.Kind)
	}
	wantSeq := []string{"granted", "checked_allowed", "checked_denied_expired"}
	if len(kinds) != len(wantSeq) {
		t.Fatalf("audit kinds = %v, want %v", kinds, wantSeq)
	}
	for i, k := range wantSeq {
		if kinds[i] != k {
			t.Fatalf("audit[%d] = %q, want %q (full: %v)", i, kinds[i], k, kinds)
		}
	}
}

func TestAudit_ReturnsACopyNotTheLiveSlice(t *testing.T) {
	m := NewManager()
	if _, err := m.GrantFSRead("sess-1", "/data/g1", time.Hour, "test"); err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	first := m.Audit()
	if _, err := m.GrantFSRead("sess-1", "/data/g2", time.Hour, "test"); err != nil {
		t.Fatalf("GrantFSRead: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("a previously-returned Audit() slice must not grow when new events are recorded, got len=%d", len(first))
	}
}
