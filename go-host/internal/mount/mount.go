// Package mount ports src/drivers/types.ts's validateSpec/mountAllowed mount
// rules to Go (P5-02, Phase 5 — Security Kernel).
//
// Scope, per docs/host-decomposition-addendum-drivers.md: types.ts has zero
// external imports and is the actual unconditional chokepoint every
// SessionSpec passes through before real Docker realization
// (DockerSessionDriver.prepare's literal first line is validateSpec). This
// package ports that function and its helpers field-for-field, cited against
// the exact source lines, plus two deliberate additions the task's own
// instructions call for that the pinned TS baseline does not attempt:
//
//  1. Real symlink-escape resolution (ResolveSymlinks in Policy). TS's
//     hostPathCanonical is lexical only — see types.ts's own comment
//     ("Symlinks remain beyond a lexical check — that is what
//     admissionEnforced realizations are for"). A Go host validating on the
//     same machine that will realize the mount CAN check the real filesystem,
//     so this package does, as an opt-in hardening layer distinct from the
//     always-on lexical check (which is kept identical to TS so a spec that
//     was rejected before is still rejected the same way, for the same
//     stated reason).
//  2. AllowlistedExtraCheck: a hook mirroring the shipped (not yet merged)
//     mount-security-hardening.patch / nanocoai/nanoclaw#3680, which closes
//     the 'allowlisted-extra' unconditional-trust gap confirmed live by this
//     project's docs/mount-validation-fixtures-p5.md (24-case capture, 2
//     DIFF rows). CheckAllowlistedExtra below is a Go port of that patch's
//     own isHostPathAllowlisted (src/modules/mount-security/index.ts's
//     loadMountAllowlist/matchesBlockedPattern/findAllowedRoot).
//
// The hook defaults to nil, which reproduces the pinned v2.3.0 baseline's
// unconditional 'return true' exactly (LAW-06: reproduce before optimizing —
// same discipline P4-01 through P4-06 followed). Wiring
// CheckAllowlistedExtra is a separate, deliberate decision, and
// docs/ADR-004-p5-02-mount-hardening.md records an important caveat before
// anyone flips it on: src/gateway-providers/onecli.ts's contributionFromArgs
// stamps its OWN 'allowlisted-extra' mounts for the OneCLI gateway's CA
// certificate and credential-stub FILES (never carried as env, per that
// file's own doc comment) — mounts that did not come from the operator's
// mount-allowlist.json and are not expected to appear in it. Applying the
// SAME allowlist-file check uniformly to every 'allowlisted-extra' mount,
// operator-configured and provider-contributed alike, would block OneCLI's
// own credential injection unless its stub-file directory happens to already
// be a listed allowedRoot.
//
// RESOLVED, 2026-09-02 (P6-04): the recommendation this comment used to defer
// to "the user's own PR" shipped for real -- nanocoai/nanoclaw#3680, commit
// fdde3b26, adds MountSpec.origin?: 'operator' | 'provider' and exempts
// origin: 'provider' mounts from the allowlist re-check, stamped at exactly
// two TS call sites (onecli.ts's contributionFromArgs,
// container-runner.ts's buildMounts provider-contributed-mounts branch).
// This package's own AllowlistedExtraCheck hook had the identical gap and is
// fixed the identical way below (Spec.Origin, checked before
// AllowlistedExtraCheck runs) -- found by P6-04 deliberately re-running this
// exact scenario (a real OneCLI-shaped mount) through the boundary this
// phase built, per that task's own purpose: catching representative
// extensions the kernel would otherwise silently regress.
package mount

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ---------- ported types (subset of drivers/types.ts needed for validation) ----------

// Class mirrors drivers/types.ts's MountClass.
type Class string

// The four mount classes drivers/types.ts's MountClass enumerates.
const (
	ClassGroupState       Class = "group-state"
	ClassInstallSurface   Class = "install-surface"
	ClassIdentityMaterial Class = "identity-material"
	ClassAllowlistedExtra Class = "allowlisted-extra"
)

// Mode mirrors MountSpec.mode.
type Mode string

// The two mount modes a Spec can request.
const (
	ModeRW Mode = "rw"
	ModeRO Mode = "ro"
)

