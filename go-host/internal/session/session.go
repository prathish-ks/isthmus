// Package session implements P4-01's session persistence primitives: the
// central-DB session lifecycle semantics already captured by Phase 2's
// differential-testing fixtures. This is a hand-port, not a reimplementation
// from first principles — every rule below is copied from the real source of
// truth in the TypeScript tree:
//
//   - src/db/schema.ts (the `sessions` table DDL)
//   - src/types.ts (the Session interface)
//   - src/db/sessions.ts (createSession/getSession/findSession/
//     findSessionForAgent/findSessionByAgentGroup/updateSession — the exact
//     queries, including findSessionByAgentGroup's system-thread exclusion
//     clause and ORDER BY)
//   - src/session-manager.ts (resolveSession: the three-mode resolution
//     algorithm, generateId's ID format, and the per-key creation lock that
//     serializes concurrent resolution for the same key)
//   - src/db/errors.ts (isUniqueViolation's classification rule)
//
// Scope, deliberately narrow, per the task's own instruction ("reproduce
// only session lifecycle semantics already captured by compatibility
// contracts... introduce no new semantics; make parity failures green one by
// one"):
//
//   - Only resolveSession's three session modes (shared, per-thread,
//     agent-shared) are ported. resolveTaskSession (the scheduled-task
//     session variant) is NOT — no Phase 2 differential fixture exercises it
//     yet, so porting it now would be new, untested surface rather than a
//     captured contract. Add it in a follow-up task once a parity fixture
//     for it exists.
//   - This package owns only the `sessions` table. It does not create or
//     know about `agent_groups`, `messaging_groups`, or any other central-DB
//     table — those stay TypeScript-owned. A Go process opening the real
//     production central DB (data_dir/v2.db) finds them already there,
//     created by NanoClaw's own migrations, long before this package ever
//     touches the file; the CREATE TABLE IF NOT EXISTS below only actually
//     fires against a fresh, Go-only test database. Because of that, the
//     `agent_group_id`/`messaging_group_id` REFERENCES clauses from
//     schema.ts are deliberately omitted here (this package never creates
//     the tables they'd point at) and `PRAGMA foreign_keys` is left off
//     (SQLite's own default) rather than turned on as production does.
//   - session-manager.ts's other session-lifecycle responsibilities —
//     attachment/outbox I/O (docs/host-decomposition.md classifies these
//     BOUNDARY, security-critical) and mailbox provisioning — are separately
//     scoped, not part of P4-01.
package session

