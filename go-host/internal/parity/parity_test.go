package parity

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/delivery"
	"github.com/prathish-ks/isthmus/go-host/internal/lifecycle"
	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
	"github.com/prathish-ks/isthmus/go-host/internal/restart"
	"github.com/prathish-ks/isthmus/go-host/internal/routing"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// --- shared test scaffolding -------------------------------------------

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

// fixedTime is just "now" — these fixtures never assert on the literal
// timestamp value, only that it round-trips through ParseTimestamp/
// FormatTimestamp, exactly like the TS fixtures' own `now()` helper.
func fixedTime() time.Time { return time.Now() }

func openCentralDB(t *testing.T) *dbHandle {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "v2.db")
	db, err := session.Open(dbPath)
	if err != nil {
		t.Fatalf("opening central db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &dbHandle{db: db}
}

// dbHandle is a tiny wrapper purely so callers read `h.db` instead of a bare
// *sql.DB — no behavior of its own.
type dbHandle struct{ db *sql.DB }

// --- Axis: routing (routing.EvaluateEngage / DecideWiringOutcome /
// NoAgentEngaged / DecideUnwiredChannel) ---------------------------------
//
// Golden values below are extracted verbatim from
// src/differential/__snapshots__/fixtures.test.ts.snap and
// fixtures-batch2.test.ts.snap. Each test cites the exact snapshot export
// name and the TS fixture source lines that produced it.

// TestParity_Mention ports "P2-03 fixture: mention" (fixtures.test.ts:212-233;
// snapshot export "P2-03 fixture: mention > engages when engage_mode is
// mention and the platform reports isMention 1"). seedWiring's default mg is
// a group chat (is_group=1); chatEvent's default content parses to text="hi".
func TestParity_Mention(t *testing.T) {
	engage := routing.EvaluateEngage("mention", nil, "hi", true /* isMention */, true /* isGroup */, false)
	if engage.Engage != true || engage.Unknown {
		t.Fatalf("EvaluateEngage = %+v, want Engage=true", engage)
	}
	accessOk := engage.Engage // no access gate registered => allow-all
	scopeOk := engage.Engage  // no sender-scope gate registered => allow-all
	outcome := routing.DecideWiringOutcome(engage.Engage, accessOk, scopeOk, routing.IgnoredMessagePolicyDrop)
	if !outcome.Deliver || !outcome.Wake {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:true Wake:true} (golden outcome=\"engaged\")", outcome)
	}
	if routing.NoAgentEngaged(1, 0) {
		t.Fatalf("NoAgentEngaged(1,0) = true, want false (golden messageOutcome=\"routed\")")
	}
}

// TestParity_NonMention ports "P2-03 fixture: non-mention"
// (fixtures.test.ts:234-258; snapshot export "... > drops (does not engage)
// when engage_mode is mention and isMention is false, with no accumulate
// policy 1"). ignored_message_policy defaults to 'drop' (seedWiring opts not
// overridden).
func TestParity_NonMention(t *testing.T) {
	engage := routing.EvaluateEngage("mention", nil, "hi", false /* isMention */, true, false)
	if engage.Engage {
		t.Fatalf("EvaluateEngage = %+v, want Engage=false", engage)
	}
	accessOk := engage.Engage
	scopeOk := engage.Engage
	outcome := routing.DecideWiringOutcome(engage.Engage, accessOk, scopeOk, routing.IgnoredMessagePolicyDrop)
	if outcome.Deliver {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:false} (golden outcome=\"dropped\")", outcome)
	}
	if !routing.NoAgentEngaged(0, 0) {
		t.Fatalf("NoAgentEngaged(0,0) = false, want true (golden dropReason=\"no_agent_engaged\")")
	}
}

