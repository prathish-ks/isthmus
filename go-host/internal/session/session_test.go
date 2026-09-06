package session

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// openTestDB gives each test its own throwaway central DB file, mirroring
// the differential fixtures' fresh-DB-per-test isolation (initTestDb +
// runMigrations in beforeEach).
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "v2.db")
	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func strp(s string) *string { return &s }

// TestResolveSession_SharedMode mirrors resolveSession's 'shared' branch
// (one session per messaging group, ignoring threadID) — the default
// session_mode used throughout src/differential/fixtures.test.ts's own
// wiring, even though no batch2 fixture names it directly; it's exercised
// here as the third of resolveSession's three documented modes.
func TestResolveSession_SharedMode(t *testing.T) {
	db := openTestDB(t)

	a1, created1, err := ResolveSession(db, "ag-1", strp("mg-1"), strp("thread-a"), ModeShared)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if !created1 {
		t.Fatalf("expected first call to create a session")
	}

	// Different thread, same messaging group, mode=shared: threadID is
	// ignored, so this must resolve to the SAME session, not a new one.
	a2, created2, err := ResolveSession(db, "ag-1", strp("mg-1"), strp("thread-b"), ModeShared)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if created2 {
		t.Fatalf("expected second call (different thread, mode=shared) to reuse the session, not create one")
	}
	if a2.ID != a1.ID {
		t.Fatalf("shared mode must ignore threadID: got different session ids %q vs %q", a1.ID, a2.ID)
	}
	if a1.ThreadID != nil {
		t.Fatalf("shared mode session must have a nil thread_id, got %v", a1.ThreadID)
	}
}

// TestResolveSession_PerThreadMode reproduces
// src/differential/fixtures-batch2.test.ts's "session-mode-per-thread"
// scenario: resolveSession isolates sessions per thread and reuses them on
// repeat.
func TestResolveSession_PerThreadMode(t *testing.T) {
	db := openTestDB(t)

	a1, created, err := ResolveSession(db, "ag-1", strp("mg-1"), strp("thread-a"), ModePerThread)
	if err != nil {
		t.Fatalf("ResolveSession(thread-a): %v", err)
	}
	if !created {
		t.Fatalf("expected thread-a's first resolution to create a session")
	}

	b1, created, err := ResolveSession(db, "ag-1", strp("mg-1"), strp("thread-b"), ModePerThread)
	if err != nil {
		t.Fatalf("ResolveSession(thread-b): %v", err)
	}
	if !created {
		t.Fatalf("expected thread-b's first resolution to create a session")
	}
	if a1.ID == b1.ID {
		t.Fatalf("per-thread mode must isolate distinct threads: got the same session id %q for both", a1.ID)
	}

	a2, created, err := ResolveSession(db, "ag-1", strp("mg-1"), strp("thread-a"), ModePerThread)
	if err != nil {
		t.Fatalf("ResolveSession(thread-a, repeat): %v", err)
	}
	if created {
		t.Fatalf("expected thread-a's second resolution to reuse the existing session")
	}
	if a2.ID != a1.ID {
		t.Fatalf("expected thread-a's second resolution to return the same session id, got %q vs %q", a2.ID, a1.ID)
	}
}

// TestResolveSession_AgentSharedMode reproduces
// src/differential/fixtures-batch2.test.ts's "session-mode-agent-shared"
// scenario: resolveSession shares one session per agent group across
// DIFFERENT messaging groups (even different channel types) when
// session_mode=agent-shared.
func TestResolveSession_AgentSharedMode(t *testing.T) {
	db := openTestDB(t)

	first, created, err := ResolveSession(db, "ag-1", strp("mg-a"), nil, ModeAgentShared)
	if err != nil {
		t.Fatalf("ResolveSession(mg-a): %v", err)
	}
	if !created {
		t.Fatalf("expected the first agent-shared resolution to create a session")
	}

	second, created, err := ResolveSession(db, "ag-1", strp("mg-b"), nil, ModeAgentShared)
	if err != nil {
		t.Fatalf("ResolveSession(mg-b): %v", err)
	}
	if created {
		t.Fatalf("expected the second call (different messaging group, agent-shared) to reuse the session, not create one")
	}
	if second.ID != first.ID {
		t.Fatalf("agent-shared mode must ignore messagingGroupID: got different session ids %q vs %q", first.ID, second.ID)
	}
}

