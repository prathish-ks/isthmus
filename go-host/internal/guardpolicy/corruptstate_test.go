package guardpolicy

import (
	"context"
	"errors"
	"testing"
)

// This file is P9-04's malformed/corrupt-state suite for this package
// (master plan: "Cover invalid DB rows, bad container config, forged IDs,
// missing files, stale locks and selected disk errors... Done when: System
// fails closed for security and clearly for operations").
//
// Unlike policy_test.go's golden fixtures (which exercise this package
// against a real sqlite-backed CLIScopeLookup/ApprovalLookup, and so cannot
// run in this network-restricted sandbox without vendor/ staged — see this
// project's README), every scenario below is expressed purely against the
// CLIScopeLookup/ApprovalLookup/RuntimeCapabilities INTERFACES with a
// hand-written fake, exactly like fuzz_test.go's fuzzScopeLookup already
// does — so it needs no database at all and both builds and runs fully
// offline. That is also the more faithful way to express "a corrupt
// container_configs row" or "a disk error reading pending_approvals": the
// real SQLCLIScopeLookup/SQLApprovalLookup wrappers (guarddb.go) are a thin
// pass-through to *sql.DB — the interesting failure mode is what this
// package's own decision logic does with whatever a lookup call returns,
// not whether database/sql itself can return an error (it can, trivially).

// errCLIScopeLookup always fails, standing in for a disk I/O error, a
// corrupted sqlite page, or any other reason a real CLIScopeLookup's query
// against container_configs might come back unable to answer at all —
// distinct from "no row" (which SQLCLIScopeLookup already normalizes to
// ""/"group", per CLIScopeLookup's own doc comment).
type errCLIScopeLookup struct{ err error }

func (l errCLIScopeLookup) CLIScope(ctx context.Context, agentGroupID string) (string, error) {
	return "", l.err
}

// errApprovalLookup always fails, standing in for the same class of
// disk/corruption failure against pending_approvals.
type errApprovalLookup struct{ err error }

func (l errApprovalLookup) PendingApproval(ctx context.Context, approvalID string) (string, string, bool, error) {
	return "", "", false, l.err
}

// panicIfCalledApprovalLookup fails the test outright if PendingApproval is
// ever invoked — used to prove a short-circuit never reaches the lookup at
// all, the strongest form of "never trusts/needs that data" a test can make.
type panicIfCalledApprovalLookup struct{ t *testing.T }

func (l panicIfCalledApprovalLookup) PendingApproval(ctx context.Context, approvalID string) (string, string, bool, error) {
	l.t.Helper()
	l.t.Fatal("PendingApproval should never be consulted for this case")
	return "", "", false, nil
}

// TestDecideRestartLike_CLIScopeLookupErrorFailsClosed pins that a disk/DB
// failure resolving cli_scope surfaces as an ERROR from DecideRestartLike —
// never silently defaulting to an allow/hold Decision. A caller (this
// package's own kernel caller, internal/kernel's checkCLIRestartGuard)
// treats any non-nil error as a denial (see that function's own comment:
// "guard evaluation failed (failing closed)"), so this test is what proves
// the input to that fail-closed behavior is actually produced.
func TestDecideRestartLike_CLIScopeLookupErrorFailsClosed(t *testing.T) {
	wantErr := errors.New("disk I/O error reading container_configs")
	got, err := DecideRestartLike(context.Background(), errCLIScopeLookup{err: wantErr}, restartLikeCmd, agentActor("g1"), map[string]string{})
	if err == nil {
		t.Fatal("expected an error when the cli_scope lookup itself fails, not a Decision")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the lookup error to be wrapped, not replaced: got %v", err)
	}
	if got.Effect != "" {
		t.Fatalf("expected a zero-value Decision alongside the error, got Effect=%q — a caller that forgets to check err must not observe an accidental allow/hold", got.Effect)
	}
}

// TestEvaluateWithGrant_CLIScopeLookupErrorPropagates pins that
// EvaluateWithGrant does not swallow the same lookup error partway through
// its own wrapping logic — it must surface exactly as DecideRestartLike
// alone would, even though a grant was also presented.
func TestEvaluateWithGrant_CLIScopeLookupErrorPropagates(t *testing.T) {
	wantErr := errors.New("disk I/O error reading container_configs")
	grant := &Grant{ApprovalID: "appr-1", Action: "cli_command"}
	_, err := EvaluateWithGrant(context.Background(), errCLIScopeLookup{err: wantErr}, panicIfCalledApprovalLookup{t: t}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the cli_scope lookup error to propagate before the approval lookup is ever consulted, got %v", err)
	}
}

// TestEvaluateWithGrant_ApprovalLookupErrorPropagates pins the second half:
// once DecideRestartLike itself succeeds with a hold, a disk/corruption
// failure reading the pending_approvals row must also surface as an error —
// never silently treated as "no matching approval" (which would produce a
// deny — a materially different, and misleadingly specific, outcome from
// "we could not check").
func TestEvaluateWithGrant_ApprovalLookupErrorPropagates(t *testing.T) {
	wantErr := errors.New("disk I/O error reading pending_approvals")
	grant := &Grant{ApprovalID: "appr-1", Action: "cli_command"}
	_, err := EvaluateWithGrant(context.Background(), groupScopeLookup{}, errApprovalLookup{err: wantErr}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the approval lookup error to propagate, got %v", err)
	}
}

