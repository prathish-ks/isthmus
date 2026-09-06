// outbound.go implements P3-05's outbound mailbox reader: the container→host
// half of the wire contract, completing what P3-03's inbound writer started
// on the host→container side.
//
// Hand-ported, like mailbox.go, from the real TypeScript source of truth —
// no rule here is invented, each is copied from:
//   - src/mailbox/sqlite/schema.ts (OUTBOUND_SCHEMA: exact table DDL)
//   - src/mailbox/sqlite/session-db.ts (ensureSchema, openOutboundDb,
//     getDueOutboundMessages: the exact pragmas and queries)
//   - src/mailbox/sqlite/index.ts (getOutboundHistory: the history query)
//   - src/mailbox/model.ts (parseOutboundRecord / outboundDelivery: field
//     validation and the envelope→delivery projection)
//
// Scope, per the P3-05 task ("Implement only outbound mailbox reading and
// CLI display according to the compatibility contract. Add tests."): this
// file only READS outbound.db and normalizes rows for display. It
// deliberately does not implement delivery, retry, delivered-table dedup, or
// processing_ack claim-filtering — those are real production behaviors
// documented on wrapSqliteOutbound (src/mailbox/sqlite/index.ts) but belong
// to Phase 4 host parity, not this protocol proof.
//
// One documented divergence from the real host: getDueMessages()
// (src/mailbox/sqlite/index.ts) treats one malformed row as a best-effort
// delivery rather than failing the whole read, so a single bad row can't
// block the entire outbound queue in production. DueOutbound below instead
// fails the whole read on the first malformed row — a protocol proof should
// surface a contract violation loudly rather than paper over it. Phase 4 can
// port the resilience behavior if a real install ever needs it.
package mailbox

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
)

