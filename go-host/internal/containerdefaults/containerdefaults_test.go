package containerdefaults

import "testing"

func intp(v int) *int       { return &v }
func strp(v string) *string { return &v }

func TestValidateRunAs_RejectsRootUID(t *testing.T) {
	if err := ValidateRunAs(RunAs{UID: 0, GID: 1000, Set: true}); err == nil {
		t.Fatal("expected uid 0 to be denied")
	}
}

func TestValidateRunAs_RejectsRootGID(t *testing.T) {
	if err := ValidateRunAs(RunAs{UID: 1000, GID: 0, Set: true}); err == nil {
		t.Fatal("expected gid 0 to be denied")
	}
}

func TestValidateRunAs_RejectsFullRoot(t *testing.T) {
	if err := ValidateRunAs(RunAs{UID: 0, GID: 0, Set: true}); err == nil {
		t.Fatal("expected 0:0 to be denied")
	}
}

func TestValidateRunAs_AllowsNonRoot(t *testing.T) {
	if err := ValidateRunAs(RunAs{UID: 1000, GID: 1000, Set: true}); err != nil {
		t.Fatalf("expected non-root runAs to be allowed: %v", err)
	}
}

func TestValidateRunAs_UnsetIsNeverRejected(t *testing.T) {
	// Set: false is the "omitted from the spec" case — docker-driver.ts's
	// userArgs emits no --user flag at all, so there is nothing to validate
	// (the image's own default applies; see the package doc comment's note
	// that verifying the DRIVER's own default is a separate, un-done item).
	if err := ValidateRunAs(RunAs{}); err != nil {
		t.Fatalf("an omitted runAs must never be rejected: %v", err)
	}
}

func TestUserArgs_MatchesDockerDriverFormat(t *testing.T) {
	got := UserArgs(RunAs{UID: 1000, GID: 1000, Set: true})
	want := []string{"--user", "1000:1000"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("UserArgs = %v, want %v", got, want)
	}
}

func TestUserArgs_UnsetProducesNoFlag(t *testing.T) {
	if got := UserArgs(RunAs{}); got != nil {
		t.Fatalf("UserArgs for an unset runAs should be nil, got %v", got)
	}
}

func TestValidateResources_RejectsZeroPidsLimit(t *testing.T) {
	// cgroups v2 rejects --pids-limit 0 with EINVAL — docker-driver.ts's own
	// comment. TS silently drops the flag on this input; this package rejects
	// it upfront instead, per the task's "reject rather than silently accept"
	// instruction.
	if err := ValidateResources(Resources{PidsLimit: intp(0)}); err == nil {
		t.Fatal("expected pidsLimit=0 to be rejected")
	}
}

func TestValidateResources_RejectsNegativePidsLimit(t *testing.T) {
	if err := ValidateResources(Resources{PidsLimit: intp(-1)}); err == nil {
		t.Fatal("expected a negative pidsLimit to be rejected")
	}
}

func TestValidateResources_AllowsPositivePidsLimit(t *testing.T) {
	if err := ValidateResources(Resources{PidsLimit: intp(256)}); err != nil {
		t.Fatalf("expected a positive pidsLimit to be allowed: %v", err)
	}
}

func TestValidateResources_UnspecifiedFieldsAreNeverRejected(t *testing.T) {
	// Undefined means unbounded on both drivers (SessionResources's own doc
	// comment) — this package must never invent a floor TS does not have.
	if err := ValidateResources(Resources{}); err != nil {
		t.Fatalf("an all-nil Resources must never be rejected: %v", err)
	}
}

func TestValidateResources_RejectsNonPositiveMemory(t *testing.T) {
	if err := ValidateResources(Resources{MemoryMB: intp(0)}); err == nil {
		t.Fatal("expected memoryMb=0 to be rejected (omit the field for unbounded)")
	}
}

func TestValidateResources_RejectsNonPositiveShmSize(t *testing.T) {
	if err := ValidateResources(Resources{ShmSizeMB: intp(-5)}); err == nil {
		t.Fatal("expected a negative shmSizeMb to be rejected")
	}
}

func TestResourceArgs_MatchesDockerDriverFormat(t *testing.T) {
	got := ResourceArgs(Resources{CPUs: strp("2.0"), MemoryMB: intp(512), ShmSizeMB: intp(128)})
	want := []string{"--cpus", "2.0", "--memory", "512m", "--shm-size=128m"}
	if len(got) != len(want) {
		t.Fatalf("ResourceArgs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ResourceArgs = %v, want %v", got, want)
		}
	}
}

func TestPidsLimitArg_OmittedWhenUnset(t *testing.T) {
	if got := PidsLimitArg(Resources{}); got != nil {
		t.Fatalf("expected no --pids-limit flag when unset, got %v", got)
	}
}

func TestHardeningPosture_AlwaysIncludesTheThreeFixedFlags(t *testing.T) {
	want := map[string]bool{"--cap-drop=ALL": true, "--security-opt": true, "no-new-privileges": true, "--init": true}
	for _, arg := range HardeningPosture {
		delete(want, arg)
	}
	if len(want) != 0 {
		t.Fatalf("HardeningPosture is missing: %v", want)
	}
}

func TestEnforceSafeDefaults_ComposesBothChecks(t *testing.T) {
	if err := EnforceSafeDefaults(RunAs{UID: 0, GID: 0, Set: true}, Resources{}); err == nil {
		t.Fatal("expected root runAs to fail the composed check")
	}
	if err := EnforceSafeDefaults(RunAs{}, Resources{PidsLimit: intp(0)}); err == nil {
		t.Fatal("expected a zero pidsLimit to fail the composed check")
	}
	if err := EnforceSafeDefaults(RunAs{UID: 1000, GID: 1000, Set: true}, Resources{PidsLimit: intp(64)}); err != nil {
		t.Fatalf("expected a safe spec to pass: %v", err)
	}
}