import (
	"database/sql"
	"errors"
	"fmt"
	// Non-cryptographic on purpose: generateID's 6-char suffix (below) is a
	// collision-avoidance display key, not a secret or capability token,
	// mirroring session-manager.ts's own Math.random() (upstream also uses a
	// non-crypto RNG for this exact ID shape).
	"math/rand" // nosemgrep: go.lang.security.audit.crypto.math_random.math-random-used
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Status is Session.status (src/types.ts).
type Status string

const (
	// StatusActive is a session that is still open for delivery.
	StatusActive Status = "active"
	// StatusClosed is a session that no longer accepts delivery.
	StatusClosed Status = "closed"
)

// ContainerStatus is Session.container_status (src/types.ts).
type ContainerStatus string

const (
	// ContainerRunning is a session whose container is up and serving.
	ContainerRunning ContainerStatus = "running"
	// ContainerIdle is a session whose container is up but not actively
	// serving.
	ContainerIdle ContainerStatus = "idle"
	// ContainerStopped is a session with no running container.
	ContainerStopped ContainerStatus = "stopped"
)

// Mode is the session_mode wiring value that resolveSession branches on
// (src/session-manager.ts's own doc comment):
//   - shared: one session per messaging group (ignores threadID)
//   - per-thread: one session per (messaging group, thread)
//   - agent-shared: one session per agent group — every messaging group
//     wired with this mode shares a single session
type Mode string

const (
	// ModeShared is one session per messaging group, ignoring threadID.
	ModeShared Mode = "shared"
	// ModePerThread is one session per (messaging group, thread).
	ModePerThread Mode = "per-thread"
	// ModeAgentShared is one session per agent group — every messaging
	// group wired with this mode shares a single session.
	ModeAgentShared Mode = "agent-shared"
)

// TasksSystemThreadID mirrors src/db/sessions.ts's TASKS_SYSTEM_THREAD_ID —
// the reserved thread-id namespace for scheduled-task sessions.
const TasksSystemThreadID = "system:tasks"

// IsTaskThread mirrors src/db/sessions.ts's isTaskThread (line 99-101): a
// thread id identifies a task session either exactly (the bare tasks-system
// thread) or by namespace prefix (one specific task's own thread, minted as
// `TasksSystemThreadID:<seriesId>`). A nil threadId (the common case for
// ordinary messaging-group sessions) is never a task thread.
func IsTaskThread(threadID *string) bool {
	if threadID == nil {
		return false
	}
	return *threadID == TasksSystemThreadID || strings.HasPrefix(*threadID, TasksSystemThreadID+":")
}

// Session is the Go mirror of src/types.ts's Session interface. Nullable
// TypeScript fields (`string | null`) are *string here.
type Session struct {
	ID               string
	AgentGroupID     string
	MessagingGroupID *string
	ThreadID         *string
	AgentProvider    *string
	Status           Status
	ContainerStatus  ContainerStatus
	LastActive       *string
	CreatedAt        string
}

// sessionsSchema is src/db/schema.ts's `sessions` table DDL, minus the two
// REFERENCES clauses this package deliberately doesn't own — see the package
// doc comment.
const sessionsSchema = `
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL,
  messaging_group_id TEXT,
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
`

// Path mirrors src/config.ts's CENTRAL_DB_PATH: DATA_DIR/v2.db.
func Path(dataDir string) string {
	return filepath.Join(dataDir, "v2.db")
}

// Open opens the central DB at dbPath via the pure-Go modernc.org/sqlite
// driver (the same driver and single-connection posture internal/mailbox
// uses, for the same cross-process-sharing reasons) and ensures the
// `sessions` table exists. The caller owns the returned *sql.DB and must
// close it.
func Open(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("opening central db %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`PRAGMA busy_timeout = 5000`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("setting busy_timeout on %q: %w", dbPath, err)
	}
	if _, err := db.Exec(sessionsSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("applying sessions schema to %q: %w", dbPath, err)
	}
	return db, nil
}

// formatTimestamp renders t exactly as JavaScript's Date.prototype.toISOString()
// would (UTC, millisecond precision, "Z" suffix) — the same rule
// internal/mailbox.FormatTimestamp ports from the same source, duplicated
// here (rather than imported) to keep this package independently portable,
// matching this project's existing per-package hand-port style.
func formatTimestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// generateID mirrors session-manager.ts's generateId(): `sess-` + the
// current Unix millisecond timestamp + a 6-character random base36
// suffix (Math.random().toString(36).slice(2, 8)).
func generateID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 6)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))] // #nosec G404 -- non-cryptographic on purpose, see the math/rand import comment above
	}
	return fmt.Sprintf("sess-%d-%s", time.Now().UnixMilli(), string(b))
}

// IsUniqueViolation mirrors src/db/errors.ts's isUniqueViolation. The
// modernc.org/sqlite driver's *sqlite.Error.Code() only ever exposes the
// base SQLITE_CONSTRAINT result code (19) for a constraint failure, not the
// extended SQLITE_CONSTRAINT_UNIQUE (2067) / SQLITE_CONSTRAINT_PRIMARYKEY
// (1555) variants the TypeScript version checks first — so unlike the
// TypeScript code, there is no reliable code-based path here at all, and
// text matching against the error message isn't just a fallback, it's the
// only mechanism. This still classifies correctly: modernc.org/sqlite is a
// direct port of the real SQLite C amalgamation, so its error text is
// byte-for-byte the same "UNIQUE constraint failed: <table>.<column>"
// message libsqlite3 (and therefore better-sqlite3) produces — the exact
// string isUniqueViolation's own regex fallback matches.
func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "unique constraint failed")
}

// Create mirrors db/sessions.ts's createSession: one INSERT, no upsert
// semantics — a duplicate id surfaces as a plain error for the caller (here,
// ResolveSession) to classify with IsUniqueViolation.
func Create(db *sql.DB, s Session) error {
	_, err := db.Exec(
		`INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.AgentGroupID, s.MessagingGroupID, s.ThreadID, s.AgentProvider,
		string(s.Status), string(s.ContainerStatus), s.LastActive, s.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting session %q: %w", s.ID, err)
	}
	return nil
}

// scanSession is the shared row->Session mapping every lookup below uses.
func scanSession(row *sql.Row) (*Session, error) {
	var s Session
	var status, containerStatus string
	err := row.Scan(&s.ID, &s.AgentGroupID, &s.MessagingGroupID, &s.ThreadID,
		&s.AgentProvider, &status, &containerStatus, &s.LastActive, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scanning session row: %w", err)
	}
	s.Status = Status(status)
	s.ContainerStatus = ContainerStatus(containerStatus)
	return &s, nil
}

const sessionColumns = `id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at`

// Get mirrors db/sessions.ts's getSession. Returns (nil, nil) when no row
// matches — the Go equivalent of TypeScript's `Session | undefined`.
func Get(db *sql.DB, id string) (*Session, error) {
	row := db.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE id = ?`, id)
	return scanSession(row)
}