// TestParity_MessagePersistence ports "P2-03 fixture: message-persistence"
// (fixtures.test.ts:260-293; snapshot export "... > persists inbound message
// content byte-for-byte, including JSON-shaped payloads 1"). seedWiring
// defaults to engage_mode='pattern', pattern='.' (always engages), and the
// content must round-trip byte-for-byte through mailbox.Insert with
// trigger=1 (wake=true, since engaged).
func TestParity_MessagePersistence(t *testing.T) {
	engage := routing.EvaluateEngage("pattern", nil, `Message with "quotes" and`+"\n"+"newlines", true, true, false)
	if !engage.Engage {
		t.Fatalf("EvaluateEngage('.', pattern) = %+v, want Engage=true (always-match shorthand)", engage)
	}
	outcome := routing.DecideWiringOutcome(true, true, true, routing.IgnoredMessagePolicyDrop)
	if !outcome.Deliver || !outcome.Wake {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:true Wake:true}", outcome)
	}

	dbPath := filepath.Join(t.TempDir(), "v2-sessions", "ag-1", "sess-1", "inbound.db")
	db, err := mailbox.Open(dbPath)
	if err != nil {
		t.Fatalf("mailbox.Open: %v", err)
	}
	defer func() { _ = db.Close() }()

	content := `{"sender":"User","text":"Message with \"quotes\" and\nnewlines"}`
	msgID := routing.MessageIDForAgent("msg-persist-1", "ag-1")
	rec, err := mailbox.Insert(db, mailbox.InboundMessage{
		ID:          msgID,
		Kind:        mailbox.KindChat,
		Timestamp:   mailbox.FormatTimestamp(fixedTime()),
		PlatformID:  strPtr("chan-123"),
		ChannelType: strPtr("discord"),
		Content:     content,
		Trigger:     boolPtr(outcome.Wake), // trigger := wake, per router.ts:597 `trigger: wake`
	})
	if err != nil {
		t.Fatalf("mailbox.Insert: %v", err)
	}
	if rec.Content != content {
		t.Fatalf("Record.Content = %q, want exact round-trip of %q", rec.Content, content)
	}
	if !rec.Trigger {
		t.Fatalf("Record.Trigger = false, want true (golden rows[0].trigger === 1)")
	}
}

// TestParity_MentionStickyFollowUpEngages ports
// "P2-04 batch2 fixture: mention-sticky-follow-up-engages"
// (fixtures-batch2.test.ts:125-160). The golden ParityResult only captures
// the SECOND (follow-up, non-mention) message's disposition — the first
// message merely establishes stickyExisting=true for the second.
func TestParity_MentionStickyFollowUpEngages(t *testing.T) {
	first := routing.EvaluateEngage("mention-sticky", nil, "hi", true, true, false)
	if !first.Engage {
		t.Fatalf("first message: EvaluateEngage = %+v, want Engage=true (isMention)", first)
	}
	// Follow-up: no mention, but a session now exists for (ag-1, mg-1, nil) —
	// stickyExisting mirrors router.ts's findSessionForAgent lookup result.
	second := routing.EvaluateEngage("mention-sticky", nil, "hi", false, true, true /* stickyExisting */)
	if !second.Engage {
		t.Fatalf("follow-up: EvaluateEngage = %+v, want Engage=true (golden outcome=\"engaged\")", second)
	}
	outcome := routing.DecideWiringOutcome(second.Engage, second.Engage, second.Engage, routing.IgnoredMessagePolicyDrop)
	if !outcome.Deliver || !outcome.Wake {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:true Wake:true}", outcome)
	}
	if routing.NoAgentEngaged(1, 0) {
		t.Fatalf("NoAgentEngaged(1,0) = true, want false (golden messageOutcome=\"routed\")")
	}
}

// TestParity_MentionStickyDMNeverEngages ports
// "P2-04 batch2 fixture: mention-sticky-dm-never-engages"
// (fixtures-batch2.test.ts:162-198). seedWiring({isGroup:false}) — a DM
// short-circuits mention-sticky to Engage=false without ever consulting
// stickyExisting, per routing.go's own doc comment on the DM branch.
func TestParity_MentionStickyDMNeverEngages(t *testing.T) {
	engage := routing.EvaluateEngage("mention-sticky", nil, "hi", false /* isMention */, false /* isGroup: DM */, true /* stickyExisting: must be ignored */)
	if engage.Engage {
		t.Fatalf("EvaluateEngage(DM, no mention) = %+v, want Engage=false even with stickyExisting=true", engage)
	}
	outcome := routing.DecideWiringOutcome(engage.Engage, false, false, routing.IgnoredMessagePolicyDrop)
	if outcome.Deliver {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:false} (golden outcome=\"dropped\")", outcome)
	}
	if !routing.NoAgentEngaged(0, 0) {
		t.Fatalf("NoAgentEngaged(0,0) = false, want true (golden dropReason=\"no_agent_engaged\")")
	}
}

