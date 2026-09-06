// Package trace implements P7-03's message trace (Phase 7 — UX &
// Operations): a bounded, in-memory, per-key event log recording which
// pipeline stage a message (or, where no message id is available at that
// stage, the session id) passed through and when — so `nanogo trace <id>`
// can answer "where did this stop?" instead of requiring a log grep.
//
// Scope, matching where this project's pipeline actually lives today: only
// internal/kernel's five dispatch primitives are wired to record events
// (see internal/kernel's Dispatch, which calls Record after every
// route.request/session.lookup/capability.request/delivery.request). The
// master plan's own illustrative stage list — "intake, route, session,
// container wake, outbound, delivery" — spans TypeScript-owned pipeline
// points (intake, outbound) this Go module does not run yet; those two
// stages are defined here for forward compatibility (a future TS-side
// caller of a kernel-exposed trace op could record them) but nothing in
// this codebase emits them today. This is the same "component exists,
// wiring into the full live pipeline is a later step" honesty this
// project's other ADRs already apply to internal/kernel itself.
//
// Store is explicitly NOT a durable audit trail — restarting the process
// holding it loses history, the same posture internal/kernel's own
// auditLog already takes for the same LAW-05 reason (a durable store is a
// new component that would need its own justification).
package trace

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"
)

// Stage names the pipeline point an Event was recorded at.
type Stage string

// The pipeline stages an Event can be recorded at.
const (
	StageIntake         Stage = "intake" // TS-owned; not yet emitted by this module (see package doc)
	StageRoute          Stage = "route"
	StageSession        Stage = "session"
	StageContainerWake  Stage = "container_wake"
	StageContainerKill  Stage = "container_kill"  // extension beyond the master plan's illustrative list
	StageContainerBuild Stage = "container_build" // extension beyond the master plan's illustrative list
	StageOutbound       Stage = "outbound"        // TS-owned; not yet emitted by this module (see package doc)
	StageDelivery       Stage = "delivery"
)

// Event is one recorded pipeline step. Summary must already be safe to
// store — pass it through Redact first if it might contain message content
// or secrets; a Stage name, an allow/deny outcome, or a reason string that
// doesn't echo user content is fine to pass through directly.
type Event struct {
	Key     string    `json:"key"`
	Stage   Stage     `json:"stage"`
	At      time.Time `json:"at"`
	Summary string    `json:"summary,omitempty"`
}

// Redact returns a version of s safe to store as an Event's Summary:
// content is replaced by its length, never retained verbatim — "redact
// message content/secrets by default," per the task's own instruction.
// Reserve this for actual message/user content; structural facts (stage,
// allowed/denied, a non-content reason string) don't need it.
func Redact(s string) string {
	if s == "" {
		return "(empty)"
	}
	return fmt.Sprintf("(redacted, %d bytes)", len(s))
}

// defaultCapacityPerKey bounds how many events are kept for one key, oldest
// evicted first — the same fixed-ring-buffer reasoning internal/kernel's
// own audit log already uses, so a hostile or buggy caller cannot grow one
// key's history unboundedly.
const defaultCapacityPerKey = 64

// Store is a concurrency-safe, in-memory, per-key event log, optionally
// mirrored to a durable append-only file (see NewFileBackedStore) — the
// in-memory half is what a live kernel process reads from directly; the
// file half is what lets a separate, short-lived `nanogo trace` CLI
// invocation see the same history despite having no access to that
// process's memory (cmd/nanogo does not yet run as a long-lived daemon a
// CLI could instead just query — ADR-009's carried-forward gap).
type Store struct {
	mu          sync.Mutex
	capacity    int
	byKey       map[string][]Event
	persistPath string // "" (the default, NewStore) means in-memory only
}

// NewStore returns an in-memory-only Store bounding each key's history to
// capacityPerKey events (defaultCapacityPerKey if capacityPerKey <= 0).
func NewStore(capacityPerKey int) *Store {
	if capacityPerKey <= 0 {
		capacityPerKey = defaultCapacityPerKey
	}
	return &Store{capacity: capacityPerKey, byKey: make(map[string][]Event)}
}

// NewFileBackedStore is NewStore plus a durable JSON-lines mirror at path:
// every successful Record also best-effort appends one JSON-encoded Event
// line there (see AppendToFile/ReadFile). A write failure to path is never
// allowed to affect the caller that triggered tracing — Record has no
// return value precisely so a tracing side-effect can never fail a real
// request; a persistence failure is silently dropped rather than surfaced,
// the same trade-off internal/kernel's own in-memory-only audit log already
// accepts for the same reason (tracing is an observability aid, not a
// correctness dependency).
func NewFileBackedStore(path string, capacityPerKey int) *Store {
	s := NewStore(capacityPerKey)
	s.persistPath = path
	return s
}

// Record appends e to its Key's history, setting At to time.Now() if the
// caller left it zero. A blank Key is a no-op — there is nothing to key the
// event by, so silently dropping it (rather than storing under "") avoids
// every un-keyed caller's events colliding into one bucket.
func (s *Store) Record(e Event) {
	if e.Key == "" {
		return
	}
	if e.At.IsZero() {
		e.At = time.Now()
	}
	s.mu.Lock()
	events := append(s.byKey[e.Key], e)
	if len(events) > s.capacity {
		events = events[len(events)-s.capacity:]
	}
	s.byKey[e.Key] = events
	path := s.persistPath
	s.mu.Unlock()

	if path != "" {
		_ = AppendToFile(path, e)
	}
}

// AppendToFile appends one JSON-encoded line for e to the file at path,
// creating it (mode 0600 — trace summaries are redacted, but the path is
// still not made world-readable by default) if it doesn't exist yet.
func AppendToFile(path string, e Event) (err error) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		// A failed Close on a write handle can mean a buffered write never
		// actually landed — surface it, but never let it mask a real
		// Encode error, which is the more actionable of the two.
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	err = json.NewEncoder(f).Encode(e)
	return err
}

// ReadFile reads every event ever appended to path (via AppendToFile /
// NewFileBackedStore) and returns those matching key, oldest first. A
// missing file returns an empty, non-nil slice and no error — "nothing
// traced yet" is the normal state for a fresh install, not a failure. A
// line that fails to parse (e.g. a partial write from a killed process) is
// skipped rather than failing the whole read.
func ReadFile(path, key string) ([]Event, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return []Event{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }() // read-only handle; a close error here has no reader-visible consequence

	out := []Event{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var e Event
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			continue
		}
		if e.Key == key {
			out = append(out, e)
		}
	}
	if err := scanner.Err(); err != nil {
		return out, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, nil
}

// Trace returns key's recorded events, oldest first, as a copy safe for the
// caller to hold onto after this call returns. An unknown key returns an
// empty, non-nil slice — never an error; "no events recorded yet" is a
// normal, expected state for `nanogo trace`, not a failure.
func (s *Store) Trace(key string) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	events := s.byKey[key]
	out := make([]Event, len(events))
	copy(out, events)
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}
