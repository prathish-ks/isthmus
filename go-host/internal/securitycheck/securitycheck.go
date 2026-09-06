// Package securitycheck implements P7-04 (Phase 7 — UX & Operations):
// `nanogo security-check`, a read-only inspection of the invariants
// Phase 5's kernel packages (mount, containerdefaults, credential) already
// enforce at request time. This package never changes anything it inspects
// — per the task's own instruction, "it must not silently change the
// system" — it only reports pass/warn/fail with remediation, reusing
// internal/doctor's Level/Result shape rather than inventing a second,
// identical one (LAW-05: no unjustified duplicate surface).
//
// Deliberately narrow, matching Phase 5's own scope: these checks inspect
// configuration/policy an operator controls (a mount-allowlist file,
// configured RunAs/Resources defaults, an optional env snapshot) — they do
// not reach into a live container or the real Docker daemon, which is
// internal/doctor's job (container runtime/image checks), not this one's.
package securitycheck

import (
	"strings"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/doctor"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

type (
	// Level is internal/doctor's Level type, re-exported here so callers
	// of this package don't also need to import doctor just to name it.
	Level = doctor.Level
	// Result is internal/doctor's Result type, re-exported for the same
	// reason as Level above.
	Result = doctor.Result
)

const (
	// LevelPass is internal/doctor's LevelPass value, re-exported for the
	// same reason as the Level type above.
	LevelPass = doctor.LevelPass
	// LevelWarn is internal/doctor's LevelWarn value, re-exported for the
	// same reason as the Level type above.
	LevelWarn = doctor.LevelWarn
	// LevelFail is internal/doctor's LevelFail value, re-exported for the
	// same reason as the Level type above.
	LevelFail = doctor.LevelFail
)

// dockerSocketPaths are the well-known Docker/Podman socket locations no
// agent-container mount should ever target — the single most direct route
// to full host compromise this project's threat model names.
var dockerSocketPaths = []string{
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/var/run/podman.sock",
}

// dangerousRoots flags an allowlisted root that is suspiciously broad
// (the whole filesystem, or a well-known system directory) rather than a
// project- or group-scoped path — a config mistake this check exists to
// catch before an operator ships it, not a claim that mount.ValidateSpec
// itself would necessarily allow reaching one (CheckAllowlistedExtra's own
// blocked-pattern list is the enforcement; this is an earlier, human-facing
// sanity pass over the config file itself).
var dangerousRoots = []string{"/", "/etc", "/root", "/home", "/var", "/usr", "/bin", "/sbin", "/boot"}

// Options configures RunAll. Every field is optional — a check whose input
// wasn't supplied reports LevelPass with a Detail explaining it was
// skipped, the same "always account for every named check" discipline
// internal/doctor uses.
type Options struct {
	// AllowlistPath, if set, is loaded via mount.LoadAllowlist and scanned
	// for dangerous roots and Docker-socket entries.
	AllowlistPath string

	// SampleMounts, if set, are checked directly for a Docker-socket
	// HostPath — e.g. the mounts a real composed Session is about to use.
	SampleMounts []mount.Spec

	// EnvSnapshot, if set, is scanned for secret-shaped keys/values via
	// mount.IsSecretShaped/LooksLikeCredential. Callers decide what's safe
	// to hand in; this package never reads os.Environ() itself.
	EnvSnapshot map[string]string

	// RunAs/Resources, if set, are validated against containerdefaults'
	// invariants — the same checks internal/kernel's handleWake runs, but
	// inspectable ahead of time rather than only at wake.
	RunAs     *containerdefaults.RunAs
	Resources *containerdefaults.Resources
}

// RunAll runs every named invariant check and returns all Results in a
// fixed order.
func RunAll(opts Options) []Result {
	return []Result{
		checkPrivilege(opts),
		checkDangerousMounts(opts),
		checkDockerSocket(opts),
		checkCredentialExposure(opts),
		checkRuntimeRestrictions(opts),
	}
}

func checkPrivilege(opts Options) Result {
	const name = "user / privilege"
	if opts.RunAs == nil {
		return Result{Name: name, Level: LevelPass, Detail: "no RunAs configured to check (pass one via Options to enable)"}
	}
	if err := containerdefaults.ValidateRunAs(*opts.RunAs); err != nil {
		return Result{Name: name, Level: LevelFail,
			Detail:      "configured RunAs would run the agent container as root: " + err.Error(),
			Remediation: "set a non-root uid/gid in RunAs — see containerdefaults.ValidateRunAs"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "configured RunAs is non-root"}
}

func checkDangerousMounts(opts Options) Result {
	const name = "dangerous mounts (allowlist)"
	if opts.AllowlistPath == "" {
		// EC-05/ADR-018 (go-host/docs/ADR-018-p9-ec05-adversarial-pass-findings.md):
		// confirmed live, against a real Docker daemon, that with no
		// -allowlist configured, mount.mountAllowed's ClassAllowlistedExtra
		// case unconditionally trusts ANY host path a caller labels
		// allowlisted-extra — including the Docker socket. This branch used
		// to report LevelPass ("nothing to check"), which silently agreed
		// with that gap instead of surfacing it. LevelWarn makes the actual
		// default posture visible to anyone running security-check/doctor,
		// not only to someone who has already read ADR-018 or mount.go's own
		// comments.
		return Result{Name: name, Level: LevelWarn,
			Detail:      "no mount-allowlist configured — every 'allowlisted-extra' mount (e.g. a Docker-socket or credential-directory bind mount) is unconditionally trusted with no independent check (see ADR-018)",
			Remediation: "pass -allowlist <path-to-mount-allowlist.json> to nanogo serve/security-check to enable mount.CheckAllowlistedExtra"}
	}
	allow, err := mount.LoadAllowlist(opts.AllowlistPath)
	if err != nil {
		return Result{Name: name, Level: LevelFail,
			Detail:      "could not load mount-allowlist at " + opts.AllowlistPath + ": " + err.Error(),
			Remediation: "check the file exists and is valid JSON matching mount.Allowlist's shape"}
	}
	var flagged []string
	for _, root := range allow.AllowedRoots {
		p := strings.TrimRight(root.Path, "/")
		if p == "" {
			p = "/"
		}
		for _, bad := range dangerousRoots {
			if p == bad {
				flagged = append(flagged, root.Path)
			}
		}
		for _, sock := range dockerSocketPaths {
			if p == sock || strings.HasPrefix(sock, p+"/") {
				flagged = append(flagged, root.Path+" (covers a Docker/Podman socket path)")
			}
		}
	}
	if len(flagged) > 0 {
		return Result{Name: name, Level: LevelFail,
			Detail:      "mount-allowlist contains suspiciously broad or socket-covering root(s): " + strings.Join(flagged, "; "),
			Remediation: "narrow these allowlist entries to the specific project/group directories they're meant to cover"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "no dangerously broad roots found in the allowlist"}
}

func checkDockerSocket(opts Options) Result {
	const name = "docker socket exposure"
	if len(opts.SampleMounts) == 0 {
		return Result{Name: name, Level: LevelPass, Detail: "no sample mounts configured to check (pass SampleMounts to enable)"}
	}
	for _, m := range opts.SampleMounts {
		for _, sock := range dockerSocketPaths {
			if m.HostPath == sock {
				return Result{Name: name, Level: LevelFail,
					Detail:      "a configured mount targets " + sock + " directly",
					Remediation: "remove this mount — an agent container must never be able to reach the Docker/Podman socket (see docs/threat-model.md)"}
			}
		}
	}
	return Result{Name: name, Level: LevelPass, Detail: "no sample mount targets a Docker/Podman socket"}
}

func checkCredentialExposure(opts Options) Result {
	const name = "credential exposure indicators"
	if len(opts.EnvSnapshot) == 0 {
		return Result{Name: name, Level: LevelPass, Detail: "no env snapshot configured to check (pass EnvSnapshot to enable)"}
	}
	var flagged []string
	for k, v := range opts.EnvSnapshot {
		if mount.IsSecretShaped(k, v) || mount.LooksLikeCredential(v) {
			flagged = append(flagged, k)
		}
	}
	if len(flagged) > 0 {
		return Result{Name: name, Level: LevelWarn,
			Detail:      "env keys that look secret-shaped: " + strings.Join(flagged, ", "),
			Remediation: "credential values should ride by reference (a mounted file) per internal/credential, never by env value — verify these are placeholders the proxy overwrites, not live secrets"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "no secret-shaped env entries found in the supplied snapshot"}
}

func checkRuntimeRestrictions(opts Options) Result {
	const name = "runtime restrictions"
	if opts.RunAs == nil && opts.Resources == nil {
		return Result{Name: name, Level: LevelPass, Detail: "no RunAs/Resources configured to check"}
	}
	runAs := containerdefaults.RunAs{}
	if opts.RunAs != nil {
		runAs = *opts.RunAs
	}
	resources := containerdefaults.Resources{}
	if opts.Resources != nil {
		resources = *opts.Resources
	}
	if err := containerdefaults.EnforceSafeDefaults(runAs, resources); err != nil {
		return Result{Name: name, Level: LevelFail,
			Detail:      "configured defaults fail EnforceSafeDefaults: " + err.Error(),
			Remediation: "fix the reported RunAs/Resources field — EnforceSafeDefaults never allows a request through with it unset or unsafe"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "configured RunAs/Resources satisfy EnforceSafeDefaults"}
}