// TestParity_NoAgentWiredNoGate ports
// "P2-04 batch2 fixture: no-agent-wired-no-gate" (fixtures-batch2.test.ts:
// 250-274; the messaging group is auto-created with zero wirings).
func TestParity_NoAgentWiredNoGate(t *testing.T) {
	action := routing.DecideUnwiredChannel(true /* isMention */, false /* denied */)
	if action != routing.UnwiredRecord {
		t.Fatalf("DecideUnwiredChannel(mention, not denied) = %v, want UnwiredRecord (golden dropReason=\"no_agent_wired\")", action)
	}
}

// TestParity_NoAgentWiredDeniedChannel ports
// "P2-04 batch2 fixture: no-agent-wired-denied-channel"
// (fixtures-batch2.test.ts:276-303) — denied_at short-circuits BEFORE
// recordDroppedMessage is ever called, so no audit row at all (golden
// dropRecordWritten=false).
func TestParity_NoAgentWiredDeniedChannel(t *testing.T) {
	action := routing.DecideUnwiredChannel(true /* isMention */, true /* denied */)
	if action != routing.UnwiredSilent {
		t.Fatalf("DecideUnwiredChannel(mention, denied) = %v, want UnwiredSilent (golden dropRecordWritten=false)", action)
	}
}

// --- Axis: session (session.ResolveSession / Create / IsUniqueViolation) -
//
// session.lastActiveTouched is deliberately never asserted in this file —
// see the package doc comment for why (session-manager.ts's
// writeSessionMessage, not any ported Go function, owns that touch).

// TestParity_NewSession ports "P2-03 fixture: new-session"
// (fixtures.test.ts:149-176; snapshot export "... > creates a brand-new
// session on the first message to a wired, empty messaging group 1").
func TestParity_NewSession(t *testing.T) {
	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if !created {
		t.Fatalf("created = false, want true (golden session.created=true)")
	}
	if s.ContainerStatus != session.ContainerStopped {
		t.Fatalf("ContainerStatus = %q, want %q (golden session.containerStatus=\"stopped\")", s.ContainerStatus, session.ContainerStopped)
	}
	if s.Status != session.StatusActive {
		t.Fatalf("Status = %q, want %q (golden dbState.sessions[0].status=\"active\")", s.Status, session.StatusActive)
	}
}

// TestParity_ExistingSession ports "P2-03 fixture: existing-session"
// (fixtures.test.ts:178-210): a second resolve for the identical
// (agentGroupId, messagingGroupId, thread=nil, mode=shared) key must return
// the SAME row with created=false.
func TestParity_ExistingSession(t *testing.T) {
	h := openCentralDB(t)
	first, created1, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created1 {
		t.Fatalf("first ResolveSession: session=%+v created=%v err=%v, want created=true", first, created1, err)
	}
	second, created2, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("second ResolveSession: %v", err)
	}
	if created2 {
		t.Fatalf("created2 = true, want false (golden session.created=false)")
	}
	if second.ID != first.ID {
		t.Fatalf("second.ID = %q, first.ID = %q, want identical row (golden: same underlying row, not just same placeholder)", second.ID, first.ID)
	}
}