// TestIsUniqueViolation_SessionIDCollision reproduces
// src/differential/fixtures-batch2.test.ts's
// "session-id-collision-classified" scenario: a duplicate session id throws
// a constraint error that IsUniqueViolation recognizes.
func TestIsUniqueViolation_SessionIDCollision(t *testing.T) {
	db := openTestDB(t)

	s := Session{
		ID:               "sess-fixed-collision-1",
		AgentGroupID:     "ag-1",
		MessagingGroupID: strp("mg-1"),
		ThreadID:         nil,
		AgentProvider:    nil,
		Status:           StatusActive,
		ContainerStatus:  ContainerStopped,
		LastActive:       nil,
		CreatedAt:        "2026-09-01T00:00:00.000Z",
	}

	if err := Create(db, s); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	err := Create(db, s) // identical id — must violate the PRIMARY KEY
	if err == nil {
		t.Fatalf("expected the second Create with a duplicate id to fail")
	}
	if !IsUniqueViolation(err) {
		t.Fatalf("expected IsUniqueViolation(err) to be true, got false for error: %v", err)
	}
}

// TestResolveSession_ContainerWakeFailureLeavesSessionStopped reproduces the
// session-lifecycle half of "container-wake-failure": a session created
// during resolution starts, and stays, container_status='stopped' — nothing
// about a failed (or not-yet-attempted) wake touches the session row. Wake
// itself is container-runner.ts territory (P4-03), not this package.
func TestResolveSession_ContainerWakeFailureLeavesSessionStopped(t *testing.T) {
	db := openTestDB(t)

	s, created, err := ResolveSession(db, "ag-1", strp("mg-1"), nil, ModeShared)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if !created {
		t.Fatalf("expected a fresh session to be created")
	}
	if s.ContainerStatus != ContainerStopped {
		t.Fatalf("expected a newly created session to start container_status=stopped, got %q", s.ContainerStatus)
	}

	got, err := Get(db, s.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatalf("expected Get to find the session just created")
	}
	if got.ContainerStatus != ContainerStopped {
		t.Fatalf("expected container_status to remain stopped absent any wake, got %q", got.ContainerStatus)
	}
}

// TestMarkContainerRunning_TouchesStatusAndLastActive mirrors
// session-manager.ts's markContainerRunning: sets container_status='running'
// and touches last_active.
func TestMarkContainerRunning_TouchesStatusAndLastActive(t *testing.T) {
	db := openTestDB(t)

	s, _, err := ResolveSession(db, "ag-1", strp("mg-1"), nil, ModeShared)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if s.LastActive != nil {
		t.Fatalf("expected a freshly created session to have a nil last_active")
	}

	if err := MarkContainerRunning(db, s.ID); err != nil {
		t.Fatalf("MarkContainerRunning: %v", err)
	}

	got, err := Get(db, s.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ContainerStatus != ContainerRunning {
		t.Fatalf("expected container_status=running, got %q", got.ContainerStatus)
	}
	if got.LastActive == nil {
		t.Fatalf("expected last_active to be touched")
	}
}

// TestFindForAgent_ScopesByAgentGroup mirrors the fan-out rationale in
// db/sessions.ts's own doc comment: two different agent groups wired to the
// same messaging group + thread must resolve to two distinct sessions, not
// whichever happened to be created first.
func TestFindForAgent_ScopesByAgentGroup(t *testing.T) {
	db := openTestDB(t)

	agentA, _, err := ResolveSession(db, "ag-a", strp("mg-1"), strp("thread-x"), ModePerThread)
	if err != nil {
		t.Fatalf("ResolveSession(ag-a): %v", err)
	}
	agentB, _, err := ResolveSession(db, "ag-b", strp("mg-1"), strp("thread-x"), ModePerThread)
	if err != nil {
		t.Fatalf("ResolveSession(ag-b): %v", err)
	}
	if agentA.ID == agentB.ID {
		t.Fatalf("expected distinct agent groups on the same (messaging group, thread) to get distinct sessions")
	}

	found, err := FindForAgent(db, "ag-a", "mg-1", strp("thread-x"))
	if err != nil {
		t.Fatalf("FindForAgent: %v", err)
	}
	if found == nil || found.ID != agentA.ID {
		t.Fatalf("expected FindForAgent(ag-a, ...) to return ag-a's session, got %+v", found)
	}
}

// TestIsTaskThread mirrors db/sessions.ts's isTaskThread contract directly
// (the exact-match and prefix-match branches), independent of
// ShouldCloseTaskSession's own combination logic in internal/lifecycle.
func TestIsTaskThread(t *testing.T) {
	if IsTaskThread(nil) {
		t.Fatalf("expected a nil thread id not to be a task thread")
	}
	if !IsTaskThread(strp(TasksSystemThreadID)) {
		t.Fatalf("expected the bare tasks-system thread id to be a task thread")
	}
	if !IsTaskThread(strp(TasksSystemThreadID + ":task-1")) {
		t.Fatalf("expected a namespaced task thread id to be a task thread")
	}
	if IsTaskThread(strp("telegram:12345")) {
		t.Fatalf("expected an unrelated thread id not to be a task thread")
	}
	if IsTaskThread(strp("system:tasksx")) {
		t.Fatalf("expected a merely-prefix-sharing thread id not to be a task thread (no ':' boundary)")
	}
}
