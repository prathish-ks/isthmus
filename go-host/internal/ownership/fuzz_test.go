package ownership

// P9-02 (Phase 9/10 hardening): fuzz target #2 of 5 — forged/malformed
// agentGroupID and sessionID values, the exact class of input this
// package's own doc comment names as the historically-ASSUMED, now-CHECKED
// invariant ("neither host validates agentGroupId/sessionId before joining
// them into a filesystem path"). FuzzValidateID exercises the character-
// class gate directly; FuzzSafeMailboxPath exercises the composed
// join-then-recheck a real caller actually uses, and pins the property that
// matters operationally: whatever SafeMailboxPath returns, when it returns
// no error, must be a path that stays under dataDir/v2-sessions — never
// outside it, regardless of what garbage the two ID strings contain.

import (
	"path/filepath"
	"strings"
	"testing"
)

func FuzzValidateID(f *testing.F) {
	seeds := []string{
		"", "s1", "../../etc/passwd", "..", ".", "a/b", "a\\b", "a\x00b",
		"g1-folder_2", strings.Repeat("a", 5000), "%2e%2e%2fescape", "g1/../../x",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, id string) {
		// Must never panic on any input, and must never accept anything
		// containing a path separator or a ".."/"." segment shape — the
		// allowlist regex is the entire guarantee this function exists to
		// provide.
		err := ValidateID(id, "testField")
		if err == nil && !idRe.MatchString(id) {
			t.Fatalf("ValidateID accepted %q, which does not match the required character class", id)
		}
	})
}

func FuzzSafeMailboxPath(f *testing.F) {
	type seed struct{ agentGroupID, sessionID, side string }
	seeds := []seed{
		{"g1", "s1", "inbound"},
		{"../../etc", "passwd", "inbound"},
		{"g1", "../../../s1", "outbound"},
		{"", "", ""},
		{"g1/../../escape", "s1", "inbound"},
		{"g1", "s1", "../../../etc/passwd"},
	}
	for _, s := range seeds {
		f.Add(s.agentGroupID, s.sessionID, s.side)
	}

	dataDir := f.TempDir()

	f.Fuzz(func(t *testing.T, agentGroupID, sessionID, side string) {
		path, err := SafeMailboxPath(dataDir, agentGroupID, sessionID, side)
		if err != nil {
			return // fail-closed is always an acceptable outcome
		}
		root := filepath.Join(dataDir, "v2-sessions")
		resolved := filepath.Clean(path)
		if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			t.Fatalf("SafeMailboxPath(%q, %q, %q, %q) = %q, which escapes root %q",
				dataDir, agentGroupID, sessionID, side, path, root)
		}
	})
}