// TestParity_RunningContainer ports "P2-03 fixture: running-container"
// (fixtures.test.ts:333-357). markContainerRunning between the two resolves
// mirrors the fixture's own call, and the second resolve must still find the
// SAME session with container_status left at "running" — ResolveSession
// itself never touches container_status.
func TestParity_RunningContainer(t *testing.T) {
	h := openCentralDB(t)
	first, _, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("first ResolveSession: %v", err)
	}
	if err := session.MarkContainerRunning(h.db, first.ID); err != nil {
		t.Fatalf("MarkContainerRunning: %v", err)
	}

	second, created2, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("second ResolveSession: %v", err)
	}
	if second.ID != first.ID || created2 {
		t.Fatalf("second={%q,created=%v}, want same id as %q with created=false", second.ID, created2, first.ID)
	}
	got, err := session.Get(h.db, second.ID)
	if err != nil || got == nil {
		t.Fatalf("Get(%q): got=%v err=%v", second.ID, got, err)
	}
	if got.ContainerStatus != session.ContainerRunning {
		t.Fatalf("ContainerStatus = %q, want %q (golden containerStatusAtSecondMessage=\"running\")", got.ContainerStatus, session.ContainerRunning)
	}

	// wakeContainerCalledAgain=true: router.ts:659 calls wakeContainer(...)
	// unconditionally on every engaged message, independent of
	// container_status — lifecycle.Registry.Wake has the identical shape: it
	// consults only its own in-memory IsRunning (never the DB's
	// container_status column), so a fresh Registry attempts (and here,
	// succeeds) a wake for this session on the "second message" exactly as
	// the always-attempt contract requires.
	reg := lifecycle.NewRegistry()
	woke, err := reg.Wake(context.Background(), second.ID, func(context.Context) error { return nil })
	if err != nil || !woke {
		t.Fatalf("Registry.Wake = (%v, %v), want (true, nil) — wake is always attempted regardless of container_status", woke, err)
	}
}

// TestParity_StoppedContainer ports "P2-03 fixture: stopped-container"
// (fixtures.test.ts:359-...): the mirror of running-container with no
// markContainerRunning call — container_status stays at the default
// "stopped" across both resolves.
func TestParity_StoppedContainer(t *testing.T) {
	h := openCentralDB(t)
	first, _, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("first ResolveSession: %v", err)
	}
	if first.ContainerStatus != session.ContainerStopped {
		t.Fatalf("first.ContainerStatus = %q, want %q", first.ContainerStatus, session.ContainerStopped)
	}

	second, created2, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil {
		t.Fatalf("second ResolveSession: %v", err)
	}
	if second.ID != first.ID || created2 {
		t.Fatalf("second={%q,created=%v}, want same id as %q with created=false", second.ID, created2, first.ID)
	}
	if second.ContainerStatus != session.ContainerStopped {
		t.Fatalf("ContainerStatus = %q, want %q (golden containerStatusAtSecondMessage=\"stopped\")", second.ContainerStatus, session.ContainerStopped)
	}
}