// Origin mirrors drivers/types.ts's MountSpec.origin (added by
// nanocoai/nanoclaw#3680, commit fdde3b26). "" (the zero value) mirrors an
// operator-configured mount — the pinned baseline's only shape before that
// PR existed — and is never treated differently from OriginOperator.
type Origin string

// The two origins a Spec can carry.
const (
	OriginOperator Origin = "operator"
	OriginProvider Origin = "provider"
)

// Spec mirrors drivers/types.ts's MountSpec.
type Spec struct {
	Class         Class  `json:"class"`
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
	Mode          Mode   `json:"mode"`
	GroupScope    string `json:"groupScope,omitempty"`
	// Origin is set by composition (buildMounts's TS equivalent), never by a
	// provider or an operator config value directly — see mountAllowed's
	// ClassAllowlistedExtra case and PR #3680's own fix for why this
	// distinction exists at all.
	Origin Origin `json:"origin,omitempty"`
}

// Container mirrors the subset of ContainerSpec this package's rules read,
// plus (EC-02, Phase 9) the realization-only fields internal/kernel's
// dockerExecutor.Wake needs to build a real `docker create` argv:
// Image/Command/Args/Labels. ValidateSpec/mountAllowed never read these —
// they ride the same struct only because CapabilityRequestPayload already
// carries *mount.Session as its wake spec, and splitting them into a second
// payload type would duplicate the whole Session/Container shape for no
// validation benefit.
type Container struct {
	Role           string            `json:"role"`
	Env            map[string]string `json:"env,omitempty"`
	ContributedEnv map[string]string `json:"contributedEnv,omitempty"`
	Mounts         []Spec            `json:"mounts,omitempty"`

	// Image is the resolved container image tag (ContainerSpec.image,
	// types.ts:62). Realization-only — never validated by this package.
	Image string `json:"image,omitempty"`
	// Command is PID 1 and its Docker --entrypoint split (ContainerSpec.command,
	// types.ts:84). Realization-only.
	Command []string `json:"command,omitempty"`
	// Args follow the entrypoint (ContainerSpec.args, types.ts:85).
	// Realization-only.
	Args []string `json:"args,omitempty"`
	// Labels are stamped onto the realized container in addition to the
	// canonical key labels (ContainerSpec.labels, types.ts:88).
	// Realization-only.
	Labels map[string]string `json:"labels,omitempty"`
}

// SessionKey mirrors drivers/types.ts's SessionKey.
type SessionKey struct {
	InstallSlug  string `json:"installSlug"`
	AgentGroupID string `json:"agentGroupId"`
	SessionID    string `json:"sessionId"`
}

// Session mirrors the subset of SessionSpec this package's rules read, plus
// (EC-02, Phase 9) StopGraceSeconds — a realization-only field
// (SessionSpec.stopGraceSeconds, types.ts:142) ValidateSpec never reads,
// recorded by the kernel at wake time so a later kill can read the real
// grace period from its own registry rather than trusting a caller-supplied
// value at kill time (see lifecycle.Runtime.StopGraceSeconds).
type Session struct {
	Key              SessionKey        `json:"key"`
	Labels           map[string]string `json:"labels,omitempty"`
	Containers       []Container       `json:"containers,omitempty"`
	RuntimeTier      string            `json:"runtimeTier"`
	StopGraceSeconds int               `json:"stopGraceSeconds,omitempty"`
}

// Capabilities mirrors the subset of DriverCapabilities validateSpec reads.
type Capabilities struct {
	IsolationTiers []string `json:"isolationTiers,omitempty"`
}

// GroupFolderLabel mirrors GROUP_FOLDER_LABEL (types.ts:342).
const GroupFolderLabel = "nanoclaw-group-folder"

