// Package mailbox implements P3-03's inbound mailbox writer: just enough of
// NanoClaw's host-owned "messages_in" contract for a Go-authored row to be
// indistinguishable, on disk, from one the TypeScript host would have
// written — so the original, unmodified agent-runner can read it without
// knowing a Go process wrote it.
//
// This is a hand-port, not a reimplementation from first principles. Every
// rule below is copied from the real source of truth, which lives in the
// TypeScript tree, not here:
//   - src/mailbox/sqlite/schema.ts (INBOUND_SCHEMA: exact table DDL)
//   - src/mailbox/sqlite/paths.ts (where inbound.db lives on disk)
//   - src/mailbox/sqlite/session-db.ts (nextEvenSeq, insertMessage: the exact
//     INSERT statement and the host-writes-even-seq invariant)
//   - src/mailbox/model.ts (parseInboundWrite / createInboundRecord /
//     parseInboundRecord: field validation and default values)
//
// Scope, deliberately narrow (Phase 3 is a protocol proof, not host parity):
// this package only knows how to write one inbound record into a session's
// inbound.db. It does not read, poll, deliver, or route — that's later
// phases (P3-05 reads the outbound side; Phase 4 is full host parity).
package mailbox

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// InboundKind is NanoClaw's closed set of inbound message kinds
// (src/mailbox/model.ts's InboundKind / INBOUND_KINDS). Unlike outbound
// kinds, this is a closed enum enforced by the model layer itself.
type InboundKind string

const (
	// KindChat is a plain user-authored chat message.
	KindChat InboundKind = "chat"
	// KindChatSDK is a chat message delivered through the SDK path rather
	// than a channel adapter.
	KindChatSDK InboundKind = "chat-sdk"
	// KindTask is a scheduled-task-originated message.
	KindTask InboundKind = "task"
	// KindWebhook is a message originating from an inbound webhook.
	KindWebhook InboundKind = "webhook"
	// KindSystem is a host-generated system message.
	KindSystem InboundKind = "system"
)

func (k InboundKind) valid() bool {
	switch k {
	case KindChat, KindChatSDK, KindTask, KindWebhook, KindSystem:
		return true
	default:
		return false
	}
}

// InboundMessage is what a caller supplies to queue one inbound message —
// the Go mirror of src/mailbox/model.ts's InboundWrite. Nullable-but-required
// TypeScript fields (`string | null`) are *string here: nil means null.
// Genuinely optional TypeScript fields (`trigger?`, `sourceSessionId?`,
// `onWake?`) are also pointers, but their nil-ness carries different meaning:
// "not supplied, apply createInboundRecord's default" — see Defaults below.
type InboundMessage struct {
	ID           string
	Kind         InboundKind
	Timestamp    string // must be an exact time.toISOString()-style value; see ParseTimestamp.
	PlatformID   *string
	ChannelType  *string
	ThreadID     *string
	Content      string
	ProcessAfter *string
	Recurrence   *string

	// Optional; nil means "apply the TypeScript default" (see createInboundRecord):
	// Trigger defaults to true, SourceSessionID to nil, OnWake to false.
	Trigger         *bool
	SourceSessionID *string
	OnWake          *bool
}

// Record is the full stored row — the Go mirror of model.ts's InboundRecord,
// after createInboundRecord's defaulting has been applied. Returned by
// Insert so callers (and tests) can see exactly what was written.
type Record struct {
	ID              string
	Sequence        int64
	Kind            InboundKind
	Timestamp       string
	Status          string
	ProcessAfter    *string
	Recurrence      *string
	SeriesID        string
	Tries           int
	Trigger         bool
	PlatformID      *string
	ChannelType     *string
	ThreadID        *string
	Content         string
	SourceSessionID *string
	OnWake          bool
}

// inboundSchema is src/mailbox/sqlite/schema.ts's INBOUND_SCHEMA, ported
// verbatim (table names, column names, types, defaults, and the one index)
// so a Go-created inbound.db is byte-for-byte structurally identical to one
// the TypeScript host would have created via ensureSchema(dbPath, 'inbound').
const inboundSchema = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT
);

CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
`

// Path mirrors src/mailbox/sqlite/paths.ts's inboundDbPath: DATA_DIR is
// joined with v2-sessions/<agentGroupID>/<sessionID>/inbound.db.
func Path(dataDir, agentGroupID, sessionID string) string {
	return filepath.Join(dataDir, "v2-sessions", agentGroupID, sessionID, "inbound.db")
}

// Open creates the parent directory if needed (the TypeScript host does this
// as part of session setup, before ever calling ensureSchema — a standalone
// Go writer has to do it itself), opens the inbound.db at dbPath via the
// pure-Go modernc.org/sqlite driver, applies the same two pragmas the
// TypeScript host sets in openInboundDb (journal_mode=DELETE,
// busy_timeout=5000 — both matter for safe cross-process sharing with the
// container, which holds this same file open concurrently), and ensures the
// schema exists. The caller owns the returned *sql.DB and must Close it.
func Open(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o750); err != nil {
		return nil, fmt.Errorf("creating mailbox directory for %q: %w", dbPath, err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("opening inbound db %q: %w", dbPath, err)
	}

	// A single connection: multiple *database/sql* connections to the same
	// SQLite file inside one process serialize the same way the TS host's
	// single better-sqlite3 handle does, and avoids the driver silently
	// opening a second, differently-configured connection under load.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`PRAGMA journal_mode = DELETE`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting journal_mode on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting busy_timeout on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(inboundSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("applying inbound schema to %q: %w", dbPath, err)
	}

	return db, nil
}

// ParseTimestamp validates value the same way src/mailbox/model.ts's
// parseIsoTimestamp does: not merely "parses as a date", but an exact
// Date.prototype.toISOString() round trip — a timestamp with a different
// string representation of the same instant (a non-UTC offset, missing
// milliseconds, etc.) is rejected. Returns the parsed time on success.
func ParseTimestamp(value string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid ISO-8601 UTC timestamp %q: %w", value, err)
	}
	if FormatTimestamp(t) != value {
		return time.Time{}, fmt.Errorf("invalid ISO-8601 UTC timestamp %q: not a canonical UTC toISOString() value", value)
	}
	return t, nil
}

// FormatTimestamp renders t exactly as JavaScript's Date.prototype.toISOString()
// would: UTC, millisecond precision, "Z" suffix. Use this to construct
// timestamps for InboundMessage.Timestamp / ProcessAfter rather than
// hand-formatting, so they always pass ParseTimestamp's round-trip check.
func FormatTimestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// validate mirrors src/mailbox/model.ts's parseInboundWrite: check that Kind
// is one of the closed InboundKind values, Timestamp and ProcessAfter (when
// non-nil) are canonical ISO timestamps, and Content/ID are non-empty.
func (m InboundMessage) validate() error {
	if m.ID == "" {
		return fmt.Errorf("id is required")
	}
	if !m.Kind.valid() {
		return fmt.Errorf("invalid kind %q: expected one of chat, chat-sdk, task, webhook, system", m.Kind)
	}
	if _, err := ParseTimestamp(m.Timestamp); err != nil {
		return fmt.Errorf("field timestamp: %w", err)
	}
	if m.ProcessAfter != nil {
		if _, err := ParseTimestamp(*m.ProcessAfter); err != nil {
			return fmt.Errorf("field processAfter: %w", err)
		}
	}
	if m.Content == "" {
		return fmt.Errorf("content is required")
	}
	return nil
}

// nextEvenSeq mirrors src/mailbox/sqlite/session-db.ts's nextEvenSeq exactly:
// the host always assigns even sequence numbers into its own inbound.db (the
// "host-writes-even-seq" invariant that keeps a would-be container-originated
// write — none exist today, but the schema doesn't forbid it — from ever
// colliding with a host-assigned seq).
func nextEvenSeq(db *sql.DB) (int64, error) {
	var maxSeq int64
	if err := db.QueryRow(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in`).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("reading current max seq: %w", err)
	}
	if maxSeq < 2 {
		return 2, nil
	}
	return maxSeq + 2 - (maxSeq % 2), nil
}

// Insert validates msg, assigns it the next even sequence number, applies
// createInboundRecord's default values, and writes one row into
// messages_in — mirroring session-db.ts's insertMessage (same column list,
// same INSERT), so the row is exactly what the TypeScript host would have
// produced for the same InboundMessage.
func Insert(db *sql.DB, msg InboundMessage) (Record, error) {
	if err := msg.validate(); err != nil {
		return Record{}, fmt.Errorf("invalid inbound message: %w", err)
	}

	seq, err := nextEvenSeq(db)
	if err != nil {
		return Record{}, err
	}

	rec := Record{
		ID:              msg.ID,
		Sequence:        seq,
		Kind:            msg.Kind,
		Timestamp:       msg.Timestamp,
		Status:          "pending",
		ProcessAfter:    msg.ProcessAfter,
		Recurrence:      msg.Recurrence,
		SeriesID:        msg.ID,
		Tries:           0,
		Trigger:         true,
		PlatformID:      msg.PlatformID,
		ChannelType:     msg.ChannelType,
		ThreadID:        msg.ThreadID,
		Content:         msg.Content,
		SourceSessionID: nil,
		OnWake:          false,
	}
	if msg.Trigger != nil {
		rec.Trigger = *msg.Trigger
	}
	if msg.SourceSessionID != nil {
		rec.SourceSessionID = msg.SourceSessionID
	}
	if msg.OnWake != nil {
		rec.OnWake = *msg.OnWake
	}

	_, err = db.Exec(
		`INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.ID, rec.Sequence, string(rec.Kind), rec.Timestamp, rec.Status,
		rec.PlatformID, rec.ChannelType, rec.ThreadID, rec.Content,
		rec.ProcessAfter, rec.Recurrence, rec.SeriesID, boolToInt(rec.Trigger),
		rec.SourceSessionID, boolToInt(rec.OnWake),
	)
	if err != nil {
		return Record{}, fmt.Errorf("inserting inbound message %q: %w", rec.ID, err)
	}

	return rec, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
