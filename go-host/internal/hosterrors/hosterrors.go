// Package hosterrors implements P7-05's error taxonomy (Phase 7 — UX &
// Operations): a small, typed Category plus one-line actionable Guidance,
// mapped from the low-level errors this project's other packages already
// return (database/sql, os, os/exec, internal/mount's ValidationError) —
// so a person reading `nanogo doctor`/`status`/`security-check` output
// learns what to do next instead of a bare Go error string. The original
// error is always preserved as Cause (via Unwrap), never discarded — this
// package categorizes, it does not replace error handling.
//
// Deliberately small (LAW-05): a Category exists only when it changes what
// the user should do next, not as a mirror of Go's own error-type
// hierarchy. New callers that already know their own error's meaning
// (internal/doctor's checks, internal/capability, a future credential
// broker) should construct a HostError directly with New rather than
// stringly-matching their way into Categorize's generic buckets.
package hosterrors

import (
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// Category is the closed set of buckets this taxonomy sorts errors into.
type Category string

// The closed set of buckets Categorize sorts an error into.
const (
	CategoryConfig     Category = "config"
	CategoryDatabase   Category = "database"
	CategoryRuntime    Category = "runtime"
	CategoryCredential Category = "credential"
	CategoryAdapter    Category = "adapter"
	CategorySecurity   Category = "security"
	CategoryUnknown    Category = "unknown"
)

// HostError pairs a Category and human Guidance with the original Cause.
// Message is a short, stable summary; Guidance is the actionable next step;
// Cause is never nil for an error produced by Categorize, and Unwrap
// exposes it so errors.Is/errors.As still see through to the real cause.
type HostError struct {
	Category Category
	Message  string
	Guidance string
	Cause    error
}

// New constructs an already-categorized HostError. Prefer this over
// Categorize when the caller already knows exactly what went wrong and
// what the user should do about it (Categorize's job is inferring that for
// errors arriving from packages that don't know about this taxonomy).
func New(category Category, message, guidance string, cause error) *HostError {
	return &HostError{Category: category, Message: message, Guidance: guidance, Cause: cause}
}

// Error satisfies the error interface. Guidance is deliberately not part of
// Error()'s string — Error() is for logs/wrapping, Guidance is for a CLI's
// own formatted, human-facing rendering (see internal/doctor's Result).
func (e *HostError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Category, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Category, e.Message)
}

// Unwrap exposes Cause so errors.Is/errors.As keep working through a
// categorized error exactly as they would through the original.
func (e *HostError) Unwrap() error { return e.Cause }

// Categorize maps err into a *HostError. Never returns nil for a non-nil
// err: an error this taxonomy does not specifically recognize becomes
// CategoryUnknown with a generic guidance line rather than being passed
// through uncategorized, which would defeat the whole point — every
// doctor/status/security-check failure should tell the user what to do
// next, even when that's only "see the underlying error for detail."
// Categorize(nil) returns nil.
func Categorize(err error) *HostError {
	if err == nil {
		return nil
	}

	// Already categorized upstream (e.g. by internal/doctor's own checks,
	// or a nested Categorize call) — don't double-wrap.
	var already *HostError
	if errors.As(err, &already) {
		return already
	}

	var valErr *mount.ValidationError
	var opErr *net.OpError
	switch {
	case errors.As(err, &valErr):
		return New(CategorySecurity, "a mount or container spec failed a security check",
			"this is a deny, not a bug — review the rejected value against docs/threat-model.md and, for mount paths, mount-allowlist.json", err)

	case errors.Is(err, sql.ErrNoRows):
		return New(CategoryDatabase, "expected database row was not found",
			"the session/mailbox row may not exist yet, or the id is wrong — verify the id and whether the session was ever created", err)

	case errors.Is(err, sql.ErrTxDone):
		return New(CategoryDatabase, "a database transaction was reused after it already completed",
			"this indicates an internal bug rather than a data problem — please file an issue with the command that triggered it", err)

	// Checked before the generic os.ErrNotExist/os.ErrPermission cases
	// below: dialing a missing or unreachable Unix socket surfaces as a
	// *net.OpError wrapping exactly that same underlying os error, but the
	// user's actionable next step (start the kernel process) is completely
	// different from "fix a file path in your config."
	case errors.As(err, &opErr):
		return New(CategoryAdapter, "could not reach the kernel over its Unix socket",
			"the kernel process (cmd/nanogo -serve) is likely not running, or the socket path is wrong — this is expected until Phase 7+ wires a long-lived kernel process", err)

	case errors.Is(err, os.ErrNotExist):
		return New(CategoryRuntime, "a required file or directory does not exist",
			"check the path in your config; `nanogo doctor` reports exactly which path is missing", err)

	case errors.Is(err, os.ErrPermission):
		return New(CategoryRuntime, "permission denied accessing a file or directory",
			"check ownership/permissions on the reported path — the host process must be able to read/write it", err)

	case errors.Is(err, exec.ErrNotFound):
		return New(CategoryRuntime, "a required external program was not found on PATH",
			"install the missing binary (e.g. docker, onecli) and ensure it is on PATH, then re-run `nanogo doctor`", err)

	default:
		return New(CategoryUnknown, "unrecognized error",
			"no specific guidance is available for this error yet — see the underlying cause below", err)
	}
}