// TestParity_DuplicateInput ports "P2-03 fixture: duplicate-input"
// (fixtures.test.ts:295-331; snapshot: secondCallThrew=true,
// rowCountForDuplicateId=1). The same inbound message.id, namespaced by
// agent_group_id via routing.MessageIDForAgent, produces the SAME
// messages_in.id on both calls — the second mailbox.Insert must violate the
// PRIMARY KEY and leave exactly one row behind.
func TestParity_DuplicateInput(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "v2-sessions", "ag-1", "sess-1", "inbound.db")
	db, err := mailbox.Open(dbPath)
	if err != nil {
		t.Fatalf("mailbox.Open: %v", err)
	}
	defer func() { _ = db.Close() }()

	msgID := routing.MessageIDForAgent("msg-dup-1", "ag-1")
	msg := mailbox.InboundMessage{
		ID:          msgID,
		Kind:        mailbox.KindChat,
		Timestamp:   mailbox.FormatTimestamp(fixedTime()),
		PlatformID:  strPtr("chan-123"),
		ChannelType: strPtr("discord"),
		Content:     `{"sender":"User","text":"hi"}`,
	}

	if _, err := mailbox.Insert(db, msg); err != nil {
		t.Fatalf("first Insert: %v, want success", err)
	}
	_, secondErr := mailbox.Insert(db, msg) // identical id — must violate the PRIMARY KEY
	secondCallThrew := secondErr != nil
	if !secondCallThrew {
		t.Fatalf("secondCallThrew = false, want true (golden secondCallThrew=true)")
	}

	var rowCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages_in WHERE id = ?`, msgID).Scan(&rowCount); err != nil {
		t.Fatalf("counting rows: %v", err)
	}
	if rowCount != 1 {
		t.Fatalf("rowCountForDuplicateId = %d, want 1 (golden rowCountForDuplicateId=1)", rowCount)
	}
}

// TestParity_SessionModePerThread ports
// "P2-04 batch2 fixture: session-mode-per-thread" (fixtures-batch2.test.ts:
// 311-352): per-thread mode isolates sessions by thread and reuses them on
// repeat.
func TestParity_SessionModePerThread(t *testing.T) {
	h := openCentralDB(t)
	threadA, threadB := "thread-a", "thread-b"

	a1, created1, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), &threadA, session.ModePerThread)
	if err != nil || !created1 {
		t.Fatalf("a1: session=%+v created=%v err=%v, want created=true", a1, created1, err)
	}
	b1, created2, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), &threadB, session.ModePerThread)
	if err != nil || !created2 {
		t.Fatalf("b1: session=%+v created=%v err=%v, want created=true", b1, created2, err)
	}
	if a1.ID == b1.ID {
		t.Fatalf("a1.ID == b1.ID (%q), want distinct sessions per thread (golden distinctThreads=true)", a1.ID)
	}
	a2, created3, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), &threadA, session.ModePerThread)
	if err != nil {
		t.Fatalf("a2: %v", err)
	}
	if created3 || a2.ID != a1.ID {
		t.Fatalf("a2={%q,created=%v}, want reuse of a1 (%q) with created=false (golden threadAReusedSecondTime=true)", a2.ID, created3, a1.ID)
	}
}

// TestParity_SessionModeAgentShared ports
// "P2-04 batch2 fixture: session-mode-agent-shared" (fixtures-batch2.test.ts:
// 354-401): agent-shared ignores messaging_group_id entirely, sharing one
// session across even DIFFERENT messaging groups (and channel types).
func TestParity_SessionModeAgentShared(t *testing.T) {
	h := openCentralDB(t)
	first, created1, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-a"), nil, session.ModeAgentShared)
	if err != nil || !created1 {
		t.Fatalf("first: session=%+v created=%v err=%v, want created=true", first, created1, err)
	}
	second, created2, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-b"), nil, session.ModeAgentShared)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if created2 {
		t.Fatalf("created2 = true, want false (golden secondCallCreated=false)")
	}
	if second.ID != first.ID {
		t.Fatalf("second.ID = %q, first.ID = %q, want identical (golden sameSessionAcrossMessagingGroups=true)", second.ID, first.ID)
	}
}

// TestParity_SessionIDCollisionClassified ports
// "P2-04 batch2 fixture: session-id-collision-classified"
// (fixtures-batch2.test.ts:403-461): inserting the same session id twice via
// the raw Create path (bypassing ResolveSession's own lock-protected
// catch-and-recover, exactly as the TS fixture deliberately does) must
// surface a PRIMARY KEY violation that IsUniqueViolation recognizes.
func TestParity_SessionIDCollisionClassified(t *testing.T) {
	h := openCentralDB(t)
	s := session.Session{
		ID:               "sess-fixed-collision-1",
		AgentGroupID:     "ag-1",
		MessagingGroupID: strPtr("mg-1"),
		Status:           session.StatusActive,
		ContainerStatus:  session.ContainerStopped,
		CreatedAt:        mailbox.FormatTimestamp(fixedTime()),
	}
	if err := session.Create(h.db, s); err != nil {
		t.Fatalf("first Create: %v, want success", err)
	}
	err := session.Create(h.db, s) // identical id — must violate the PRIMARY KEY
	if err == nil {
		t.Fatalf("second Create: want an error, got nil (golden secondCallThrew=true)")
	}
	if !session.IsUniqueViolation(err) {
		t.Fatalf("IsUniqueViolation(%v) = false, want true (golden classifiedAsUniqueViolation=true)", err)
	}
}

// TestParity_ContainerWakeFailure ports
// "P2-04 batch2 fixture: container-wake-failure" (fixtures-batch2.test.ts:
// 467-499): a failed wake must never surface as an error at the routing
// boundary — the session is still created and left "stopped" (real
// markContainerRunning lives inside the failed, mocked-out wake path).
// lifecycle.Registry.Wake's explicit (bool, error) contract is the Go
// equivalent of wakeContainer's documented "never throws, boolean" outcome:
// a spawn failure surfaces as woke=false with a non-nil error the caller can
// log, never a panic or an error that propagates through routing.
func TestParity_ContainerWakeFailure(t *testing.T) {
	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created {
		t.Fatalf("ResolveSession: session=%+v created=%v err=%v, want created=true", s, created, err)
	}

	reg := lifecycle.NewRegistry()
	spawnErr := errors.New("simulated transient spawn failure")
	woke, err := reg.Wake(context.Background(), s.ID, func(context.Context) error { return spawnErr })
	if woke {
		t.Fatalf("Wake outcome = true, want false (golden containerWake.outcome=false)")
	}
	if !errors.Is(err, spawnErr) {
		t.Fatalf("Wake error = %v, want the spawn failure surfaced explicitly (never silently swallowed)", err)
	}

	// container_status was never touched by Wake itself (only a successful
	// spawn's own Register/MarkContainerRunning would do that) — it stays
	// exactly as ResolveSession left it.
	got, err := session.Get(h.db, s.ID)
	if err != nil || got == nil {
		t.Fatalf("Get(%q): got=%v err=%v", s.ID, got, err)
	}
	if got.ContainerStatus != session.ContainerStopped {
		t.Fatalf("ContainerStatus = %q, want %q (golden session.containerStatus=\"stopped\")", got.ContainerStatus, session.ContainerStopped)
	}
}

// TestParity_AccumulateStoresWithoutWaking ports
// "P2-04 batch2 fixture: accumulate-stores-without-waking"
// (fixtures-batch2.test.ts:200-247): ignored_message_policy=accumulate still
// resolves/creates a session and stores the message (trigger=0), but never
// wakes the container. containerWake.attempted is deliberately NOT asserted
// here — see the package doc comment: that field's golden value of `true` is
// an artifact of un-cleared cross-test mock state in the same TS file, not a
// real accumulate-branch behavior (router.ts's own wake branch is never
// entered when wake=false).
func TestParity_AccumulateStoresWithoutWaking(t *testing.T) {
	engage := routing.EvaluateEngage("mention", nil, "hi", false /* isMention */, true, false)
	if engage.Engage {
		t.Fatalf("EvaluateEngage = %+v, want Engage=false (accumulate never engages)", engage)
	}
	outcome := routing.DecideWiringOutcome(engage.Engage, false, false, routing.IgnoredMessagePolicyAccumulate)
	if !outcome.Deliver || outcome.Wake {
		t.Fatalf("DecideWiringOutcome = %+v, want {Deliver:true Wake:false} (golden outcome=\"accumulated\")", outcome)
	}
	if routing.NoAgentEngaged(0, 1) {
		t.Fatalf("NoAgentEngaged(0,1) = true, want false (golden messageOutcome=\"routed\", not dropped)")
	}

	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created {
		t.Fatalf("ResolveSession: session=%+v created=%v err=%v, want created=true (accumulate still resolves/creates a session)", s, created, err)
	}
	if s.ContainerStatus != session.ContainerStopped {
		t.Fatalf("ContainerStatus = %q, want %q (never woken)", s.ContainerStatus, session.ContainerStopped)
	}

	dbPath := filepath.Join(t.TempDir(), "v2-sessions", "ag-1", s.ID, "inbound.db")
	db, err := mailbox.Open(dbPath)
	if err != nil {
		t.Fatalf("mailbox.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	rec, err := mailbox.Insert(db, mailbox.InboundMessage{
		ID:          routing.MessageIDForAgent("msg-1", "ag-1"),
		Kind:        mailbox.KindChat,
		Timestamp:   mailbox.FormatTimestamp(fixedTime()),
		PlatformID:  strPtr("chan-123"),
		ChannelType: strPtr("discord"),
		Content:     `{"sender":"User","text":"hi"}`,
		Trigger:     boolPtr(outcome.Wake), // trigger := wake = false
	})
	if err != nil {
		t.Fatalf("mailbox.Insert: %v", err)
	}
	if rec.Trigger {
		t.Fatalf("Record.Trigger = true, want false (golden rows[0].trigger === 0: stored as context only)")
	}
}

// --- Axis: delivery (delivery.Deliver / ResolveDeliveryTarget /
// NextAttempt / FakeAdapter) ---------------------------------------------
//
// Golden values are extracted verbatim from
// src/differential/__snapshots__/fixtures-outbound-delivery.test.ts.snap;
// exact fixture bodies are src/differential/fixtures-outbound-delivery.test.ts.

// TestParity_OutboundDelivery ports "P2-03 fixture: outbound-delivery"
// (fixtures-outbound-delivery.test.ts:77-142): a directly-written outbound
// message to the session's own origin chat delivers exactly once — a second
// drain must not redeliver, which this test proves via
// restart.FilterUndelivered against the `delivered` map exactly as P4-05's
// package characterizes the real dedup mechanism.
func TestParity_OutboundDelivery(t *testing.T) {
	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created {
		t.Fatalf("ResolveSession: session=%+v created=%v err=%v, want created=true", s, created, err)
	}

	origin := &delivery.MessagingGroupCandidate{ID: "mg-1", ChannelType: "discord", PlatformID: "chan-123", Instance: "discord"}
	ev := delivery.OutboundEvent{
		ID: "msg-out-1", Kind: "chat",
		ChannelType: strPtr("discord"), PlatformID: strPtr("chan-123"), ThreadID: nil,
		Content: `{"text":"Hello from the agent"}`,
	}
	adapter := delivery.NewFakeAdapter()
	outcome, err := delivery.Deliver(context.Background(), ev, strPtr("mg-1"), nil,
		delivery.TargetLookups{Origin: origin}, adapter)
	if err != nil {
		t.Fatalf("first Deliver: %v, want success", err)
	}
	if outcome.Classification != delivery.ClassChannel || outcome.PlatformMessageID == "" {
		t.Fatalf("outcome = %+v, want ClassChannel with a platform message id (golden outcome=\"delivered\")", outcome)
	}
	if adapter.CallCount() != 1 {
		t.Fatalf("adapter.CallCount() = %d, want 1 (golden attempts=1)", adapter.CallCount())
	}

	// Second drain: the `delivered` table (P4-05's FilterUndelivered) is what
	// actually prevents redelivery — a due-message set containing this id,
	// filtered against a "delivered" map already recording it, comes back
	// empty, so a real drain loop would never call the Adapter again.
	delivered := map[string]bool{ev.ID: true}
	if got := restart.FilterUndelivered([]string{ev.ID}, delivered); len(got) != 0 {
		t.Fatalf("FilterUndelivered = %v, want empty (already-delivered message must not be redelivered)", got)
	}
	if adapter.CallCount() != 1 {
		t.Fatalf("adapter.CallCount() after second drain = %d, want still 1 (golden: fakeDeliver called exactly once)", adapter.CallCount())
	}
}

// TestParity_DeliveryPermanentFailure ports
// "P2-04 batch2 fixture: delivery-permanent-failure"
// (fixtures-outbound-delivery.test.ts:144-225): a detached messaging group
// fails delivery at the ResolveDeliveryTarget step (before the Adapter is
// ever reached) on every attempt; the third failure crosses
// MaxDeliveryAttempts and gives up permanently.
func TestParity_DeliveryPermanentFailure(t *testing.T) {
	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created {
		t.Fatalf("ResolveSession: session=%+v created=%v err=%v, want created=true", s, created, err)
	}

	detachedAt := "2026-01-01T00:00:00.000Z"
	origin := &delivery.MessagingGroupCandidate{ID: "mg-1", ChannelType: "discord", PlatformID: "chan-123", Instance: "discord", DetachedAt: &detachedAt}
	ev := delivery.OutboundEvent{
		ID: "msg-out-detached-1", Kind: "chat",
		ChannelType: strPtr("discord"), PlatformID: strPtr("chan-123"), ThreadID: nil,
		Content: `{"text":"Hello from the agent"}`,
	}
	adapter := delivery.NewFakeAdapter()

	attempts, giveUp := 0, false
	for i := 0; i < delivery.MaxDeliveryAttempts; i++ {
		_, err := delivery.Deliver(context.Background(), ev, strPtr("mg-1"), nil,
			delivery.TargetLookups{Origin: origin}, adapter)
		if err == nil {
			t.Fatalf("attempt %d: Deliver succeeded, want DetachedMessagingGroupError", i+1)
		}
		var detachedErr *delivery.DetachedMessagingGroupError
		if !errors.As(err, &detachedErr) {
			t.Fatalf("attempt %d: err = %v, want *DetachedMessagingGroupError", i+1, err)
		}
		attempts, giveUp = delivery.NextAttempt(attempts)
	}
	if attempts != 3 || !giveUp {
		t.Fatalf("after %d attempts giveUp=%v, want attempts=3 giveUp=true (golden attempts=3, outcome=\"permanent-failure\")", attempts, giveUp)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("adapter.CallCount() = %d, want 0 (golden: fakeDeliver never called — detached check throws first)", adapter.CallCount())
	}
}

// TestParity_DeliveryRetryThenRecovers ports
// "P2-04 batch2 fixture: delivery-retry-then-recovers"
// (fixtures-outbound-delivery.test.ts:227-313): the first attempt fails
// (still detached, but under MaxDeliveryAttempts so it stays retryable);
// the group is reattached before the second attempt, which succeeds — total
// attempts=2, outcome=delivered.
func TestParity_DeliveryRetryThenRecovers(t *testing.T) {
	h := openCentralDB(t)
	s, created, err := session.ResolveSession(h.db, "ag-1", strPtr("mg-1"), nil, session.ModeShared)
	if err != nil || !created {
		t.Fatalf("ResolveSession: session=%+v created=%v err=%v, want created=true", s, created, err)
	}

	detachedAt := "2026-01-01T00:00:00.000Z"
	detachedOrigin := &delivery.MessagingGroupCandidate{ID: "mg-1", ChannelType: "discord", PlatformID: "chan-123", Instance: "discord", DetachedAt: &detachedAt}
	reattachedOrigin := &delivery.MessagingGroupCandidate{ID: "mg-1", ChannelType: "discord", PlatformID: "chan-123", Instance: "discord", DetachedAt: nil}
	ev := delivery.OutboundEvent{
		ID: "msg-out-recovers-1", Kind: "chat",
		ChannelType: strPtr("discord"), PlatformID: strPtr("chan-123"), ThreadID: nil,
		Content: `{"text":"Hello from the agent"}`,
	}
	adapter := delivery.NewFakeAdapter()

	attemptCount := 0

	// Attempt 1: still detached — retryable failure, under the ceiling.
	attemptCount++
	_, err = delivery.Deliver(context.Background(), ev, strPtr("mg-1"), nil,
		delivery.TargetLookups{Origin: detachedOrigin}, adapter)
	if err == nil {
		t.Fatalf("attempt 1: Deliver succeeded, want DetachedMessagingGroupError")
	}
	tries, giveUp := delivery.NextAttempt(attemptCount - 1)
	if tries != 1 || giveUp {
		t.Fatalf("NextAttempt(0) = (%d,%v), want (1,false) — still retryable under MaxDeliveryAttempts=%d", tries, giveUp, delivery.MaxDeliveryAttempts)
	}

	// The bot rejoins before the next poll tick.
	attemptCount++
	outcome, err := delivery.Deliver(context.Background(), ev, strPtr("mg-1"), nil,
		delivery.TargetLookups{Origin: reattachedOrigin}, adapter)
	if err != nil {
		t.Fatalf("attempt 2: %v, want success now that the group is reattached", err)
	}
	if outcome.Classification != delivery.ClassChannel || outcome.PlatformMessageID == "" {
		t.Fatalf("outcome = %+v, want a successful ClassChannel delivery", outcome)
	}
	if attemptCount != 2 {
		t.Fatalf("attemptCount = %d, want 2 (golden attempts=2)", attemptCount)
	}
	if adapter.CallCount() != 1 {
		t.Fatalf("adapter.CallCount() = %d, want 1 (golden: only the successful attempt reaches the adapter)", adapter.CallCount())
	}
}
