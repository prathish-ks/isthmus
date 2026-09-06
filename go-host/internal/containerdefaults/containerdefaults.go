// Package containerdefaults ports and hardens src/drivers/docker-driver.ts's
// argv-assembly helpers (P5-03, Phase 5 — Security Kernel): hardeningArgs,
// userArgs, resourceArgs (docker-driver.ts:619-657).
//
// Scope, per the threat-model-addendum-p5.md §2 finding this task closes:
// hardeningArgs (cap-drop=ALL, no-new-privileges, --init) is ALREADY
// unconditional in the TS source — every session gets it, with no spec field
// that can turn it off. There is nothing to "enforce" there beyond keeping it
// that way in Go, which this package does by never exposing a way to
// suppress it. userArgs, in contrast, is exactly `spec.runAs ? ['--user',
// uid:gid] : []` with NO check that uid/gid aren't 0 — SessionSpec.runAs's
// own doc comment (types.ts:134-140) states it exists because "the identity
// that must read 0600 material has to be explicit," but nothing validates
// that identity is non-root. That is this package's real addition:
// ValidateRunAs rejects uid==0 or gid==0, closing the addendum's testable
// invariant ("validateSpec... rejects any SessionSpec whose runAs.uid/gid is
// 0"). resourceArgs is already correct where it matters (docker-driver.ts's
// own comment: "Test >0, not truthiness: cgroups v2 rejects `--pids-limit 0`
// with EINVAL") — ValidateResources ports that same >0 rule as an upfront
// rejection instead of a silent argv omission, per this task's instruction
// to "reject unsafe requested settings rather than silently accepting them."
//
// Deliberately NOT done here, to avoid weakening upstream compatibility (the
// task's own explicit constraint): no mandatory memory/cpu ceiling is
// introduced. docker-driver.ts's own comment is explicit that an operator who
// never opts into a cap gets none today, and a Go-side default cap would
// silently OOM-kill workloads that run fine now — exactly the regression
// resourceArgs's own comment warns against. This package only rejects
// explicitly-unsafe VALUES (root identity, a non-positive pids limit); it
// never invents a limit nobody asked for.
package containerdefaults

import "fmt"

// RunAs mirrors SessionSpec.runAs (types.ts:134-140). Set distinguishes
// "omitted" (Docker gets no --user flag, the image's own default applies —
// docker-driver.ts's userArgs) from "explicitly 0:0" (root), since both
// shapes reach this package as zero values otherwise.
type RunAs struct {
	UID int  `json:"uid"`
	GID int  `json:"gid"`
	Set bool `json:"set"`
}

// Resources mirrors the subset of SessionResources (types.ts:97-115) this
// package validates. A nil pointer means "not specified" — undefined stays
// unbounded on the TS side (resourceArgs's own comment), which this package
// preserves exactly: an unspecified field is never rejected.
type Resources struct {
	MemoryMB  *int    `json:"memoryMB,omitempty"`
	PidsLimit *int    `json:"pidsLimit,omitempty"`
	ShmSizeMB *int    `json:"shmSizeMB,omitempty"`
	CPUs      *string `json:"cpus,omitempty"`
}

// HardeningPosture is the fixed, non-configurable argv every session gets —
// ported verbatim from hardeningArgs (docker-driver.ts:630-638), minus the
// caller-supplied pids-limit flag (see BuildPidsLimitArg). There is
// deliberately no field anywhere in this package that can suppress any of
// these three flags: that is the point of "already unconditional" staying
// unconditional in the port.
var HardeningPosture = []string{"--cap-drop=ALL", "--security-opt", "no-new-privileges", "--init"}