// Policy mirrors drivers/types.ts's MountPolicy, plus the two deliberate Go
// additions described in the package doc comment.
type Policy struct {
	GroupsRoot    string
	DataRoot      string
	SurfaceRoots  []string
	MaterialsRoot string

	// AllowlistedExtraCheck, when set, re-checks an 'allowlisted-extra'
	// mount's host path independently rather than trusting the class label
	// (see the package doc comment). nil reproduces the pinned baseline.
	AllowlistedExtraCheck func(hostPath string) (allowed bool, reason string)

	// ResolveSymlinks, when true, additionally resolves each mount's real
	// filesystem path (filepath.EvalSymlinks) and confirms the RESOLVED path
	// is still under the root its class requires. Best-effort: a hostPath
	// that does not exist on this machine at validation time is not an error
	// here (composition-time validation can run before a path is created;
	// the driver's own assertMountSourcesExist — container-runner.ts/
	// docker-driver.ts's equivalent — is the last-line check against a
	// missing source. This package only ever narrows an escape, never widens
	// one). Off by default: it requires real filesystem access and changes
	// nothing about which specs a network-isolated unit test can exercise.
	ResolveSymlinks bool
}

// ---------- validateSpec (types.ts:411-494) ----------

// ValidationError mirrors the deniedByPolicy/specInvalid distinction
// types.ts's error constructors make (types.ts:378-392) — callers that care
// which of the two occurred can type-assert; everyone else just sees Error().
type ValidationError struct {
	Kind   string // "spec-invalid" | "denied-by-policy"
	Detail string
}

func (e *ValidationError) Error() string { return fmt.Sprintf("%s: %s", e.Kind, e.Detail) }

func specInvalid(format string, args ...any) error {
	return &ValidationError{Kind: "spec-invalid", Detail: fmt.Sprintf(format, args...)}
}

func deniedByPolicy(format string, args ...any) error {
	return &ValidationError{Kind: "denied-by-policy", Detail: fmt.Sprintf(format, args...)}
}

// ValidateSpec ports validateSpec verbatim (types.ts:411-494), evaluated in
// the same order the TS source checks it, plus the two additions documented
// on Policy. nil capabilities mirrors the two-argument TS call form: the
// tier check falls back to the floor every realization ships, ['container'].
func ValidateSpec(spec Session, policy Policy, capabilities *Capabilities) error {
	tiers := []string{"container"}
	if capabilities != nil && len(capabilities.IsolationTiers) > 0 {
		tiers = capabilities.IsolationTiers
	}
	if !contains(tiers, spec.RuntimeTier) {
		return specInvalid("runtimeTier '%s' not in driver isolation tiers [%s]", spec.RuntimeTier, strings.Join(tiers, ", "))
	}

	agentCount := 0
	for _, c := range spec.Containers {
		if c.Role == "agent" {
			agentCount++
		}
	}
	if agentCount != 1 {
		return specInvalid("spec must carry exactly one agent container")
	}

	pluginsRoot := StampedPluginsRoot(spec, policy)

	for _, container := range spec.Containers {
		seenTargets := make(map[string]bool)
		for _, m := range container.Mounts {
			if !hostPathCanonical(m.HostPath) {
				return deniedByPolicy("mount %s must be a canonical absolute path (no '..', '.', '//', or trailing '/')", m.HostPath)
			}
			if seenTargets[m.ContainerPath] {
				return specInvalid("duplicate containerPath %s on %s", m.ContainerPath, container.Role)
			}
			seenTargets[m.ContainerPath] = true

			required := ClassRequiredByPath(m.HostPath, policy)
			if required == "" && pluginsRoot != "" && underRoot(m.HostPath, pluginsRoot) {
				required = ClassInstallSurface
			}
			if required != "" && m.Class != required {
				return deniedByPolicy("mount %s must be classed %s, not %s", m.HostPath, required, m.Class)
			}

			if m.Class == ClassInstallSurface && m.Mode != ModeRO {
				return deniedByPolicy("install-surface mount %s must be ro", m.HostPath)
			}
			if m.Class == ClassIdentityMaterial && (m.Mode != ModeRO || container.Role == "agent") {
				return deniedByPolicy("identity-material mount %s invalid on role %s", m.HostPath, container.Role)
			}

			allowed, reason := mountAllowed(m, spec, policy)
			if !allowed {
				if reason == "" {
					reason = fmt.Sprintf("mount %s violates class %s scope %s", m.HostPath, m.Class, m.GroupScope)
				}
				return deniedByPolicy("%s", reason)
			}

			if policy.ResolveSymlinks {
				if err := checkSymlinkEscape(m, required, policy); err != nil {
					return err
				}
			}
		}

		for key, value := range container.Env {
			if IsSecretShaped(key, value) {
				return deniedByPolicy("secret-shaped env '%s' on %s", key, container.Role)
			}
		}
		for key, value := range container.ContributedEnv {
			if LooksLikeCredential(value) {
				return deniedByPolicy("credential value in contributed env '%s' on %s", key, container.Role)
			}
		}
	}
	return nil
}

