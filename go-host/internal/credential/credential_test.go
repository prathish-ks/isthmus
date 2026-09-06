package credential

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

func TestContributionFromArgs_ParsesEnvPair(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-e", "ANTHROPIC_AUTH_TOKEN=placeholder"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Env["ANTHROPIC_AUTH_TOKEN"] != "placeholder" {
		t.Fatalf("expected env to carry the placeholder, got %v", c.Env)
	}
}

func TestContributionFromArgs_ParsesReadOnlyMount(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-v", "/tmp/ca.pem:/etc/ssl/ca.pem:ro"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(c.Mounts) != 1 {
		t.Fatalf("expected 1 mount, got %d", len(c.Mounts))
	}
	m := c.Mounts[0]
	if m.HostPath != "/tmp/ca.pem" || m.ContainerPath != "/etc/ssl/ca.pem" || m.Mode != mount.ModeRO || m.Class != mount.ClassAllowlistedExtra {
		t.Fatalf("unexpected mount: %+v", m)
	}
}

func TestContributionFromArgs_ParsesReadWriteMountWhenNoModeSuffix(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-v", "/tmp/stub.key:/run/session/stub.key"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Mounts[0].Mode != mount.ModeRW {
		t.Fatalf("expected rw when no :ro suffix, got %s", c.Mounts[0].Mode)
	}
}

func TestContributionFromArgs_FailsClosedOnUnknownFlag(t *testing.T) {
	_, err := ContributionFromArgs([]string{"--network", "host"}, "ag-1")
	if err == nil {
		t.Fatal("expected an unrecognized flag to fail closed (onecli.ts's own grammar-closed contract)")
	}
}

func TestContributionFromArgs_FailsClosedOnMalformedVolumeSpec(t *testing.T) {
	_, err := ContributionFromArgs([]string{"-v", "/tmp/a:/tmp/b:/tmp/c:/tmp/d"}, "ag-1")
	if err == nil {
		t.Fatal("expected a 4-part volume spec to fail closed")
	}
}

func TestContributionFromArgs_FailsClosedOnNonRoModeSuffix(t *testing.T) {
	_, err := ContributionFromArgs([]string{"-v", "/tmp/a:/tmp/b:rw"}, "ag-1")
	if err == nil {
		t.Fatal("expected a mode suffix other than 'ro' to fail closed (matches onecli.ts's own === 'ro' check)")
	}
}

// --- property 1: credential VALUES never ride contributedEnv, even with the key-name check exempt ---

func TestProperty_ContributedEnvRejectsCredentialValueDespiteExemptKeyName(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-e", "ANTHROPIC_AUTH_TOKEN=sk-abcdefghijklmnopqrstuvwx"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := sessionWith(nil, c.Env)
	if err := mount.ValidateSpec(spec, testPolicy(), nil); err == nil {
		t.Fatal("expected a real credential value in contributedEnv to be denied even though the key name is exempt from the key-shape check")
	}
}

func TestProperty_ContributedEnvAllowsLegitimatePlaceholder(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-e", "ANTHROPIC_AUTH_TOKEN=placeholder"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := sessionWith(nil, c.Env)
	if err := mount.ValidateSpec(spec, testPolicy(), nil); err != nil {
		t.Fatalf("expected the legitimate placeholder pattern to be allowed: %v", err)
	}
}

// --- property 2: real credential material rides by reference (mount), proven end to end ---

func TestProperty_CredentialStubMountRidesByReferenceNotByValue(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-v", "/tmp/onecli/session-key.pem:/run/session/session-key.pem:ro"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := sessionWith(c.Mounts, nil)
	// Default policy (AllowlistedExtraCheck nil) reproduces the pinned
	// baseline's unconditional trust of allowlisted-extra — the credential
	// flow works exactly as it does today.
	if err := mount.ValidateSpec(spec, testPolicy(), nil); err != nil {
		t.Fatalf("expected the pinned-baseline policy to allow OneCLI's own contributed stub mount: %v", err)
	}
}

// --- the ADR-006 finding, made executable: P5-02's opt-in hardening can break this exact flow ---
//
// RESOLVED, 2026-09-02 (P6-04): this test used to assert the gap (a hardened
// AllowlistedExtraCheck denies OneCLI's own contributed mount, because
// nothing distinguished its origin). ContributionFromArgs now stamps
// mount.OriginProvider on every mount it constructs, and mount.mountAllowed
// exempts OriginProvider mounts before consulting AllowlistedExtraCheck at
// all (see internal/mount's doc comment and its own TestOriginProvider_*
// tests) — mirroring nanocoai/nanoclaw#3680/fdde3b26's real TS fix at its
// second call site. This test now asserts the fix, not the gap.
func TestFinding_HardenedAllowlistCheckNoLongerBreaksOneCLIsOwnContributedMount(t *testing.T) {
	c, err := ContributionFromArgs([]string{"-v", "/tmp/onecli/session-key.pem:/run/session/session-key.pem:ro"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := sessionWith(c.Mounts, nil)

	dir := t.TempDir()
	allowlistPath := filepath.Join(dir, "mount-allowlist.json")
	// A realistic operator allowlist: dev project directories, nothing about
	// OneCLI's own internal stub-file directory (there is no reason an
	// operator would think to add it — it is not a path they chose).
	writeAllowlist(t, allowlistPath, mount.Allowlist{
		AllowedRoots: []mount.AllowedRoot{{Path: filepath.Join(dir, "projects"), AllowReadWrite: true}},
	})
	policy := testPolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return mount.CheckAllowlistedExtra(hostPath, allowlistPath)
	}

	if err := mount.ValidateSpec(spec, policy, nil); err != nil {
		t.Fatalf("expected OneCLI's own provider-origin contributed mount to be exempt from the hardened operator allowlist check, got denied: %v", err)
	}
}

// --- helpers ---

func testPolicy() mount.Policy {
	return mount.Policy{
		GroupsRoot:    "/data/groups",
		DataRoot:      "/data",
		SurfaceRoots:  []string{"/app/container/agent-runner/src"},
		MaterialsRoot: "/data/session-materials",
	}
}

func sessionWith(mounts []mount.Spec, contributedEnv map[string]string) mount.Session {
	return mount.Session{
		Key:         mount.SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{mount.GroupFolderLabel: "test-agent"},
		RuntimeTier: "container",
		Containers: []mount.Container{{
			Role:           "agent",
			Env:            map[string]string{},
			ContributedEnv: contributedEnv,
			Mounts:         mounts,
		}},
	}
}

func writeAllowlist(t *testing.T, path string, a mount.Allowlist) {
	t.Helper()
	data, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