// Find mirrors db/sessions.ts's findSession: the plain, agent-group-agnostic
// active-session lookup by (messaging group, thread).
func Find(db *sql.DB, messagingGroupID string, threadID *string) (*Session, error) {
	if threadID != nil {
		row := db.QueryRow(
			`SELECT `+sessionColumns+` FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?`,
			messagingGroupID, *threadID, string(StatusActive),
		)
		return scanSession(row)
	}
	row := db.QueryRow(
		`SELECT `+sessionColumns+` FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?`,
		messagingGroupID, string(StatusActive),
	)
	return scanSession(row)
}

// FindForAgent mirrors db/sessions.ts's findSessionForAgent: the same lookup
// as Find but scoped to a specific agent group, so fan-out to multiple
// agents in the same chat doesn't deliver to the wrong agent's session.
func FindForAgent(db *sql.DB, agentGroupID, messagingGroupID string, threadID *string) (*Session, error) {
	if threadID != nil {
		row := db.QueryRow(
			`SELECT `+sessionColumns+` FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'`,
			agentGroupID, messagingGroupID, *threadID,
		)
		return scanSession(row)
	}
	row := db.QueryRow(
		`SELECT `+sessionColumns+` FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'`,
		agentGroupID, messagingGroupID,
	)
	return scanSession(row)
}

// FindByAgentGroup mirrors db/sessions.ts's findSessionByAgentGroup exactly,
// including its exclusion of system/task sessions (messaging_group_id IS
// NULL AND thread_id LIKE 'system:%') and its ORDER BY created_at DESC LIMIT
// 1 (the most recently created active session wins).
func FindByAgentGroup(db *sql.DB, agentGroupID string) (*Session, error) {
	row := db.QueryRow(
		`SELECT `+sessionColumns+` FROM sessions
		   WHERE agent_group_id = ?
		     AND status = 'active'
		     AND NOT (messaging_group_id IS NULL AND thread_id IS NOT NULL AND thread_id LIKE 'system:%')
		   ORDER BY created_at DESC
		   LIMIT 1`,
		agentGroupID,
	)
	return scanSession(row)
}

// Update is a partial update — nil fields are left untouched, mirroring
// db/sessions.ts's updateSession(id, Partial<Pick<Session, ...>>). Unlike
// the TypeScript version, this does not support explicitly setting a
// nullable field (LastActive, AgentProvider) back to null: no captured
// fixture needs that, so it's left as a documented gap rather than modeled
// speculatively.
type Update struct {
	Status          *Status
	ContainerStatus *ContainerStatus
	LastActive      *string
	AgentProvider   *string
}

