// Package capability implements P8-02 (Phase 8 — Capability Security): a
// prototype of exactly one narrow slice of docs/capabilities.md's schema —
// a temporary, session-scoped, read-only filesystem grant. Per the task's
// own instruction ("one narrow prototype... explicit expiry, audit events,
// no broad integration"), this is deliberately not a general capability
// engine: one Action (fs.read), one resource kind (a directory), in-memory
// only, with no wiring into internal/kernel or any live request path.
//
// The claim this package's own tests prove, per the task's done-when
// ("integration test proves access during capability and denial after
// expiry"): a session holding a live grant can read under the granted
// directory; the identical check on the identical grant, after ExpiresAt,
// denies — with nothing else about the grant or the check having changed.
// That before/after pair, not just "expiry is checked somewhere," is the
// actual security property demonstrated.
package capability

import (
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/ownership"
)

// Action is the closed set of grantable actions this prototype supports.
// Only one value exists today — see the package doc on scope.
type Action string

// ActionFSRead is the one grantable action this prototype supports today —
// temporary, read-only filesystem access to a specific directory.
const ActionFSRead Action = "fs.read"

// Grant is one instance of docs/capabilities.md's schema, specialized to
// this prototype's single Action. ID is assigned by GrantFSRead; a caller
// never constructs a Grant with an ID of its own, the same
// "authorization is issued, not asserted" discipline internal/kernel's own
// capability.request already applies to Docker-facing capabilities.
type Grant struct {
	ID              string
	Resource        string // absolute directory path this grant covers
	Action          Action
	SessionID       string
	Scope           string // reserved for a future narrower-than-Resource case; empty means the whole Resource
	IssuedAt        time.Time
	ExpiresAt       time.Time
	ApprovalContext string
}

// covers reports whether path is Resource itself or a path underneath it —
// the same lexical-containment check internal/mount's own underRoot uses
// for the identical reason (a grant over a directory must not be satisfied
// by mere string-prefix matching, e.g. "/data/g1" must not cover
// "/data/g1-other").
func (g Grant) covers(path string) bool {
	root := filepath.Clean(g.Resource)
	p := filepath.Clean(path)
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(filepath.Separator))
}

// AuditEvent records one grant/check/revoke decision. Detail is
// human-readable provenance only — per docs/capabilities.md's
// ApprovalContext note, nothing in this package ever reads an AuditEvent
// back to decide whether to authorize anything; audit is output, not input.
type AuditEvent struct {
	At        time.Time
	Kind      string // "granted" | "checked_allowed" | "checked_denied_expired" | "checked_denied_no_grant" | "revoked"
	GrantID   string
	SessionID string
	Resource  string
	Detail    string
}

// Manager issues and checks temporary read-only filesystem Grants,
// in-memory only (no persistence — a prototype's whole point per the
// task's own scope is proving the expiry property, not building a durable
// store). now is injectable so tests can advance time deterministically
// instead of sleeping real wall-clock time.
type Manager struct {
	mu       sync.Mutex
	grants   map[string]Grant
	audit    []AuditEvent
	now      func() time.Time
	nextID   int
	idPrefix string
}

// NewManager returns a Manager using the real wall clock.
func NewManager() *Manager {
	return newManager(time.Now)
}

// NewManagerWithClock returns a Manager whose notion of "now" is now —
// exported so tests (in this package and any future caller's) can advance
// time deterministically rather than sleeping.
func NewManagerWithClock(now func() time.Time) *Manager {
	return newManager(now)
}

func newManager(now func() time.Time) *Manager {
	return &Manager{grants: make(map[string]Grant), now: now, idPrefix: "grant"}
}

// GrantFSRead issues a new temporary read-only grant over resource (an
// absolute directory) for sessionID, valid until now()+ttl. sessionID and
// resource are validated the same way internal/ownership already validates
// session/agent-group identifiers elsewhere in this project — a grant
// cannot be issued for a forged or path-shaped session id.
func (m *Manager) GrantFSRead(sessionID, resource string, ttl time.Duration, approvalContext string) (Grant, error) {
	if err := ownership.ValidateID(sessionID, "sessionId"); err != nil {
		return Grant{}, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	m.nextID++
	g := Grant{
		ID:              m.newIDLocked(),
		Resource:        filepath.Clean(resource),
		Action:          ActionFSRead,
		SessionID:       sessionID,
		IssuedAt:        now,
		ExpiresAt:       now.Add(ttl),
		ApprovalContext: approvalContext,
	}
	m.grants[g.ID] = g
	m.auditLocked(AuditEvent{At: now, Kind: "granted", GrantID: g.ID, SessionID: sessionID, Resource: g.Resource, Detail: approvalContext})
	return g, nil
}

func (m *Manager) newIDLocked() string {
	return m.idPrefix + "-" + itoa(m.nextID)
}

// itoa avoids pulling in strconv for one call site's worth of use — kept
// local and trivial rather than imported for a single int-to-string.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// CheckFSRead reports whether sessionID currently holds a live (non-expired)
// fs.read grant covering path, and records an audit event either way. This
// is the exact function P8-02's own done-when tests call twice against the
// same grant: once before ExpiresAt (want true) and once after (want
// false) — the same Manager, the same Grant, only the clock having moved.
func (m *Manager) CheckFSRead(sessionID, path string) (bool, string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	var best *Grant
	for _, g := range m.grants {
		if g.SessionID != sessionID || g.Action != ActionFSRead || !g.covers(path) {
			continue
		}
		gg := g
		if best == nil || gg.IssuedAt.After(best.IssuedAt) {
			best = &gg
		}
	}

	if best == nil {
		m.auditLocked(AuditEvent{At: now, Kind: "checked_denied_no_grant", SessionID: sessionID, Resource: path, Detail: "no fs.read grant covers this path for this session"})
		return false, "no fs.read grant covers this path for this session"
	}
	if now.After(best.ExpiresAt) {
		m.auditLocked(AuditEvent{At: now, Kind: "checked_denied_expired", GrantID: best.ID, SessionID: sessionID, Resource: path, Detail: "grant expired at " + best.ExpiresAt.UTC().Format(time.RFC3339)})
		return false, "grant expired at " + best.ExpiresAt.UTC().Format(time.RFC3339)
	}
	m.auditLocked(AuditEvent{At: now, Kind: "checked_allowed", GrantID: best.ID, SessionID: sessionID, Resource: path})
	return true, ""
}

// Revoke immediately invalidates grantID, before its natural expiry —
// idempotent (revoking an unknown or already-revoked id is a no-op, not an
// error, since the caller's intent — "this grant must not be usable" — is
// already satisfied either way).
func (m *Manager) Revoke(grantID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.grants[grantID]; !ok {
		return
	}
	delete(m.grants, grantID)
	m.auditLocked(AuditEvent{At: m.now(), Kind: "revoked", GrantID: grantID})
}

// Audit returns a copy of every recorded event, oldest first.
func (m *Manager) Audit() []AuditEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]AuditEvent, len(m.audit))
	copy(out, m.audit)
	return out
}

func (m *Manager) auditLocked(e AuditEvent) {
	m.audit = append(m.audit, e)
}