// hostPathCanonical ports types.ts:501-505 verbatim.
func hostPathCanonical(hostPath string) bool {
	if !strings.HasPrefix(hostPath, "/") {
		return false
	}
	segments := strings.Split(hostPath, "/")[1:]
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// checkSymlinkEscape is the Go-only addition (see package doc comment,
// item 1). It resolves the mount's real path via the filesystem and confirms
// the resolved path is still under the same root the class check above
// already required — so a symlink planted inside an otherwise-legal
// directory cannot point the runtime's actual bind target somewhere the
// lexical check never saw. Best-effort: a path that does not exist yet is
// skipped, not denied (see the ResolveSymlinks doc comment on Policy).
func checkSymlinkEscape(m Spec, requiredClass Class, policy Policy) error {
	resolved, err := filepath.EvalSymlinks(m.HostPath)
	if err != nil {
		return nil // does not exist yet — not this check's job (see doc comment)
	}
	root := rootForClass(m.Class, m, policy)
	if root == "" {
		return nil // classes with no single fixed root (group-state's dual roots) are re-checked via mountAllowed's own scope logic, not here
	}
	// Resolve the root through the identical filesystem lens as the mount
	// path before comparing. This matters on platforms where a directory a
	// caller treats as a fixed root is itself reached through a symlink
	// outside anyone's control (macOS: /var/folders/... -> /private/var/
	// folders/...) — resolving only the mount path and comparing it against
	// an unresolved root would flag every legitimate path under such a root
	// as an "escape," which is not what this check exists to catch. A root
	// that does not exist on this machine falls back to its lexical form
	// (best-effort, matching the doc comment on Policy.ResolveSymlinks).
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		resolvedRoot = root
	}
	if !underRoot(resolved, resolvedRoot) {
		return deniedByPolicy("mount %s resolves (via symlink) to %s, which escapes the %s root %s", m.HostPath, resolved, m.Class, root)
	}
	return nil
}

func rootForClass(class Class, m Spec, policy Policy) string {
	switch class {
	case ClassIdentityMaterial:
		return policy.MaterialsRoot
	case ClassInstallSurface:
		// Multiple candidate roots; a resolved path need only be under ONE.
		// Handled specially: return "" here and let the caller's underRoot
		// check against surfaceRoots directly.
		for _, root := range policy.SurfaceRoots {
			if underRoot(m.HostPath, root) {
				return root
			}
		}
		return ""
	default:
		return ""
	}
}

// mountAllowed ports types.ts:604-634 verbatim, plus the AllowlistedExtraCheck
// hook (item 2 in the package doc comment). Returns a reason string on denial
// so callers preserve deny-reason text end to end (the Opus review's item 5c:
// TS's validateMount returns {allowed, reason}; a bare bool would make every
// false positive unexplainable).
func mountAllowed(m Spec, spec Session, policy Policy) (bool, string) {
	switch m.Class {
	case ClassAllowlistedExtra:
		// PR #3680's fix, ported: a provider-contributed mount (OneCLI's own
		// CA-cert/credential-stub files, a model-provider container config's
		// own volumes) was never operator-configured, so it was never going
		// to appear in an operator-facing allowlist. Checked before
		// AllowlistedExtraCheck runs, exactly mirroring the TS fix's order —
		// see this package's doc comment for the full history.
		if m.Origin == OriginProvider {
			return true, ""
		}
		if policy.AllowlistedExtraCheck != nil {
			return policy.AllowlistedExtraCheck(m.HostPath)
		}
		// Vetted upstream by the mount-allowlist feature (unconditional trust —
		// the pinned baseline's own documented gap; see the package doc comment).
		return true, ""
	case ClassInstallSurface:
		for _, root := range policy.SurfaceRoots {
			if underRoot(m.HostPath, root) {
				return true, ""
			}
		}
		pluginsRoot := StampedPluginsRoot(spec, policy)
		if pluginsRoot != "" && underRoot(m.HostPath, pluginsRoot) {
			return true, ""
		}
		return false, ""
	case ClassIdentityMaterial:
		return underRoot(m.HostPath, policy.MaterialsRoot), ""
	case ClassGroupState:
		if m.GroupScope != spec.Key.AgentGroupID {
			return false, ""
		}
		if underRoot(m.HostPath, filepath.Join(policy.DataRoot, "v2-sessions", m.GroupScope)) {
			return true, ""
		}
		if underRoot(m.HostPath, policy.GroupsRoot) {
			folder, ok := spec.Labels[GroupFolderLabel]
			if !ok || !LabelValueLegal(folder) {
				return false, ""
			}
			return underRoot(m.HostPath, filepath.Join(policy.GroupsRoot, folder)), ""
		}
		return false, ""
	default:
		return false, ""
	}
}

