package mailbox

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "inbound.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func fixedTimestamp() string {
	return FormatTimestamp(time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC))
}

func TestPathMatchesTypeScriptLayout(t *testing.T) {
	got := Path("/data", "ag-1", "sess-1")
	want := filepath.Join("/data", "v2-sessions", "ag-1", "sess-1", "inbound.db")
	if got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
}

func TestFormatTimestampRoundTripsThroughParseTimestamp(t *testing.T) {
	ts := FormatTimestamp(time.Date(2026, 9, 1, 12, 30, 45, 123000000, time.UTC))
	if ts != "2026-09-01T12:30:45.123Z" {
		t.Fatalf("FormatTimestamp() = %q, want 2026-09-01T12:30:45.123Z", ts)
	}
	if _, err := ParseTimestamp(ts); err != nil {
		t.Errorf("ParseTimestamp(%q) error = %v, want nil", ts, err)
	}
}

func TestParseTimestampRejectsNonCanonicalForms(t *testing.T) {
	cases := []string{
		"2026-09-01T12:30:45Z",          // missing milliseconds
		"2026-09-01T12:30:45.123",       // missing Z
		"2026-09-01T08:30:45.123-04:00", // non-UTC offset, same instant
		"not a timestamp",
	}
	for _, c := range cases {
		if _, err := ParseTimestamp(c); err == nil {
			t.Errorf("ParseTimestamp(%q) error = nil, want an error (not a canonical UTC toISOString value)", c)
		}
	}
}

func TestOpenCreatesSchemaIdempotently(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "nested", "inbound.db")

	db1, err := Open(dbPath)
	if err != nil {
		t.Fatalf("first Open() error = %v", err)
	}
	_ = db1.Close()

	// Re-opening an existing file must not fail or clobber the schema.
	db2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("second Open() error = %v", err)
	}
	defer func() { _ = db2.Close() }()

	for _, table := range []string{"messages_in", "delivered", "destinations", "session_routing"} {
		var name string
		err := db2.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %q missing after Open(): %v", table, err)
		}
	}
}

func TestInsertAppliesDefaultsMatchingCreateInboundRecord(t *testing.T) {
	db := openTestDB(t)

	rec, err := Insert(db, InboundMessage{
		ID:        "msg-1",
		Kind:      KindChat,
		Timestamp: fixedTimestamp(),
		Content:   `{"text":"hello"}`,
	})
	if err != nil {
		t.Fatalf("Insert() error = %v", err)
	}

	if rec.Status != "pending" {
		t.Errorf("Status = %q, want pending", rec.Status)
	}
	if rec.SeriesID != "msg-1" {
		t.Errorf("SeriesID = %q, want msg-1 (defaults to the message's own id)", rec.SeriesID)
	}
	if rec.Tries != 0 {
		t.Errorf("Tries = %d, want 0", rec.Tries)
	}
	if !rec.Trigger {
		t.Errorf("Trigger = false, want true (default per createInboundRecord)")
	}
	if rec.SourceSessionID != nil {
		t.Errorf("SourceSessionID = %v, want nil", rec.SourceSessionID)
	}
	if rec.OnWake {
		t.Errorf("OnWake = true, want false (default)")
	}
	if rec.Sequence != 2 {
		t.Errorf("Sequence = %d, want 2 (first even seq)", rec.Sequence)
	}
}

func TestInsertHonorsExplicitOverrides(t *testing.T) {
	db := openTestDB(t)

	trigger := false
	onWake := true
	sourceSession := "sess-parent"

	rec, err := Insert(db, InboundMessage{
		ID:              "msg-1",
		Kind:            KindSystem,
		Timestamp:       fixedTimestamp(),
		Content:         `{"action":"noop"}`,
		Trigger:         &trigger,
		OnWake:          &onWake,
		SourceSessionID: &sourceSession,
	})
	if err != nil {
		t.Fatalf("Insert() error = %v", err)
	}

	if rec.Trigger {
		t.Errorf("Trigger = true, want false (explicit override)")
	}
	if !rec.OnWake {
		t.Errorf("OnWake = false, want true (explicit override)")
	}
	if rec.SourceSessionID == nil || *rec.SourceSessionID != "sess-parent" {
		t.Errorf("SourceSessionID = %v, want sess-parent", rec.SourceSessionID)
	}
}

