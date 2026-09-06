package mount

// P9-02 (Phase 9/10 hardening): fuzz target #1 of 5 — path/mount-spec
// validation. mount.ValidateSpec is, per this package's own doc comment and
// the Phase 5 readiness review, "the single highest-consequence validator in
// the codebase" — it is the literal first line of driver.prepare() in both
// hosts. This fuzzer feeds it structurally-arbitrary Specs (fuzzed class,
// hostPath, containerPath, mode, groupScope, origin strings) against a fixed
// Policy rooted in a temp directory, and asserts two things no malformed
// input should ever produce: a panic, or an ALLOW decision whose hostPath is
// not actually underRoot of one of the policy's own roots (mountAllowed's
// own invariant, re-checked independently here rather than trusted). A
// deny/spec-invalid verdict is always an acceptable outcome for garbage
// input — fail-closed is the whole point; a panic or an escaped ALLOW is
// not.
//
// This complements, rather than replaces, mount_test.go's table-driven
// fixture tests (which pin specific, meaningful scenarios like the P6-04
// OneCLI/PR#3680 finding) — the fuzzer's job is breadth over the input space
// those hand-written cases can't practically enumerate. Seeds include both
// attack-shaped strings (path traversal, absolute escapes, bogus
// class/mode/origin values) AND, added after the temp Policy roots are
// known, genuinely-allowed paths under those live roots — without the
// latter, mountAllowed's raw string-prefix check (m.HostPath == root or
// has-prefix root+"/") makes an ALLOW branch astronomically unlikely to
// reach by mutation alone, since nothing in a blind fuzzer's alphabet knows
// this run's randomly-named temp directory.
import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func FuzzValidateSpec(f *testing.F) {
	attackSeeds := []struct {
		class, hostPath, containerPath, mode, groupScope, origin string
	}{
		{"group-state", "../../../etc/passwd", "/x", "rw", "g1", ""},
		{"install-surface", "/etc/../etc/shadow", "/x", "ro", "", ""},
		{"identity-material", "/etc/shadow", "/creds", "ro", "", ""},
		{"allowlisted-extra", "/tmp/x", "/x", "rw", "", "provider"},
		{"", "", "", "", "", ""},
		{"bogus-class", "/groups/g1/../../escape", "/x", "bogus-mode", "g1", "bogus-origin"},
		{"group-state", "/" + strings.Repeat("a/", 200) + "n", "/x", "rw", "g1", ""},
		{"group-state", "relative/not/canonical", "/x", "rw", "g1", ""},
		{"group-state", "//double/slash", "/x", "rw", "g1", ""},
	}
	for _, s := range attackSeeds {
		f.Add(s.class, s.hostPath, s.containerPath, s.mode, s.groupScope, s.origin)
	}

	tmp, err := os.MkdirTemp("", "mount-fuzz-*")
	if err != nil {
		f.Fatalf("MkdirTemp: %v", err)
	}
	f.Cleanup(func() {
		if err := os.RemoveAll(tmp); err != nil {
			f.Logf("cleanup: RemoveAll(%s): %v", tmp, err)
		}
	})

	groupsRoot := filepath.Join(tmp, "groups")
	dataRoot := filepath.Join(tmp, "data")
	surfaceRoot := filepath.Join(tmp, "surface")
	materialsRoot := filepath.Join(tmp, "materials")
	for _, d := range []string{groupsRoot, dataRoot, surfaceRoot, materialsRoot} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			f.Fatalf("MkdirAll(%s): %v", d, err)
		}
	}
	policy := Policy{
		GroupsRoot:    groupsRoot,
		DataRoot:      dataRoot,
		SurfaceRoots:  []string{surfaceRoot},
		MaterialsRoot: materialsRoot,
	}
	roots := []string{groupsRoot, dataRoot, surfaceRoot, materialsRoot}

	// Live-rooted seeds: genuinely allowed shapes, so the fuzzer's mutations
	// start from real ALLOW territory as well as real DENY territory.
	f.Add("identity-material", materialsRoot+"/id.pem", "/creds", "ro", "", "")
	f.Add("group-state", dataRoot+"/v2-sessions/g1/state.db", "/state", "rw", "g1", "")
	f.Add("install-surface", surfaceRoot+"/plugin.js", "/plugin.js", "ro", "", "")

	f.Fuzz(func(t *testing.T, class, hostPath, containerPath, mode, groupScope, origin string) {
		spec := Session{
			Key:         SessionKey{InstallSlug: "install", AgentGroupID: "g1", SessionID: "s1"},
			RuntimeTier: "container",
			Labels:      map[string]string{GroupFolderLabel: "g1-folder"},
			Containers: []Container{{
				Role: "agent",
				Mounts: []Spec{{
					Class:         Class(class),
					HostPath:      hostPath,
					ContainerPath: containerPath,
					Mode:          Mode(mode),
					GroupScope:    groupScope,
					Origin:        Origin(origin),
				}},
			}},
		}

		// The property under test: ValidateSpec must never panic, on any
		// input — a spec built entirely from attacker-controlled strings is
		// exactly what a compromised or buggy caller could hand it.
		err := ValidateSpec(spec, policy, nil)
		if err != nil {
			return
		}
		// ALLOW was granted. allowlisted-extra is unconditional-trust by
		// design (nil AllowlistedExtraCheck reproduces the pinned baseline's
		// documented gap — see the package doc comment), so it is exempt
		// from the "must be under a policy root" invariant on purpose, not
		// by oversight.
		if class == string(ClassAllowlistedExtra) {
			return
		}
		resolved := filepath.Clean(hostPath)
		for _, root := range roots {
			if resolved == root || strings.HasPrefix(resolved, root+string(filepath.Separator)) {
				return
			}
		}
		t.Fatalf("ValidateSpec ALLOWed hostPath %q (class %q, groupScope %q) which is under none of the policy roots %v",
			hostPath, class, groupScope, roots)
	})
}