// UpdateSession applies a partial Update to session id, touching only the
// columns whose fields are non-nil.
func UpdateSession(db *sql.DB, id string, u Update) error {
	var sets []string
	var args []any

	if u.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, string(*u.Status))
	}
	if u.ContainerStatus != nil {
		sets = append(sets, "container_status = ?")
		args = append(args, string(*u.ContainerStatus))
	}
	if u.LastActive != nil {
		sets = append(sets, "last_active = ?")
		args = append(args, *u.LastActive)
	}
	if u.AgentProvider != nil {
		sets = append(sets, "agent_provider = ?")
		args = append(args, *u.AgentProvider)
	}
	if len(sets) == 0 {
		return nil
	}

	args = append(args, id)
	// sets is built above from a fixed, closed set of literal column
	// fragments ("status = ?", "container_status = ?", ...) — never from a
	// caller- or user-supplied column/table name — and every actual value is
	// passed through args as a parameterized placeholder.
	// #nosec G202 -- sets is built from a fixed, closed set of literal column fragments, see comment above
	_, err := db.Exec(`UPDATE sessions SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...) // nosemgrep: go.lang.security.audit.sqli.gosql-sqli.gosql-sqli
	if err != nil {
		return fmt.Errorf("updating session %q: %w", id, err)
	}
	return nil
}

// MarkContainerRunning, MarkContainerIdle, and MarkContainerStopped mirror
// session-manager.ts's identically named convenience wrappers around
// updateSession.

// MarkContainerRunning marks id's container as running and refreshes
// LastActive to now.
func MarkContainerRunning(db *sql.DB, id string) error {
	now := formatTimestamp(time.Now())
	cs := ContainerRunning
	return UpdateSession(db, id, Update{ContainerStatus: &cs, LastActive: &now})
}

// MarkContainerIdle marks id's container as idle.
func MarkContainerIdle(db *sql.DB, id string) error {
	cs := ContainerIdle
	return UpdateSession(db, id, Update{ContainerStatus: &cs})
}

// MarkContainerStopped marks id's container as stopped.
func MarkContainerStopped(db *sql.DB, id string) error {
	cs := ContainerStopped
	return UpdateSession(db, id, Update{ContainerStatus: &cs})
}

// creationLocks serializes concurrent ResolveSession calls for the same key,
// mirroring session-manager.ts's withSessionCreationLock. Unlike the
// TypeScript version (a promise chain removed from its map once idle), this
// map is never pruned — a documented, deliberate simplification: the key
// space is one entry per distinct (agent group, messaging group, thread)
// combination actually in use, which stays small and bounded for any real
// install, so unbounded-map growth isn't a practical concern the way it
// would be for a truly unbounded key space. A future revision can add
// eviction if this ever proves otherwise; no captured fixture exercises
// that behavior today.
var creationLocks = struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}{locks: make(map[string]*sync.Mutex)}

func lockKey(key string) func() {
	creationLocks.mu.Lock()
	l, ok := creationLocks.locks[key]
	if !ok {
		l = &sync.Mutex{}
		creationLocks.locks[key] = l
	}
	creationLocks.mu.Unlock()

	l.Lock()
	return l.Unlock
}

// sessionCreationKey mirrors session-manager.ts's sessionCreationKey.
func sessionCreationKey(agentGroupID string, messagingGroupID, threadID *string, mode Mode) string {
	if mode == ModeAgentShared {
		return "agent\x00" + agentGroupID
	}
	mg := ""
	if messagingGroupID != nil {
		mg = *messagingGroupID
	}
	th := ""
	if mode != ModeShared && threadID != nil {
		th = *threadID
	}
	return "route\x00" + agentGroupID + "\x00" + mg + "\x00" + th
}

// ResolveSession mirrors session-manager.ts's resolveSession: find or create
// a session for (agent group, messaging group, thread) under the given
// session mode, exactly per that function's own three-mode branching
// (agent-shared: one session per agent group, ignoring messaging group;
// shared: one session per messaging group, ignoring thread; per-thread: one
// session per messaging-group+thread pair), serialized per creation key by
// lockKey, with the same catch-a-unique-violation-and-re-look-up race
// recovery for two callers that both pass the "no existing session" check
// before either has committed its INSERT.
func ResolveSession(db *sql.DB, agentGroupID string, messagingGroupID, threadID *string, mode Mode) (Session, bool, error) {
	key := sessionCreationKey(agentGroupID, messagingGroupID, threadID, mode)
	unlock := lockKey(key)
	defer unlock()

	if mode == ModeAgentShared {
		existing, err := FindByAgentGroup(db, agentGroupID)
		if err != nil {
			return Session{}, false, err
		}
		if existing != nil {
			return *existing, false, nil
		}
	} else if messagingGroupID != nil {
		lookupThreadID := threadID
		if mode == ModeShared {
			lookupThreadID = nil
		}
		existing, err := FindForAgent(db, agentGroupID, *messagingGroupID, lookupThreadID)
		if err != nil {
			return Session{}, false, err
		}
		if existing != nil {
			return *existing, false, nil
		}
	}

	var lookupThreadID *string
	if mode == ModePerThread {
		lookupThreadID = threadID
	}
	s := Session{
		ID:               generateID(),
		AgentGroupID:     agentGroupID,
		MessagingGroupID: messagingGroupID,
		ThreadID:         lookupThreadID,
		AgentProvider:    nil,
		Status:           StatusActive,
		ContainerStatus:  ContainerStopped,
		LastActive:       nil,
		CreatedAt:        formatTimestamp(time.Now()),
	}

	if err := Create(db, s); err != nil {
		if !IsUniqueViolation(err) {
			return Session{}, false, err
		}
		var existing *Session
		var ferr error
		switch {
		case mode == ModeAgentShared:
			existing, ferr = FindByAgentGroup(db, agentGroupID)
		case messagingGroupID != nil:
			existing, ferr = FindForAgent(db, agentGroupID, *messagingGroupID, lookupThreadID)
		}
		if ferr != nil {
			return Session{}, false, ferr
		}
		if existing == nil {
			return Session{}, false, err
		}
		return *existing, false, nil
	}

	return s, true, nil
}
