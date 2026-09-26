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

// LabelsForKey: the four canonical adoption labels, plus any extra
// (group-folder, and — since the v2.4.0 gateway-provider seam — a
// gateway-composed auxiliary container's own realization-only Labels)
// layered on top. The canonical four are applied LAST, deliberately
// overwriting anything `extra` supplies for the same key: `extra` is
// untrusted-provider-supplied content (a gateway's `ContainerSpec.labels`,
// per `gateway-provider-registry.ts`'s `GatewayContribution.containers`)
// reaching this function with no upstream admission check at all —
// `mount.ValidateSpec`'s own comment states plainly that Labels is one of
// the realization-only fields it never reads. Adoption
// (`listSessions`/`watchSessions`/the wake-time collision check in
// `docker-driver.ts`) trusts these four keys as ground truth for which live
// container belongs to which session, across every install sharing a
// daemon; a caller-supplied `extra` value winning on collision would let a
// gateway-composed auxiliary container impersonate another session, group,
// or install's agent. An earlier version of this function let `extra` win
// on collision (matching a stale TS `{...canonical, ...extra}` spread this
// doc comment used to cite from a pre-ADR-016 TS-side implementation that
// no longer exists — Go has owned container realization exclusively since
// ADR-016); found and closed as a latent gap before any registered gateway
// provider populated `.containers[].labels` (see
// TestLabelsForKey_CanonicalWinsOverColludingExtra's negative control).
func LabelsForKey(key mount.SessionKey, role string, extra map[string]string) map[string]string {
	labels := make(map[string]string, len(extra)+4)
	for k, v := range extra {
		labels[k] = v
	}
	labels[labelInstall] = key.InstallSlug
	labels[labelGroup] = key.AgentGroupID
	labels[labelSession] = key.SessionID
	labels[labelRole] = role
	return labels
}