func underRoot(hostPath, root string) bool {
	return hostPath == root || strings.HasPrefix(hostPath, root+"/")
}

// ClassRequiredByPath ports types.ts:565-569 verbatim.
func ClassRequiredByPath(hostPath string, policy Policy) Class {
	if underRoot(hostPath, policy.MaterialsRoot) {
		return ClassIdentityMaterial
	}
	for _, root := range policy.SurfaceRoots {
		if underRoot(hostPath, root) {
			return ClassInstallSurface
		}
	}
	return ""
}

// StampedPluginsRoot ports types.ts:598-602 verbatim.
func StampedPluginsRoot(spec Session, policy Policy) string {
	folder, ok := spec.Labels[GroupFolderLabel]
	if !ok || !LabelValueLegal(folder) {
		return ""
	}
	return filepath.Join(policy.GroupsRoot, folder, "plugins")
}

// labelValueRe is the character class LabelValueLegal checks against
// (<=63 bytes, [A-Za-z0-9._-], alphanumeric at both ends; empty is legal).
var labelValueRe = regexp.MustCompile(`^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$`)

// LabelValueLegal ports types.ts:356-358 verbatim.
func LabelValueLegal(value string) bool {
	return len(value) <= 63 && labelValueRe.MatchString(value)
}

// ---------- secret/credential checks (types.ts:526-553) ----------

