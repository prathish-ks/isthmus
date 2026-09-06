// Package ownership enforces session/mailbox ownership (P5-04, Phase 5 —
// Security Kernel): "validate identity/session/agent relationships and
// prevent forged IDs or cross-session path/DB swaps."
//
// GENUINE FINDING this task surfaces, in BOTH hosts, not just Go: neither
// src/mailbox/sqlite/paths.ts's sessionMailboxDir/inboundDbPath/outboundDbPath
// (path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId)) nor
// this project's own already-shipped internal/mailbox.Path (P3-03 —
// filepath.Join(dataDir, "v2-sessions", agentGroupID, sessionID,
// "inbound.db")) validates agentGroupID/sessionID before joining them into a
// filesystem path. Both Go's filepath.Join and Node's path.join CLEAN the
// result — collapsing ".." segments rather than rejecting them — so an
// agentGroupID or sessionID string containing "../" would resolve OUTSIDE
// dataDir/v2-sessions in EITHER host, identically. This was exactly the item
// docs/threat-model-addendum-p5.md §3 flagged as "unverified... independent
// of the mount-validation layer entirely" — this package is that
// verification landing as real, tested code, not just a flagged risk.
//
// Calibration: this is a currently-UNEXPLOITED latent gap, not a live
// vulnerability report. In today's normal operation, agentGroupId/sessionId
// values are always host-generated (internal/session.generateID's own
// alphanumeric-with-hyphens format — see internal/session/session.go) and
// never taken raw from external input; nothing in this project's tracing so
// far shows an actual path from attacker-controlled text to these fields
// unsanitized. The point, consistent with this whole project's LAW-07
// philosophy applied one level down, is that the invariant was ASSUMED, not
// CHECKED — and P5-04's own instruction is exactly to turn assumptions like
// this into enforced structure. The TS host carries the identical gap today;
// see docs/ADR-005-p5-04-session-ownership.md for the recommendation left to
// the user about whether a matching small TS-side hardening PR is worth
// opening (their call, not made here — same posture as PR #3680's own
// mount-security fix).
//
// internal/mailbox.Path itself is NOT modified by this package — changing
// its signature would ripple through every P3-03/P4-01..06 call site that
// already depends on it returning a bare string. This package is instead the
// gate every NEW caller should go through first: ValidateID rejects a forged
// ID before it ever reaches mailbox.Path, and SafeMailboxDir/SafeMailboxPath
// wrap that check with the same path-join mailbox.Path performs, plus a
// belt-and-suspenders resolved-path recheck (in case an ID slips past the
// character-level check some other way this package's author did not
// anticipate — the same "narrow, never widen" posture mount.ResolveSymlinks
// takes in P5-02).
package ownership

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// idRe is deliberately narrower than "reject only '..'": it's an allowlist
// (alphanumeric, hyphen, underscore), not a denylist, so it cannot be
// bypassed by an encoding or separator this package's author did not
// anticipate (a literal NUL byte, a backslash on a host whose filepath
// package treats it as a separator, a URL-encoded "%2e%2e"). This is
// stricter than internal/session.generateID's own actual output needs to be
// — every real generated ID already matches it — so it rejects nothing
// legitimate while closing the gap completely rather than pattern-matching
// the one attack shape ("..") that happened to be named in the threat model.
var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// ValidateID rejects any agentGroupId/sessionId that is not a plain,
// non-empty token of [A-Za-z0-9_-]. what names the field in error messages
// (e.g. "agentGroupId", "sessionId") for a caller-actionable message.
func ValidateID(id, what string) error {
	if id == "" {
		return fmt.Errorf("spec-invalid: %s must not be empty", what)
	}
	if !idRe.MatchString(id) {
		return fmt.Errorf("denied-by-policy: %s %q contains characters outside [A-Za-z0-9_-] — refusing to use it in a filesystem path", what, id)
	}
	return nil
}

// SafeMailboxDir validates both IDs, then joins them exactly the way
// internal/mailbox.Path and src/mailbox/sqlite/paths.ts's sessionMailboxDir
// do, plus a resolved-path recheck: the joined result must still be a
// descendant of dataDir/v2-sessions. That recheck is pure defense in depth —
// once ValidateID has passed, filepath.Join cannot escape — but it is what
// makes this package's guarantee independent of idRe's exact character set
// being right forever, matching this project's general layered-checks
// discipline (see mount.ValidateSpec's own multiple redundant checks).
func SafeMailboxDir(dataDir, agentGroupID, sessionID string) (string, error) {
	if err := ValidateID(agentGroupID, "agentGroupId"); err != nil {
		return "", err
	}
	if err := ValidateID(sessionID, "sessionId"); err != nil {
		return "", err
	}
	root := filepath.Join(dataDir, "v2-sessions")
	dir := filepath.Join(root, agentGroupID, sessionID)
	if dir != root && !strings.HasPrefix(dir, root+string(filepath.Separator)) {
		// Unreachable given idRe today — kept as the same "narrow, never
		// widen" belt-and-suspenders pattern mount.checkSymlinkEscape uses.
		return "", fmt.Errorf("denied-by-policy: resolved mailbox dir %s escapes %s", dir, root)
	}
	return dir, nil
}

// SafeMailboxPath is SafeMailboxDir plus the inbound.db/outbound.db leaf,
// matching internal/mailbox.Path's and outbound.go's own naming.
//
// GENUINE FINDING (P9-02, found while writing this package's fuzz test,
// fixed the same way as this package's own ValidateID gap): side was never
// validated before being joined — every real call site passes a hardcoded
// literal ("inbound"/"outbound"), so this was not a live path today, but
// filepath.Join does not know that. A side value of
// "../../../../../../etc/passwd" joined against a real, short dataDir
// resolves OUTSIDE dataDir/v2-sessions entirely (confirmed executably by
// TestSafeMailboxPath_RejectsPathTraversalInSide) — exactly the class of bug
// this whole package exists to close for agentGroupID/sessionID, just left
// open one parameter over. Closed by running side through the identical
// idRe allowlist gate, which "inbound"/"outbound" already satisfy trivially.
func SafeMailboxPath(dataDir, agentGroupID, sessionID, side string) (string, error) {
	dir, err := SafeMailboxDir(dataDir, agentGroupID, sessionID)
	if err != nil {
		return "", err
	}
	if err := ValidateID(side, "side"); err != nil {
		return "", err
	}
	return filepath.Join(dir, side+".db"), nil
}

// ValidateOwnership is the cross-session-swap check named in this task's own
// instructions: given the session a caller CLAIMS to be acting on behalf of
// (claimedAgentGroupID) and the agentGroupID actually recorded for that
// session (e.g. from internal/session.FindByID, which already scopes by a
// caller-supplied agent group per its own doc comment — see
// internal/session/session.go's FindForAgent), refuse a mismatch. This is
// the mailbox-layer analogue of mount.ValidateSpec's group-state groupScope
// check (mount.go's mountAllowed, ClassGroupState case) — that package
// guards what gets MOUNTED into a container; this one guards what gets
// OPENED as a file, a distinct code path with no shared enforcement point.
func ValidateOwnership(claimedAgentGroupID, actualAgentGroupID string) error {
	if claimedAgentGroupID != actualAgentGroupID {
		return fmt.Errorf("denied-by-policy: session belongs to agent group %q, not the claimed %q", actualAgentGroupID, claimedAgentGroupID)
	}
	return nil
}