// outboundSchema is src/mailbox/sqlite/schema.ts's OUTBOUND_SCHEMA, ported
// verbatim. This is the exact schema P3-04's proof harness had to pre-create
// by hand via the sqlite3 CLI because this package didn't exist yet —
// OpenForSetup below closes that gap for future runs (P3-06 in particular).
const outboundSchema = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
`

// OutboundRecord is the full stored row — the Go mirror of model.ts's
// OutboundRecord. Unlike InboundKind, Kind is a plain string here too: the
// real contract deliberately leaves outbound kinds open (chat, system,
// task_log, and whatever else a module registers — see the compatibility
// contract's "A2" note), so Go must not invent a closed enum that
// TypeScript's own model layer doesn't have.
type OutboundRecord struct {
	ID           string
	Sequence     *int64
	InReplyTo    *string
	Timestamp    string
	DeliverAfter *string
	Recurrence   *string
	Kind         string
	PlatformID   *string
	ChannelType  *string
	ThreadID     *string
	Content      string
}

// OutboundDelivery is the Go mirror of model.ts's OutboundDelivery — what
// outboundDelivery() projects a full OutboundRecord down to for a recipient
// (a channel, or here, CLI display): the envelope's own bookkeeping fields
// (sequence, timestamp, deliverAfter, recurrence) are dropped.
type OutboundDelivery struct {
	ID          string
	Kind        string
	PlatformID  *string
	ChannelType *string
	ThreadID    *string
	Content     string
	InReplyTo   *string
}

// OutboundHistoryEntry is the Go mirror of types.ts's MailboxHistoryMessage,
// as returned by getOutboundHistory.
type OutboundHistoryEntry struct {
	Timestamp string
	Kind      string
	Content   string
}

// OutboundPath mirrors src/mailbox/sqlite/paths.ts's outboundDbPath.
func OutboundPath(dataDir, agentGroupID, sessionID string) string {
	return filepath.Join(dataDir, "v2-sessions", agentGroupID, sessionID, "outbound.db")
}

// OpenForSetup mirrors src/mailbox/sqlite/session-db.ts's
// ensureSchema(dbPath, 'outbound'), plus the parent-directory creation the
// real host does as part of session setup before ever calling it (the same
// pairing Open() does for inbound.db in mailbox.go). Use this to prepare a
// session's outbound.db before a container ever starts.
func OpenForSetup(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o750); err != nil {
		return nil, fmt.Errorf("creating mailbox directory for %q: %w", dbPath, err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("opening outbound db %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`PRAGMA journal_mode = DELETE`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting journal_mode on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting busy_timeout on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(outboundSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("applying outbound schema to %q: %w", dbPath, err)
	}

	return db, nil
}

// OpenReadOnly mirrors src/mailbox/sqlite/session-db.ts's openOutboundDb:
// the host only ever reads outbound.db through this path in the real
// contract (writes belong to the container, or to the separate,
// out-of-scope-for-P3-05 writeDirect path used only when no container is
// running). Unlike OpenForSetup, this does NOT create the file or apply the
// schema — callers must check the file exists first, mirroring
// SqliteAgentMailbox.exists()/session()'s "Mailbox is not prepared" check.
//
// database/sql connection strings aren't a portable way to request read-only
// mode across sqlite drivers, so read-only is enforced with PRAGMA
// query_only instead — a SQLite-level guarantee that blocks any data change
// on this connection regardless of driver, matching the intent (not the
// mechanism) of better-sqlite3's { readonly: true }.
func OpenReadOnly(dbPath string) (*sql.DB, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return nil, fmt.Errorf("outbound mailbox not prepared: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("opening outbound db %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting busy_timeout on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(`PRAGMA query_only = ON`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting query_only on %q: %w", dbPath, err)
	}

	return db, nil
}

// outboundRow is the raw scan target for one messages_out row, before
// validation. Nullable TEXT columns scan into sql.NullString/sql.NullInt64
// so a NULL is distinguishable from an empty string or zero.
type outboundRow struct {
	id           string
	seq          sql.NullInt64
	inReplyTo    sql.NullString
	timestamp    string
	deliverAfter sql.NullString
	recurrence   sql.NullString
	kind         string
	platformID   sql.NullString
	channelType  sql.NullString
	threadID     sql.NullString
	content      string
}

func nullableString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

// parseOutboundRow mirrors src/mailbox/model.ts's parseOutboundRecord: it
// validates the envelope the same way the TypeScript host does before ever
// trusting a row's shape. The most consequential check is that timestamp
// and deliver_after (when present) are canonical ISO-8601 UTC strings —
// exactly as strict as the inbound side's own timestamp validation
// (ParseTimestamp, shared with mailbox.go).
func parseOutboundRow(row outboundRow) (OutboundRecord, error) {
	if row.id == "" {
		return OutboundRecord{}, fmt.Errorf("invalid outbound record: empty id")
	}
	if _, err := ParseTimestamp(row.timestamp); err != nil {
		return OutboundRecord{}, fmt.Errorf("field timestamp: %w", err)
	}
	if row.deliverAfter.Valid {
		if _, err := ParseTimestamp(row.deliverAfter.String); err != nil {
			return OutboundRecord{}, fmt.Errorf("field deliverAfter: %w", err)
		}
	}
	if row.seq.Valid && row.seq.Int64 < 0 {
		return OutboundRecord{}, fmt.Errorf("invalid outbound record: negative sequence")
	}

	rec := OutboundRecord{
		ID:           row.id,
		InReplyTo:    nullableString(row.inReplyTo),
		Timestamp:    row.timestamp,
		DeliverAfter: nullableString(row.deliverAfter),
		Recurrence:   nullableString(row.recurrence),
		Kind:         row.kind,
		PlatformID:   nullableString(row.platformID),
		ChannelType:  nullableString(row.channelType),
		ThreadID:     nullableString(row.threadID),
		Content:      row.content,
	}
	if row.seq.Valid {
		seq := row.seq.Int64
		rec.Sequence = &seq
	}
	return rec, nil
}

// DueOutbound mirrors src/mailbox/sqlite/session-db.ts's
// getDueOutboundMessages exactly: the same WHERE clause (rows with no
// deliver_after, or one that has already elapsed) and the same ORDER BY
// timestamp ASC — so a deterministic single-message run (no deliver_after
// set, one row) reads back in the same order the real host would deliver it.
func DueOutbound(db *sql.DB) ([]OutboundRecord, error) {
	rows, err := db.Query(
		`SELECT id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content
		   FROM messages_out
		  WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
		  ORDER BY timestamp ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("querying due outbound messages: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var records []OutboundRecord
	for rows.Next() {
		var row outboundRow
		if err := rows.Scan(
			&row.id, &row.seq, &row.inReplyTo, &row.timestamp, &row.deliverAfter,
			&row.recurrence, &row.kind, &row.platformID, &row.channelType, &row.threadID, &row.content,
		); err != nil {
			return nil, fmt.Errorf("scanning outbound row: %w", err)
		}
		rec, err := parseOutboundRow(row)
		if err != nil {
			return nil, fmt.Errorf("outbound row %q: %w", row.id, err)
		}
		records = append(records, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading due outbound messages: %w", err)
	}
	return records, nil
}

// OutboundHistory mirrors src/mailbox/sqlite/index.ts's getOutboundHistory:
// the last `limit` messages by sequence, newest first, projected down to
// just timestamp/kind/content — a timeline view, not a delivery queue.
func OutboundHistory(db *sql.DB, limit int) ([]OutboundHistoryEntry, error) {
	rows, err := db.Query(`SELECT timestamp, kind, content FROM messages_out ORDER BY seq DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("querying outbound history: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var entries []OutboundHistoryEntry
	for rows.Next() {
		var entry OutboundHistoryEntry
		if err := rows.Scan(&entry.Timestamp, &entry.Kind, &entry.Content); err != nil {
			return nil, fmt.Errorf("scanning outbound history row: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading outbound history: %w", err)
	}
	return entries, nil
}

// ToDelivery mirrors src/mailbox/model.ts's outboundDelivery(): projects a
// full envelope down to what a recipient (a channel, or a CLI displaying the
// response) actually needs.
func ToDelivery(rec OutboundRecord) OutboundDelivery {
	return OutboundDelivery{
		ID:          rec.ID,
		Kind:        rec.Kind,
		PlatformID:  rec.PlatformID,
		ChannelType: rec.ChannelType,
		ThreadID:    rec.ThreadID,
		Content:     rec.Content,
		InReplyTo:   rec.InReplyTo,
	}
}
