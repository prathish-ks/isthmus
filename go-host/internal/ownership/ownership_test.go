package ownership

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
)

func TestValidateID_RejectsEmpty(t *testing.T) {
	if err := ValidateID("", "sessionId"); err == nil {
		t.Fatal("expected an empty id to be rejected")
	}
}

func TestValidateID_RejectsDotDotTraversal(t *testing.T) {
	if err := ValidateID("../../../etc", "agentGroupId"); err == nil {
		t.Fatal("expected a '..'-bearing id to be rejected")
	}
}

func TestValidateID_RejectsEmbeddedSlash(t *testing.T) {
	if err := ValidateID("ag-1/sess-2", "sessionId"); err == nil {
		t.Fatal("expected an id containing '/' to be rejected")
	}
}

func TestValidateID_RejectsAbsolutePath(t *testing.T) {
	if err := ValidateID("/etc/passwd", "agentGroupId"); err == nil {
		t.Fatal("expected an absolute-path-shaped id to be rejected")
	}
}

func TestValidateID_AllowsRealGeneratedIDShape(t *testing.T) {
	// Mirrors internal/session.generateID's actual output shape (see
	// session.go) — this package must reject forgeries, not legitimate IDs.
	if err := ValidateID("ag-1788008257480-b2n3zv", "agentGroupId"); err != nil {
		t.Fatalf("a real generated-ID shape must be allowed: %v", err)
	}
}

func TestSafeMailboxDir_RejectsForgedAgentGroupID(t *testing.T) {
	_, err := SafeMailboxDir("/data", "../../../tmp/evil", "sess-1")
	if err == nil {
		t.Fatal("expected a forged agentGroupId to be rejected before any path is constructed")
	}
}

func TestSafeMailboxDir_RejectsForgedSessionID(t *testing.T) {
	_, err := SafeMailboxDir("/data", "ag-1", "../../etc/passwd")
	if err == nil {
		t.Fatal("expected a forged sessionId to be rejected before any path is constructed")
	}
}

func TestSafeMailboxDir_LegitimateIDsProduceExactlyMailboxPackagesPath(t *testing.T) {
	dir, err := SafeMailboxDir("/data", "ag-1", "sess-1")
	if err != nil {
		t.Fatalf("expected legitimate ids to pass: %v", err)
	}
	want := filepath.Dir(mailbox.Path("/data", "ag-1", "sess-1"))
	if dir != want {
		t.Fatalf("SafeMailboxDir = %s, want %s (must match internal/mailbox.Path's own join exactly)", dir, want)
	}
}

func TestSafeMailboxPath_MatchesMailboxPackageForInbound(t *testing.T) {
	got, err := SafeMailboxPath("/data", "ag-1", "sess-1", "inbound")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := mailbox.Path("/data", "ag-1", "sess-1")
	if got != want {
		t.Fatalf("SafeMailboxPath = %s, want %s", got, want)
	}
}

// TestFilepathJoinAloneWouldHaveBeenExploitable documents, executably, the
// exact gap this package closes: filepath.Join alone (what
// internal/mailbox.Path and src/mailbox/sqlite/paths.ts's path.join both do)
// resolves a ".."-bearing agentGroupId OUTSIDE dataDir/v2-sessions instead of
// rejecting it. This is not a test of this package's own behavior — it is a
// permanent regression pin proving the underlying risk this package guards
// against is real, so the guard is never "simplified away" as apparently
// unnecessary later.
func TestFilepathJoinAloneWouldHaveBeenExploitable(t *testing.T) {
	unsafe := mailbox.Path("/data", "../../../tmp/evil", "sess-1")
	root := filepath.Join("/data", "v2-sessions")
	if strings.HasPrefix(unsafe, root+string(filepath.Separator)) {
		t.Fatal("expected the unguarded join to escape /data/v2-sessions — if this now fails, mailbox.Path itself started validating and this package's rationale should be revisited, not deleted silently")
	}
}

// TestSafeMailboxPath_RejectsPathTraversalInSide pins the P9-02 finding
// (see SafeMailboxPath's own doc comment): before the fix, side was joined
// unvalidated, so a crafted side value could resolve OUTSIDE
// dataDir/v2-sessions even with fully legitimate agentGroupID/sessionID
// values. No production call site passes anything but a literal
// "inbound"/"outbound" today (confirmed: SafeMailboxPath's only callers at
// the time of this fix are this package's own tests), so this was a latent
// gap, not a live exploit — this test exists so it stays closed.
func TestSafeMailboxPath_RejectsPathTraversalInSide(t *testing.T) {
	dataDir := t.TempDir()
	path, err := SafeMailboxPath(dataDir, "ag-1", "sess-1", "../../../../../../etc/passwd")
	if err == nil {
		t.Fatalf("expected a path-traversal side value to be rejected, got path %q", path)
	}
}

func TestValidateOwnership_RejectsMismatchedAgentGroup(t *testing.T) {
	if err := ValidateOwnership("ag-1", "ag-2"); err == nil {
		t.Fatal("expected a claimed/actual agent-group mismatch to be rejected")
	}
}

func TestValidateOwnership_AllowsMatch(t *testing.T) {
	if err := ValidateOwnership("ag-1", "ag-1"); err != nil {
		t.Fatalf("expected a matching agent group to be allowed: %v", err)
	}
}