var (
	pathValueRe = regexp.MustCompile(`^/[^\s]*$`)
	secretKeyRe = regexp.MustCompile(`(?i)(_KEY|_TOKEN|_SECRET|PASSWORD)$`)
	credSkRe    = regexp.MustCompile(`^sk-[A-Za-z0-9_-]{20,}$`)
	credGhRe    = regexp.MustCompile(`^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$`)
	credGhPatRe = regexp.MustCompile(`^github_pat_[A-Za-z0-9_]{20,}$`)
	credSlackRe = regexp.MustCompile(`^xox[baprs]-[A-Za-z0-9-]{10,}$`)
	credAwsRe   = regexp.MustCompile(`^AKIA[0-9A-Z]{16}$`)
	credJwtRe   = regexp.MustCompile(`^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)
	credPemRe   = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)
)

// IsSecretShaped ports types.ts:526-530 verbatim.
func IsSecretShaped(key, value string) bool {
	if pathValueRe.MatchString(value) {
		return false
	}
	return secretKeyRe.MatchString(key) || LooksLikeCredential(value)
}

// LooksLikeCredential ports types.ts:543-553 verbatim.
func LooksLikeCredential(value string) bool {
	return credSkRe.MatchString(value) ||
		credGhRe.MatchString(value) ||
		credGhPatRe.MatchString(value) ||
		credSlackRe.MatchString(value) ||
		credAwsRe.MatchString(value) ||
		credJwtRe.MatchString(value) ||
		credPemRe.MatchString(value)
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// ---------- CheckAllowlistedExtra: the PR #3680 port (item 2) ----------

// Allowlist mirrors src/modules/mount-security/index.ts's MountAllowlist.
type Allowlist struct {
	AllowedRoots    []AllowedRoot `json:"allowedRoots"`
	BlockedPatterns []string      `json:"blockedPatterns"`
}

// AllowedRoot mirrors mount-security/index.ts's AllowedRoot.
type AllowedRoot struct {
	Path           string `json:"path"`
	AllowReadWrite bool   `json:"allowReadWrite"`
	Description    string `json:"description,omitempty"`
}

// defaultBlockedPatterns ports mount-security/index.ts:55-84 verbatim.
var defaultBlockedPatterns = []string{
	".ssh", ".gnupg", ".gpg", ".aws", ".azure", ".gcloud", ".kube", ".docker",
	".config/nanoclaw", ".local/bin", "credentials", ".env", ".netrc",
	".npmrc", ".pypirc", "id_rsa", "id_ed25519", "private_key", ".secret",
}

// LoadAllowlist ports loadMountAllowlist's JSON-parsing half (index.ts:123-192)
// — no mtime cache (this package validates once per spawn, not per web
// request; a caller wanting the cache behavior wraps this itself).
func LoadAllowlist(path string) (*Allowlist, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw Allowlist
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("mount allowlist %s: %w", path, err)
	}
	merged := map[string]bool{}
	for _, p := range defaultBlockedPatterns {
		merged[p] = true
	}
	for _, p := range raw.BlockedPatterns {
		merged[p] = true
	}
	patterns := make([]string, 0, len(merged))
	for p := range merged {
		patterns = append(patterns, p)
	}
	return &Allowlist{AllowedRoots: raw.AllowedRoots, BlockedPatterns: patterns}, nil
}

// CheckAllowlistedExtra ports isHostPathAllowlisted / validateMount's
// blocked-pattern-then-allowed-root logic (mount-security/index.ts:230-271,
// 312-363), for use as a Policy.AllowlistedExtraCheck. allowlistPath is the
// operator's mount-allowlist.json (MOUNT_ALLOWLIST_PATH in config.ts); a
// missing or unparseable file fails closed — "no allowlist, block all",
// exactly like the TS original's own documented default (index.ts:124,316).
//
// IMPORTANT (see the package and ADR-004 doc comments): this checks the
// mount's host path against the OPERATOR's allowlist. It has no notion of
// mount origin, so wiring it as every allowlisted-extra mount's check —
// exactly what the shipped-but-unmerged PR #3680 does — also subjects
// gateway-provider-contributed mounts (OneCLI's CA cert / credential-stub
// files) to the same operator-facing file. Confirm the provider's stub
// directory is a listed allowedRoot, or exempt provider mounts explicitly,
// before wiring this in production. See docs/ADR-004-p5-02-mount-hardening.md.
func CheckAllowlistedExtra(hostPath string, allowlistPath string) (bool, string) {
	allowlist, err := LoadAllowlist(allowlistPath)
	if err != nil {
		return false, fmt.Sprintf("no mount allowlist configured at %s", allowlistPath)
	}
	realPath, err := filepath.EvalSymlinks(hostPath)
	if err != nil {
		// hostPathCanonical already rejected non-canonical forms; a canonical
		// path that still doesn't resolve simply doesn't exist yet.
		realPath = hostPath
	}
	if pattern := matchesBlockedPattern(realPath, allowlist.BlockedPatterns); pattern != "" {
		return false, fmt.Sprintf("path matches blocked pattern %q: %s", pattern, realPath)
	}
	for _, root := range allowlist.AllowedRoots {
		realRoot, err := filepath.EvalSymlinks(expandHome(root.Path))
		if err != nil {
			continue // allowed root does not exist, skip it (index.ts:258-261)
		}
		if underRoot(realPath, realRoot) {
			return true, fmt.Sprintf("allowed under root %q", root.Path)
		}
	}
	return false, fmt.Sprintf("path %q is not under any allowed root", realPath)
}

// matchesBlockedPattern ports mount-security/index.ts:230-248 verbatim
// (substring match per path component and against the whole path).
func matchesBlockedPattern(realPath string, patterns []string) string {
	parts := strings.Split(realPath, string(filepath.Separator))
	for _, pattern := range patterns {
		for _, part := range parts {
			if part == pattern || strings.Contains(part, pattern) {
				return pattern
			}
		}
		if strings.Contains(realPath, pattern) {
			return pattern
		}
	}
	return ""
}

func expandHome(p string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}
