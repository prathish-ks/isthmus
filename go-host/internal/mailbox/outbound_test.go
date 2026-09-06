package mailbox

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func openTestOutboundDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := OpenForSetup(filepath.Join(dir, "outbound.db"))
	if err != nil {
		t.Fatalf("OpenForSetup() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// insertOutboundRow writes a row directly with SQL, standing in for the real
// agent-runner container (the only real writer of messages_out) since this
// package deliberately implements no outbound writer of its own — P3-05's
// scope is reading, not writing.
func insertOutboundRow(t *testing.T, db *sql.DB, row outboundRow) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.id, row.seq, row.inReplyTo, row.timestamp, row.deliverAfter,
		row.recurrence, row.kind, row.platformID, row.channelType, row.threadID, row.content,
	)
	if err != nil {
		t.Fatalf("inserting outbound row %q: %v", row.id, err)
	}
}

func ts(offsetSeconds int) string {
	return FormatTimestamp(time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC).Add(time.Duration(offsetSeconds) * time.Second))
}

func nullStr(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }
func nullInt(i int64) sql.NullInt64   { return sql.NullInt64{Int64: i, Valid: true} }

func TestOutboundPathMatchesTypeScriptLayout(t *testing.T) {
	got := OutboundPath("/data", "ag-1", "sess-1")
	want := filepath.Join("/data", "v2-sessions", "ag-1", "sess-1", "outbound.db")
	if got != want {
		t.Errorf("OutboundPath() = %q, want %q", got, want)
	}
}

func TestOpenForSetupCreatesSchemaIdempotently(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "nested", "outbound.db")

	db1, err := OpenForSetup(dbPath)
	if err != nil {
		t.Fatalf("first OpenForSetup() error = %v", err)
	}
	_ = db1.Close()

	// Re-opening an existing file must not fail or clobber the schema —
	// mirrors ensureSchema('outbound')'s "CREATE TABLE IF NOT EXISTS" idempotency.
	db2, err := OpenForSetup(dbPath)
	if err != nil {
		t.Fatalf("second OpenForSetup() error = %v", err)
	}
	defer func() { _ = db2.Close() }()

	for _, table := range []string{"messages_out", "processing_ack", "session_state", "container_state"} {
		var name string
		err := db2.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %q missing after OpenForSetup(): %v", table, err)
		}
	}
}

func TestOpenReadOnlyRejectsMissingFile(t *testing.T) {
	dir := t.TempDir()
	_, err := OpenReadOnly(filepath.Join(dir, "does-not-exist.db"))
	if err == nil {
		t.Fatal("OpenReadOnly() error = nil, want an error for a mailbox that was never prepared")
	}
}

func TestOpenReadOnlyRejectsWrites(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "outbound.db")

	setup, err := OpenForSetup(dbPath)
	if err != nil {
		t.Fatalf("OpenForSetup() error = %v", err)
	}
	_ = setup.Close()

	db, err := OpenReadOnly(dbPath)
	if err != nil {
		t.Fatalf("OpenReadOnly() error = %v", err)
	}
	defer func() { _ = db.Close() }()

	_, err = db.Exec(
		`INSERT INTO messages_out (id, timestamp, kind, content) VALUES ('x', ?, 'chat', '{}')`, ts(0),
	)
	if err == nil {
		t.Fatal("write through a read-only connection succeeded, want an error (PRAGMA query_only should block it)")
	}
}

func TestDueOutboundReturnsDeterministicSingleReply(t *testing.T) {
	// The exact shape of P3-04's proof run: one container-written reply,
	// no deliver_after, odd sequence number.
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{
		id:        "msg-1788259724198-40ov7a",
		seq:       nullInt(3),
		timestamp: ts(0),
		kind:      "chat",
		content:   `{"text":"Not logged in · Please run /login"}`,
	})

	records, err := DueOutbound(db)
	if err != nil {
		t.Fatalf("DueOutbound() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("DueOutbound() returned %d records, want 1", len(records))
	}

	rec := records[0]
	if rec.ID != "msg-1788259724198-40ov7a" || rec.Kind != "chat" {
		t.Errorf("record = (id=%q, kind=%q), unexpected", rec.ID, rec.Kind)
	}
	if rec.Sequence == nil || *rec.Sequence != 3 {
		t.Errorf("Sequence = %v, want 3", rec.Sequence)
	}
	if rec.Sequence != nil && *rec.Sequence%2 == 0 {
		t.Errorf("Sequence = %d is even, want odd (container-writes-odd-seq invariant, confirmed live at P3-04)", *rec.Sequence)
	}

	delivery := ToDelivery(rec)
	if delivery.ID != rec.ID || delivery.Kind != rec.Kind || delivery.Content != rec.Content {
		t.Errorf("ToDelivery() = %+v, want fields matching the source record", delivery)
	}
	if delivery.PlatformID != nil || delivery.ChannelType != nil || delivery.ThreadID != nil || delivery.InReplyTo != nil {
		t.Errorf("ToDelivery() = %+v, want all optional routing fields nil for an unrouted row", delivery)
	}
}

