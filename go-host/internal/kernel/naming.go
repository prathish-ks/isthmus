package kernel

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// Canonical label keys — the adoption contract (LABELS, drivers/types.ts:324-329).
const (
	labelInstall = "nanoclaw-install"
	labelGroup   = "nanoclaw-group"
	labelSession = "nanoclaw-session"
	labelRole    = "nanoclaw-role"
)

var nonNameChar = regexp.MustCompile(`[^a-zA-Z0-9_.-]`)

// ContainerName is the Go port of agentContainerName
// (docker-driver.ts:612-617): derived from the session key alone, never from
// a timestamp or any caller-supplied name field. EC-02 (Phase 9) moves this
// derivation into the kernel itself — the kernel is now the one deriving
// the identity it creates, exactly the same "resolve the fact ourselves"
// discipline handleKill already applies to resolving a container's name
// from its own registry at kill time, extended here to wake time.
//
// Idempotency-on-key (docker-driver.ts's #existingSession, an
// inspect-before-create check) stays a TypeScript-side, read-only
// responsibility per ADR-016 — inspecting is not a mutation this boundary
// needs to gate, so it is not reproduced here.
func ContainerName(key mount.SessionKey) string {
	raw := nonNameChar.ReplaceAllString(fmt.Sprintf("%s-%s", key.InstallSlug, key.SessionID), "-")
	if len(raw) <= 48 {
		return "ncl-" + raw
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s %s", key.InstallSlug, key.SessionID)))
	hash := hex.EncodeToString(sum[:])[:8]
	return fmt.Sprintf("ncl-%s-%s", raw[:39], hash)
}

// LabelsForKey is the Go port of labelsForKey (docker-driver.ts:360-369):
// the four canonical adoption labels, plus any extra (group-folder, and a
// container's own realization-only Labels) layered on top. extra is applied
// after the canonical four, matching the TS spread order — a caller cannot
// use extra to overwrite an adoption-contract label with a different value
// for the SAME key, since Go's map literal construction below always writes
// the canonical four last... actually to mirror `{...canonical, ...extra}`
// exactly (extra wins on collision), extra is applied last.
func LabelsForKey(key mount.SessionKey, role string, extra map[string]string) map[string]string {
	labels := map[string]string{
		labelInstall: key.InstallSlug,
		labelGroup:   key.AgentGroupID,
		labelSession: key.SessionID,
		labelRole:    role,
	}
	for k, v := range extra {
		labels[k] = v
	}
	return labels
}