func TestNextEvenSeqAllocatesEvenNumbersOnly(t *testing.T) {
	db := openTestDB(t)

	first, err := Insert(db, InboundMessage{ID: "m1", Kind: KindChat, Timestamp: fixedTimestamp(), Content: "{}"})
	if err != nil {
		t.Fatalf("Insert(m1) error = %v", err)
	}
	second, err := Insert(db, InboundMessage{ID: "m2", Kind: KindChat, Timestamp: fixedTimestamp(), Content: "{}"})
	if err != nil {
		t.Fatalf("Insert(m2) error = %v", err)
	}

	if first.Sequence != 2 || second.Sequence != 4 {
		t.Errorf("sequences = %d, %d, want 2, 4", first.Sequence, second.Sequence)
	}
}

func TestInsertRejectsInvalidKind(t *testing.T) {
	db := openTestDB(t)

	_, err := Insert(db, InboundMessage{
		ID:        "msg-1",
		Kind:      InboundKind("not-a-real-kind"),
		Timestamp: fixedTimestamp(),
		Content:   "{}",
	})
	if err == nil {
		t.Fatal("Insert() error = nil, want an error for an invalid kind")
	}
}

func TestInsertRejectsNonCanonicalTimestamp(t *testing.T) {
	db := openTestDB(t)

	_, err := Insert(db, InboundMessage{
		ID:        "msg-1",
		Kind:      KindChat,
		Timestamp: "2026-09-01T12:00:00Z", // missing milliseconds
		Content:   "{}",
	})
	if err == nil {
		t.Fatal("Insert() error = nil, want an error for a non-canonical timestamp")
	}
}

func TestInsertRejectsEmptyContent(t *testing.T) {
	db := openTestDB(t)

	_, err := Insert(db, InboundMessage{
		ID:        "msg-1",
		Kind:      KindChat,
		Timestamp: fixedTimestamp(),
		Content:   "",
	})
	if err == nil {
		t.Fatal("Insert() error = nil, want an error for empty content")
	}
}

func TestInsertRejectsDuplicateID(t *testing.T) {
	db := openTestDB(t)

	msg := InboundMessage{ID: "dup", Kind: KindChat, Timestamp: fixedTimestamp(), Content: "{}"}
	if _, err := Insert(db, msg); err != nil {
		t.Fatalf("first Insert() error = %v", err)
	}
	if _, err := Insert(db, msg); err == nil {
		t.Fatal("second Insert() with the same id error = nil, want a primary-key conflict error")
	}
}

func TestInsertPersistsRowReadableViaPlainSQL(t *testing.T) {
	// This is the closest a unit test can get to P3-03's actual deliverable
	// ("an integration test shows original agent-runner can read the
	// Go-created message") without running the real Bun agent-runner: read
	// the row back with a bare SQL query, the same way any other SQLite
	// client — including better-sqlite3 in the container — would.
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "inbound.db")
	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer func() { _ = db.Close() }()

	if _, err := Insert(db, InboundMessage{
		ID:        "msg-1",
		Kind:      KindChat,
		Timestamp: fixedTimestamp(),
		Content:   `{"text":"hello from Go"}`,
	}); err != nil {
		t.Fatalf("Insert() error = %v", err)
	}

	var kind, content, status string
	var seq, tries, trigger, onWake int
	err = db.QueryRow(
		`SELECT kind, content, status, seq, tries, trigger, on_wake FROM messages_in WHERE id = ?`, "msg-1",
	).Scan(&kind, &content, &status, &seq, &tries, &trigger, &onWake)
	if err != nil {
		t.Fatalf("reading back row: %v", err)
	}

	if kind != "chat" || content != `{"text":"hello from Go"}` || status != "pending" {
		t.Errorf("row = (kind=%q, content=%q, status=%q), unexpected", kind, content, status)
	}
	if seq != 2 || tries != 0 || trigger != 1 || onWake != 0 {
		t.Errorf("row = (seq=%d, tries=%d, trigger=%d, on_wake=%d), unexpected", seq, tries, trigger, onWake)
	}
}