// groupScopeLookup is a fixed, always-succeeds CLIScopeLookup returning the
// default "group" scope — used by tests in this file that need to get past
// the cli_scope check cleanly so they can isolate a failure further down
// the chain (the approval lookup, or a grant's own shape).
type groupScopeLookup struct{}

func (groupScopeLookup) CLIScope(ctx context.Context, agentGroupID string) (string, error) {
	return "group", nil
}

// TestDecideRestartLike_UnrecognizedCLIScopeValueTreatedAsUnrestricted
// documents CURRENT behavior on a corrupted/unexpected cli_scope value — a
// hand-edited row, a future migration's not-yet-handled enum member, or
// literal corruption — rather than asserting it as a newly-added
// restriction: DecideRestartLike only special-cases the literal strings
// "group" and "disabled" (mirroring src/cli/guard.ts's own commandDecide
// exactly, per this function's doc comment); any other value, including
// this kind of garbage, falls through identically to the documented
// "global" scope — i.e. unrestricted, not fail-closed. This is a verbatim
// port of upstream TS semantics, not a Go-only gap, so this test exists to
// make the behavior visible and pin it against silent, unreviewed drift in
// either direction — not to change it. If this project ever decides
// corrupted cli_scope values should fail closed instead (a real hardening
// candidate), that would be a deliberate, documented divergence from
// upstream, tracked as its own ADR — not a side effect of this test.
func TestDecideRestartLike_UnrecognizedCLIScopeValueTreatedAsUnrestricted(t *testing.T) {
	got, err := DecideRestartLike(context.Background(), fixedScopeLookup{scope: "\x00garbled-enum-value\x00"}, openGroupsCmd, agentActor("g1"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "allow" {
		t.Fatalf("effect = %q, want allow (current behavior: any cli_scope other than %q/%q/\"\" is treated as unrestricted, same as %q)",
			got.Effect, "group", "disabled", "global")
	}
}

type fixedScopeLookup struct{ scope string }

func (l fixedScopeLookup) CLIScope(ctx context.Context, agentGroupID string) (string, error) {
	return l.scope, nil
}

// TestGrantSatisfies_WrongGrantActionNeverConsultsApprovalLookup proves the
// short-circuit in grantSatisfies (grant.Action != "cli_command") happens
// BEFORE any attempt to read pending_approvals — a forged or stale grant
// naming the wrong action class is rejected on its own shape, without ever
// needing (or trusting the absence of) a corresponding DB row.
func TestGrantSatisfies_WrongGrantActionNeverConsultsApprovalLookup(t *testing.T) {
	grant := &Grant{ApprovalID: "appr-1", Action: "self_mod.install_packages"} // wrong action class for the CLI-restart guard
	got, err := EvaluateWithGrant(context.Background(), groupScopeLookup{}, panicIfCalledApprovalLookup{t: t}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if err != nil {
		t.Fatalf("EvaluateWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (wrong grant action class, rejected on shape alone)", got.Effect)
	}
}

// errRuntimeCapabilities always fails ImageBuildSupported, standing in for
// a runtime/driver-side query that cannot be answered (e.g. the driver
// process itself is unreachable) — distinct from a clean "false" answer.
type errRuntimeCapabilities struct{ err error }

func (c errRuntimeCapabilities) ImageBuildSupported(ctx context.Context) (bool, error) {
	return false, c.err
}

// TestDecideSelfMod_ImageBuildCapabilityErrorFailsClosed mirrors the
// CLI-restart guard's own lookup-error test, for self-mod's
// RuntimeCapabilities dependency: a failure to determine whether the active
// runtime supports image builds must surface as an error, not silently
// resolve to either "supported" (which would let a hold reach an admin for
// something impossible to execute) or "unsupported" (which would produce a
// specific, and misleadingly confident, deny reason for what is actually an
// unknown state).
func TestDecideSelfMod_ImageBuildCapabilityErrorFailsClosed(t *testing.T) {
	wantErr := errors.New("driver capability query timed out")
	got, err := DecideSelfMod(context.Background(), errRuntimeCapabilities{err: wantErr}, SelfModInstallPackages, agentActor("g1"))
	if err == nil {
		t.Fatal("expected an error when the image-build capability check itself fails, not a Decision")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the capability-check error to be wrapped, not replaced: got %v", err)
	}
	if got.Effect != "" {
		t.Fatalf("expected a zero-value Decision alongside the error, got Effect=%q", got.Effect)
	}
}

// TestEvaluateSelfModWithGrant_ApprovalLookupErrorPropagates is
// EvaluateWithGrant's approval-lookup-error test, ported to the self-mod
// wrapper: once DecideSelfMod itself produces a hold, a disk/corruption
// failure reading pending_approvals must surface as an error here too, not
// as a deny.
func TestEvaluateSelfModWithGrant_ApprovalLookupErrorPropagates(t *testing.T) {
	wantErr := errors.New("disk I/O error reading pending_approvals")
	grant := &Grant{ApprovalID: "appr-1", Action: "add_mcp_server"}
	_, err := EvaluateSelfModWithGrant(context.Background(), fixedCapabilities{imageBuild: true}, errApprovalLookup{err: wantErr}, SelfModAddMCPServer, agentActor("g1"), grant)
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the approval lookup error to propagate, got %v", err)
	}
}
