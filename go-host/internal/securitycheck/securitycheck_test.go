package securitycheck

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

func writeAllowlist(t *testing.T, json string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mount-allowlist.json")
	if err := os.WriteFile(path, []byte(json), 0o600); err != nil {
		t.Fatalf("writing allowlist: %v", err)
	}
	return path
}

func intp(v int) *int { return &v }

func TestCheckPrivilege_SkippedWhenNotConfigured(t *testing.T) {
	r := checkPrivilege(Options{})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass (skipped)", r.Level)
	}
}

func TestCheckPrivilege_RejectsRoot(t *testing.T) {
	r := checkPrivilege(Options{RunAs: &containerdefaults.RunAs{UID: 0, GID: 0, Set: true}})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
	if r.Remediation == "" {
		t.Fatal("Remediation must not be empty on failure")
	}
}

func TestCheckPrivilege_AllowsNonRoot(t *testing.T) {
	r := checkPrivilege(Options{RunAs: &containerdefaults.RunAs{UID: 1000, GID: 1000, Set: true}})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

// TestCheckDangerousMounts_NotConfigured_Warns pins ADR-018's own follow-up:
// no -allowlist configured is itself the confirmed, live-verified gap (any
// allowlisted-extra mount, including the Docker socket, is unconditionally
// trusted with no independent check) — this must surface as LevelWarn, not
// silently as LevelPass ("nothing to check"), so it's visible to an operator
// running security-check/doctor without their already knowing to look for
// it. Was TestCheckDangerousMounts_SkippedWhenNotConfigured before ADR-018.
func TestCheckDangerousMounts_NotConfigured_Warns(t *testing.T) {
	r := checkDangerousMounts(Options{})
	if r.Level != LevelWarn {
		t.Fatalf("Level = %q, want warn (see ADR-018)", r.Level)
	}
	if r.Remediation == "" {
		t.Fatal("Remediation must not be empty on a warn")
	}
}

func TestCheckDangerousMounts_FlagsRootPath(t *testing.T) {
	path := writeAllowlist(t, `{"allowedRoots":[{"path":"/","allowReadWrite":true}]}`)
	r := checkDangerousMounts(Options{AllowlistPath: path})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckDangerousMounts_FlagsDockerSocketCoverage(t *testing.T) {
	path := writeAllowlist(t, `{"allowedRoots":[{"path":"/var/run","allowReadWrite":true}]}`)
	r := checkDangerousMounts(Options{AllowlistPath: path})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckDangerousMounts_PassesNarrowRoot(t *testing.T) {
	path := writeAllowlist(t, `{"allowedRoots":[{"path":"/data/groups/my-group","allowReadWrite":false}]}`)
	r := checkDangerousMounts(Options{AllowlistPath: path})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass: %+v", r.Level, r)
	}
}

func TestCheckDangerousMounts_MissingFileFails(t *testing.T) {
	r := checkDangerousMounts(Options{AllowlistPath: "/no/such/file.json"})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckDockerSocket_SkippedWhenNotConfigured(t *testing.T) {
	r := checkDockerSocket(Options{})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass (skipped)", r.Level)
	}
}

func TestCheckDockerSocket_FlagsDirectMount(t *testing.T) {
	r := checkDockerSocket(Options{SampleMounts: []mount.Spec{{HostPath: "/var/run/docker.sock"}}})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckDockerSocket_PassesOrdinaryMount(t *testing.T) {
	r := checkDockerSocket(Options{SampleMounts: []mount.Spec{{HostPath: "/data/groups/g1"}}})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

func TestCheckCredentialExposure_SkippedWhenNotConfigured(t *testing.T) {
	r := checkCredentialExposure(Options{})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass (skipped)", r.Level)
	}
}

func TestCheckCredentialExposure_FlagsSecretShapedKey(t *testing.T) {
	r := checkCredentialExposure(Options{EnvSnapshot: map[string]string{"API_SECRET_KEY": "sk-abcdef1234567890"}})
	if r.Level != LevelWarn {
		t.Fatalf("Level = %q, want warn", r.Level)
	}
}

func TestCheckCredentialExposure_PassesOrdinaryEnv(t *testing.T) {
	r := checkCredentialExposure(Options{EnvSnapshot: map[string]string{"LANG": "en_US.UTF-8"}})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

func TestCheckRuntimeRestrictions_SkippedWhenNotConfigured(t *testing.T) {
	r := checkRuntimeRestrictions(Options{})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass (skipped)", r.Level)
	}
}

func TestCheckRuntimeRestrictions_FailsUnsafeDefaults(t *testing.T) {
	r := checkRuntimeRestrictions(Options{
		RunAs:     &containerdefaults.RunAs{UID: 0, GID: 0, Set: true},
		Resources: &containerdefaults.Resources{},
	})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckRuntimeRestrictions_PassesSafeDefaults(t *testing.T) {
	r := checkRuntimeRestrictions(Options{
		RunAs:     &containerdefaults.RunAs{UID: 1000, GID: 1000, Set: true},
		Resources: &containerdefaults.Resources{PidsLimit: intp(256)},
	})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass: %+v", r.Level, r)
	}
}

func TestRunAll_ReturnsAllFiveNamedChecks(t *testing.T) {
	results := RunAll(Options{})
	if len(results) != 5 {
		t.Fatalf("len(results) = %d, want 5", len(results))
	}
	for _, r := range results {
		// "dangerous mounts (allowlist)" is the one deliberate exception:
		// with no AllowlistPath at all, ADR-018 says this must warn, not
		// silently pass — see TestCheckDangerousMounts_NotConfigured_Warns.
		// Every other check has nothing to report on with fully empty
		// Options and should still report LevelPass.
		if r.Name == "dangerous mounts (allowlist)" {
			if r.Level != LevelWarn {
				t.Fatalf("expected %q to warn when unconfigured (ADR-018), got %+v", r.Name, r)
			}
			continue
		}
		if r.Level != LevelPass {
			t.Fatalf("expected every other skipped check to report pass, got %+v", r)
		}
	}
}