func TestDueOutboundExcludesFutureDeliverAfter(t *testing.T) {
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{
		id: "due-now", seq: nullInt(3), timestamp: ts(0), kind: "chat", content: "{}",
	})
	insertOutboundRow(t, db, outboundRow{
		id: "due-later", seq: nullInt(5), timestamp: ts(1), kind: "chat", content: "{}",
		deliverAfter: nullStr(FormatTimestamp(time.Now().Add(24 * time.Hour))),
	})

	records, err := DueOutbound(db)
	if err != nil {
		t.Fatalf("DueOutbound() error = %v", err)
	}
	if len(records) != 1 || records[0].ID != "due-now" {
		t.Fatalf("DueOutbound() = %v, want only the row with no future deliver_after", records)
	}
}

func TestDueOutboundOrdersByTimestampAscending(t *testing.T) {
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{id: "second", seq: nullInt(5), timestamp: ts(10), kind: "chat", content: "{}"})
	insertOutboundRow(t, db, outboundRow{id: "first", seq: nullInt(3), timestamp: ts(0), kind: "chat", content: "{}"})

	records, err := DueOutbound(db)
	if err != nil {
		t.Fatalf("DueOutbound() error = %v", err)
	}
	if len(records) != 2 || records[0].ID != "first" || records[1].ID != "second" {
		t.Fatalf("DueOutbound() order = %v, want [first, second] (timestamp ASC)", records)
	}
}

func TestDueOutboundPreservesRoutingFields(t *testing.T) {
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{
		id: "routed", seq: nullInt(3), timestamp: ts(0), kind: "chat", content: "{}",
		inReplyTo: nullStr("msg-in-1"), platformID: nullStr("1234567890"),
		channelType: nullStr("whatsapp"), threadID: nullStr("thread-1"),
	})

	records, err := DueOutbound(db)
	if err != nil {
		t.Fatalf("DueOutbound() error = %v", err)
	}
	rec := records[0]
	if rec.InReplyTo == nil || *rec.InReplyTo != "msg-in-1" {
		t.Errorf("InReplyTo = %v, want msg-in-1", rec.InReplyTo)
	}
	if rec.PlatformID == nil || *rec.PlatformID != "1234567890" {
		t.Errorf("PlatformID = %v, want 1234567890", rec.PlatformID)
	}
	if rec.ChannelType == nil || *rec.ChannelType != "whatsapp" {
		t.Errorf("ChannelType = %v, want whatsapp", rec.ChannelType)
	}
	if rec.ThreadID == nil || *rec.ThreadID != "thread-1" {
		t.Errorf("ThreadID = %v, want thread-1", rec.ThreadID)
	}

	delivery := ToDelivery(rec)
	if delivery.InReplyTo == nil || *delivery.InReplyTo != "msg-in-1" {
		t.Errorf("ToDelivery().InReplyTo = %v, want msg-in-1 (must survive the envelope-to-delivery projection)", delivery.InReplyTo)
	}
}

func TestDueOutboundRejectsNonCanonicalTimestamp(t *testing.T) {
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{
		id: "bad-ts", seq: nullInt(3), timestamp: "2026-09-01T12:00:00Z", kind: "chat", content: "{}",
	})

	_, err := DueOutbound(db)
	if err == nil {
		t.Fatal("DueOutbound() error = nil, want an error for a non-canonical timestamp (missing milliseconds)")
	}
}

func TestDueOutboundAcceptsPlainStringKindNotInInboundEnum(t *testing.T) {
	// Outbound kind is deliberately a plain string, not InboundKind's closed
	// enum (compatibility-contract.md A2) — task_log is a real outbound-only
	// kind that would be rejected by InboundKind.valid().
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{
		id: "log-1", seq: nullInt(3), timestamp: ts(0), kind: "task_log", content: "{}",
	})

	records, err := DueOutbound(db)
	if err != nil {
		t.Fatalf("DueOutbound() error = %v, want task_log accepted (outbound kind is an open string)", err)
	}
	if len(records) != 1 || records[0].Kind != "task_log" {
		t.Fatalf("DueOutbound() = %v, want one task_log record", records)
	}
}

func TestOutboundHistoryOrdersBySequenceDescending(t *testing.T) {
	db := openTestOutboundDB(t)
	insertOutboundRow(t, db, outboundRow{id: "m1", seq: nullInt(3), timestamp: ts(0), kind: "chat", content: "first"})
	insertOutboundRow(t, db, outboundRow{id: "m2", seq: nullInt(5), timestamp: ts(10), kind: "chat", content: "second"})
	insertOutboundRow(t, db, outboundRow{id: "m3", seq: nullInt(7), timestamp: ts(20), kind: "chat", content: "third"})

	entries, err := OutboundHistory(db, 2)
	if err != nil {
		t.Fatalf("OutboundHistory() error = %v", err)
	}
	if len(entries) != 2 || entries[0].Content != "third" || entries[1].Content != "second" {
		t.Fatalf("OutboundHistory(limit=2) = %v, want [third, second] (seq DESC, limit applied)", entries)
	}
}

func TestOutboundHistoryOnEmptyDBReturnsNoRows(t *testing.T) {
	db := openTestOutboundDB(t)
	entries, err := OutboundHistory(db, 10)
	if err != nil {
		t.Fatalf("OutboundHistory() error = %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("OutboundHistory() on empty db = %v, want no rows", entries)
	}
}