// ValidateRunAs rejects a root identity. This is P5-03's actual new
// invariant: docker-driver.ts's userArgs (line 655-657) passes spec.runAs
// straight to `--user` with no check at all, so a SessionSpec composed (or
// forged) with runAs {uid: 0, gid: 0} sails through today. A caller that
// never sets RunAs at all (Set=false) is unaffected — that is the "inherit
// the image's own default" path (threat-model-addendum-p5.md §2's own open
// item: docker-driver.ts's actual default was not verified this pass and
// remains a named follow-up, not assumed safe here).
func ValidateRunAs(runAs RunAs) error {
	if !runAs.Set {
		return nil
	}
	if runAs.UID == 0 || runAs.GID == 0 {
		return fmt.Errorf("denied-by-policy: runAs %d:%d is root — agent containers must run as a non-root, non-privileged user", runAs.UID, runAs.GID)
	}
	return nil
}

// UserArgs ports userArgs (docker-driver.ts:655-657) verbatim, but only
// after ValidateRunAs has already rejected root — callers MUST validate
// before building argv, never after.
func UserArgs(runAs RunAs) []string {
	if !runAs.Set {
		return nil
	}
	return []string{"--user", fmt.Sprintf("%d:%d", runAs.UID, runAs.GID)}
}

// ValidateResources ports resourceArgs's own "Test >0, not truthiness"
// invariant (docker-driver.ts:632-635) as an explicit upfront rejection
// rather than a silent argv omission — an operator who sets pidsLimit: 0
// today gets no error and no pids limit at all (the flag is just dropped);
// this package instead tells them why. Every other field stays exactly as
// permissive as TS: nil (unspecified) is never rejected, and a specified
// positive value is never second-guessed against some invented ceiling.
func ValidateResources(r Resources) error {
	if r.PidsLimit != nil && *r.PidsLimit <= 0 {
		return fmt.Errorf("spec-invalid: pidsLimit %d must be > 0 (cgroups v2 rejects --pids-limit 0 with EINVAL; omit the field entirely for unbounded)", *r.PidsLimit)
	}
	if r.MemoryMB != nil && *r.MemoryMB <= 0 {
		return fmt.Errorf("spec-invalid: memoryMb %d must be > 0 (omit the field entirely for unbounded)", *r.MemoryMB)
	}
	if r.ShmSizeMB != nil && *r.ShmSizeMB <= 0 {
		return fmt.Errorf("spec-invalid: shmSizeMb %d must be > 0 (omit the field entirely for the driver's default)", *r.ShmSizeMB)
	}
	return nil
}

// ResourceArgs ports resourceArgs (docker-driver.ts:646-653) verbatim.
// Callers MUST validate first (ValidateResources) — this function assumes
// every set field is already known-positive.
func ResourceArgs(r Resources) []string {
	var args []string
	if r.CPUs != nil {
		args = append(args, "--cpus", *r.CPUs)
	}
	if r.MemoryMB != nil {
		args = append(args, "--memory", fmt.Sprintf("%dm", *r.MemoryMB))
	}
	if r.ShmSizeMB != nil {
		args = append(args, fmt.Sprintf("--shm-size=%dm", *r.ShmSizeMB))
	}
	return args
}

// PidsLimitArg ports hardeningArgs's own conditional pids-limit append
// (docker-driver.ts:633-636) — kept separate from HardeningPosture (which is
// truly unconditional) since this one flag alone is spec-driven.
func PidsLimitArg(r Resources) []string {
	if r.PidsLimit != nil && *r.PidsLimit > 0 {
		return []string{"--pids-limit", fmt.Sprintf("%d", *r.PidsLimit)}
	}
	return nil
}

// EnforceSafeDefaults is the composed entry point P5-03 asks for: "harden Go
// container defaults based on our invariants... reject unsafe requested
// settings rather than silently accepting them." Call this before argv
// assembly (alongside mount.ValidateSpec, at the same seam — see
// docs/ADR-004-p5-02-mount-hardening.md for why the two stay separate
// packages: they port two structurally distinct source files, mount rules
// from types.ts, container defaults from docker-driver.ts).
func EnforceSafeDefaults(runAs RunAs, resources Resources) error {
	if err := ValidateRunAs(runAs); err != nil {
		return err
	}
	return ValidateResources(resources)
}
