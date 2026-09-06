package mount

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// basePolicy mirrors capture.ts's `policy` object exactly.
func basePolicy() Policy {
	return Policy{
		GroupsRoot:    "/data/groups",
		DataRoot:      "/data",
		SurfaceRoots:  []string{"/app/container/agent-runner/src", "/app/container/skills", "/app/container/CLAUDE.md"},
		MaterialsRoot: "/data/session-materials",
	}
}

func caps() *Capabilities { return &Capabilities{IsolationTiers: []string{"container"}} }

func baseSpec(mounts []Spec, containerOverrides ...func(*Container)) Session {
	c := Container{Role: "agent", Env: map[string]string{}, Mounts: mounts}
	for _, o := range containerOverrides {
		o(&c)
	}
	return Session{
		Key:         SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{GroupFolderLabel: "test-agent"},
		Containers:  []Container{c},
		RuntimeTier: "container",
	}
}

func m(class Class, hostPath, containerPath string, mode Mode) Spec {
	return Spec{Class: class, HostPath: hostPath, ContainerPath: containerPath, Mode: mode, GroupScope: "ag-1"}
}

// The 24 cases from docs/mount-validation-fixtures-p5/capture.ts, ported
// verbatim as Go table-driven tests. `wantAllow` is the SAME "desired,
// hardened" expectation capture.ts used — not necessarily today's actual
// behavior — so each case states whether it should pass against the
// unconditionally-trusting default Policy (matching the pinned baseline,
// including its 2 known DIFF rows) and against a hardened Policy with
// CheckAllowlistedExtra wired (where all 24 should now match).
func TestParityWithCapture_DefaultPolicyMatchesPinnedBaseline(t *testing.T) {
	policy := basePolicy()
	cases := []struct {
		name      string
		spec      Session
		wantAllow bool // capture.ts's ACTUAL result against the pinned/default policy
	}{
		{"normal-group-state-mount-allowed", baseSpec([]Spec{m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1", "/workspace", ModeRW)}), true},
		{"normal-install-surface-readonly-allowed", baseSpec([]Spec{m(ClassInstallSurface, "/app/container/agent-runner/src", "/app/src", ModeRO)}), true},
		{"path-traversal-dotdot-rejected", baseSpec([]Spec{m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1/../../../etc", "/workspace", ModeRW)}), false},
		{"path-relative-rejected", baseSpec([]Spec{m(ClassGroupState, "data/v2-sessions/ag-1/sess-1", "/workspace", ModeRW)}), false},
		{"path-double-slash-rejected", baseSpec([]Spec{m(ClassGroupState, "/data//v2-sessions/ag-1/sess-1", "/workspace", ModeRW)}), false},
		{"path-trailing-slash-rejected", baseSpec([]Spec{m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1/", "/workspace", ModeRW)}), false},
		// The pinned baseline's known gap (mount-validation-fixtures-p5.md's 2 DIFF rows): allowed today, not denied.
		{"docker-socket-via-allowlisted-extra-class-label", baseSpec([]Spec{m(ClassAllowlistedExtra, "/var/run/docker.sock", "/var/run/docker.sock", ModeRW)}), true},
		{"ssh-dir-via-allowlisted-extra-class-label", baseSpec([]Spec{m(ClassAllowlistedExtra, "/root/.ssh", "/root/.ssh", ModeRO)}), true},
		{"identity-material-relabeled-as-allowlisted-extra-into-agent", baseSpec([]Spec{m(ClassAllowlistedExtra, "/data/session-materials/ag-1/client.key", "/run/session/client.key", ModeRW)}), false},
		{"install-surface-relabeled-as-group-state-writable", baseSpec([]Spec{m(ClassGroupState, "/app/container/agent-runner/src", "/app/src", ModeRW)}), false},
		{"identity-material-into-agent-role-rejected", baseSpec([]Spec{m(ClassIdentityMaterial, "/data/session-materials/ag-1/client.key", "/run/session/client.key", ModeRO)}), false},
		{"identity-material-writable-rejected-even-on-non-agent-role", baseSpec([]Spec{m(ClassIdentityMaterial, "/data/session-materials/ag-1/client.key", "/run/session/client.key", ModeRW)}, func(c *Container) { c.Role = "proxy" }), false},
		{"cross-group-groupscope-mismatch-rejected", baseSpec([]Spec{{Class: ClassGroupState, HostPath: "/data/v2-sessions/ag-2/sess-2", ContainerPath: "/workspace", Mode: ModeRW, GroupScope: "ag-2"}}), false},
		{"duplicate-containerpath-rejected", baseSpec([]Spec{
			m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1", "/workspace", ModeRW),
			m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1b", "/workspace", ModeRW),
		}), false},
		{"secret-shaped-key-in-plain-env-rejected", baseSpec(nil, func(c *Container) { c.Env["ANTHROPIC_API_KEY"] = "sk-abcdefghijklmnopqrstuvwx" }), false},
		{"credential-shaped-value-under-innocuous-key-rejected", baseSpec(nil, func(c *Container) { c.Env["GW_CRED"] = "sk-abcdefghijklmnopqrstuvwx" }), false},
		{"credential-value-in-contributedEnv-rejected-even-though-key-name-exempt", baseSpec(nil, func(c *Container) {
			c.ContributedEnv = map[string]string{"ANTHROPIC_AUTH_TOKEN": "sk-abcdefghijklmnopqrstuvwx"}
		}), false},
		{"path-value-in-contributedEnv-allowed-even-with-credential-shaped-key", baseSpec(nil, func(c *Container) {
			c.ContributedEnv = map[string]string{"PROXY_CLIENT_KEY": "/run/session/session-key.pem"}
		}), true},
		{"jwt-shaped-value-rejected", baseSpec(nil, func(c *Container) {
			c.Env["SOME_VAR"] = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
		}), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSpec(tc.spec, policy, caps())
			allowed := err == nil
			if allowed != tc.wantAllow {
				t.Fatalf("ValidateSpec(%s) = %v, want allow=%v", tc.name, err, tc.wantAllow)
			}
		})
	}
}

func TestCrossGroupGroupsRootWithoutFolderLabelRejected(t *testing.T) {
	spec := baseSpec([]Spec{{Class: ClassGroupState, HostPath: "/data/groups/other-agent/plugins", ContainerPath: "/plugins", Mode: ModeRW, GroupScope: "ag-1"}})
	spec.Labels = map[string]string{}
	if err := ValidateSpec(spec, basePolicy(), caps()); err == nil {
		t.Fatal("expected denial with no folder label")
	}
}

func TestCrossGroupGroupsRootWrongFolderLabelRejected(t *testing.T) {
	spec := baseSpec([]Spec{{Class: ClassGroupState, HostPath: "/data/groups/other-agent", ContainerPath: "/plugins", Mode: ModeRW, GroupScope: "ag-1"}})
	if err := ValidateSpec(spec, basePolicy(), caps()); err == nil {
		t.Fatal("expected denial: this session's own folder label is test-agent, not other-agent")
	}
}

func TestRuntimeTierNotInIsolationTiersRejected(t *testing.T) {
	spec := baseSpec(nil)
	spec.RuntimeTier = "vm"
	if err := ValidateSpec(spec, basePolicy(), caps()); err == nil {
		t.Fatal("expected denial for runtimeTier not in driver isolation tiers")
	}
}

func TestZeroAgentContainersRejected(t *testing.T) {
	spec := baseSpec(nil)
	spec.Containers = nil
	if err := ValidateSpec(spec, basePolicy(), caps()); err == nil {
		t.Fatal("expected denial for zero agent containers")
	}
}

func TestTwoAgentRoleContainersRejected(t *testing.T) {
	spec := baseSpec(nil)
	spec.Containers = []Container{
		{Role: "agent", Env: map[string]string{}},
		{Role: "agent", Env: map[string]string{}},
	}
	if err := ValidateSpec(spec, basePolicy(), caps()); err == nil {
		t.Fatal("expected denial for two agent-role containers")
	}
}

// --- P5-02's hardening: CheckAllowlistedExtra closes the 2 known DIFF rows ---

func TestCheckAllowlistedExtra_ClosesDockerSocketAndSshGap(t *testing.T) {
	dir := t.TempDir()
	allowlistPath := filepath.Join(dir, "mount-allowlist.json")
	writeAllowlist(t, allowlistPath, Allowlist{
		AllowedRoots: []AllowedRoot{{Path: filepath.Join(dir, "projects"), AllowReadWrite: true}},
	})

	policy := basePolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return CheckAllowlistedExtra(hostPath, allowlistPath)
	}

	for _, tc := range []struct {
		name string
		path string
	}{
		{"docker-socket-via-allowlisted-extra-class-label", "/var/run/docker.sock"},
		{"ssh-dir-via-allowlisted-extra-class-label", "/root/.ssh"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := baseSpec([]Spec{m(ClassAllowlistedExtra, tc.path, tc.path, ModeRW)})
			if err := ValidateSpec(spec, policy, caps()); err == nil {
				t.Fatalf("expected the hardened policy to deny %s, but it was allowed", tc.path)
			}
		})
	}
}

func TestCheckAllowlistedExtra_AllowsPathUnderAllowedRoot(t *testing.T) {
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "projects", "myrepo")
	if err := os.MkdirAll(projectDir, 0o750); err != nil {
		t.Fatal(err)
	}
	allowlistPath := filepath.Join(dir, "mount-allowlist.json")
	writeAllowlist(t, allowlistPath, Allowlist{
		AllowedRoots: []AllowedRoot{{Path: filepath.Join(dir, "projects"), AllowReadWrite: true}},
	})

	allowed, reason := CheckAllowlistedExtra(projectDir, allowlistPath)
	if !allowed {
		t.Fatalf("expected %s to be allowed under the allowlist, got denied: %s", projectDir, reason)
	}
}

func TestCheckAllowlistedExtra_MissingAllowlistFileFailsClosed(t *testing.T) {
	allowed, reason := CheckAllowlistedExtra("/var/run/docker.sock", "/does/not/exist.json")
	if allowed {
		t.Fatal("expected fail-closed (no allowlist -> block all) to deny")
	}
	if reason == "" {
		t.Fatal("expected a human-readable deny reason (LAW-04: deny reasons must not be swallowed)")
	}
}

func TestCheckAllowlistedExtra_BlockedPatternWinsEvenUnderAllowedRoot(t *testing.T) {
	dir := t.TempDir()
	sshLike := filepath.Join(dir, "projects", ".ssh")
	if err := os.MkdirAll(sshLike, 0o750); err != nil {
		t.Fatal(err)
	}
	allowlistPath := filepath.Join(dir, "mount-allowlist.json")
	writeAllowlist(t, allowlistPath, Allowlist{
		AllowedRoots: []AllowedRoot{{Path: filepath.Join(dir, "projects"), AllowReadWrite: true}},
	})
	allowed, _ := CheckAllowlistedExtra(sshLike, allowlistPath)
	if allowed {
		t.Fatal("expected the default blocked pattern '.ssh' to win even though the path is under an allowed root")
	}
}

// --- P5-02's hardening: real symlink-escape resolution (item 1, no TS equivalent) ---

func TestResolveSymlinks_EscapeThroughIdentityMaterialRootIsDenied(t *testing.T) {
	dir := t.TempDir()
	materialsRoot := filepath.Join(dir, "session-materials")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(materialsRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	secretFile := filepath.Join(outside, "real-secret.key")
	if err := os.WriteFile(secretFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A symlink INSIDE materialsRoot (so the lexical + class-required checks
	// both pass) whose target escapes to `outside`.
	linkPath := filepath.Join(materialsRoot, "client.key")
	if err := os.Symlink(secretFile, linkPath); err != nil {
		t.Fatal(err)
	}

	policy := Policy{
		GroupsRoot:      filepath.Join(dir, "groups"),
		DataRoot:        filepath.Join(dir, "data"),
		SurfaceRoots:    []string{filepath.Join(dir, "surface")},
		MaterialsRoot:   materialsRoot,
		ResolveSymlinks: true,
	}
	spec := Session{
		Key:         SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{GroupFolderLabel: "test-agent"},
		RuntimeTier: "container",
		Containers: []Container{
			{Role: "agent", Env: map[string]string{}},
			{Role: "proxy", Env: map[string]string{}, Mounts: []Spec{m(ClassIdentityMaterial, linkPath, "/run/session/client.key", ModeRO)}},
		},
	}

	if err := ValidateSpec(spec, policy, caps()); err == nil {
		t.Fatal("expected a symlink that resolves outside materialsRoot to be denied when ResolveSymlinks is on")
	}
}

func TestResolveSymlinks_OffByDefaultDoesNotBreakExistingBehavior(t *testing.T) {
	dir := t.TempDir()
	materialsRoot := filepath.Join(dir, "session-materials")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(materialsRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o750); err != nil {
		t.Fatal(err)
	}
	secretFile := filepath.Join(outside, "real-secret.key")
	if err := os.WriteFile(secretFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(materialsRoot, "client.key")
	if err := os.Symlink(secretFile, linkPath); err != nil {
		t.Fatal(err)
	}

	policy := Policy{
		GroupsRoot:    filepath.Join(dir, "groups"),
		DataRoot:      filepath.Join(dir, "data"),
		SurfaceRoots:  []string{filepath.Join(dir, "surface")},
		MaterialsRoot: materialsRoot,
		// ResolveSymlinks left false: matches the pinned TS baseline exactly.
	}
	spec := Session{
		Key:         SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{GroupFolderLabel: "test-agent"},
		RuntimeTier: "container",
		Containers: []Container{
			{Role: "agent", Env: map[string]string{}},
			{Role: "proxy", Env: map[string]string{}, Mounts: []Spec{m(ClassIdentityMaterial, linkPath, "/run/session/client.key", ModeRO)}},
		},
	}
	if err := ValidateSpec(spec, policy, caps()); err != nil {
		t.Fatalf("with ResolveSymlinks off, expected the same lexical-only result TS gives (allowed here): %v", err)
	}
}

func TestResolveSymlinks_LegitimateNonSymlinkPathStillAllowed(t *testing.T) {
	dir := t.TempDir()
	materialsRoot := filepath.Join(dir, "session-materials")
	if err := os.MkdirAll(materialsRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	realFile := filepath.Join(materialsRoot, "client.key")
	if err := os.WriteFile(realFile, []byte("cert"), 0o600); err != nil {
		t.Fatal(err)
	}

	policy := Policy{
		GroupsRoot:      filepath.Join(dir, "groups"),
		DataRoot:        filepath.Join(dir, "data"),
		SurfaceRoots:    []string{filepath.Join(dir, "surface")},
		MaterialsRoot:   materialsRoot,
		ResolveSymlinks: true,
	}
	spec := Session{
		Key:         SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{GroupFolderLabel: "test-agent"},
		RuntimeTier: "container",
		Containers: []Container{
			{Role: "agent", Env: map[string]string{}},
			{Role: "proxy", Env: map[string]string{}, Mounts: []Spec{m(ClassIdentityMaterial, realFile, "/run/session/client.key", ModeRO)}},
		},
	}
	if err := ValidateSpec(spec, policy, caps()); err != nil {
		t.Fatalf("a real (non-symlink) legitimate mount must still be allowed with ResolveSymlinks on: %v", err)
	}
}

func writeAllowlist(t *testing.T, path string, a Allowlist) {
	t.Helper()
	data, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// --- secret-shape unit coverage beyond the capture cases ---

func TestIsSecretShaped_PathValueExemption(t *testing.T) {
	if IsSecretShaped("ANTHROPIC_API_KEY", "/run/session/session-key.pem") {
		t.Fatal("a path value must be exempt regardless of key name (types.ts:526-530)")
	}
}

func TestLooksLikeCredential_PemBlock(t *testing.T) {
	if !LooksLikeCredential("-----BEGIN RSA PRIVATE KEY-----\nMIIB...") {
		t.Fatal("expected an inline PEM block to be classified as a credential")
	}
}

// --- origin exemption (P6-04, porting nanocoai/nanoclaw#3680/fdde3b26) ---

// The regression this exists to catch: a hardened AllowlistedExtraCheck
// (the config this project's own ADR-004 recommends operators eventually
// enable) applied uniformly to a provider-contributed mount would deny it
// outright, exactly the bug the real PR found and fixed on the TS side —
// this is that same scenario, reproduced against the Go port.
func TestOriginProvider_ExemptFromAllowlistedExtraCheck(t *testing.T) {
	policy := basePolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return false, "not on the operator's allowlist" // hardened: deny everything not listed
	}
	spec := m(ClassAllowlistedExtra, "/tmp/onecli-ca-cert.pem", "/workspace/extra/ca.pem", ModeRO)
	spec.Origin = OriginProvider

	session := baseSpec([]Spec{spec})
	if err := ValidateSpec(session, policy, caps()); err != nil {
		t.Fatalf("expected a provider-origin mount to be exempt from the allowlist re-check, got denied: %v", err)
	}
}

// The negative control: an operator-origin (or unset, matching every mount
// created before PR #3680/this port existed) mount must still go through
// the check — the exemption is narrow, not a general bypass.
func TestOriginOperator_StillSubjectToAllowlistedExtraCheck(t *testing.T) {
	policy := basePolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return false, "not on the operator's allowlist"
	}
	for _, origin := range []Origin{OriginOperator, ""} {
		spec := m(ClassAllowlistedExtra, "/home/user/some/path", "/workspace/extra/path", ModeRO)
		spec.Origin = origin
		session := baseSpec([]Spec{spec})
		if err := ValidateSpec(session, policy, caps()); err == nil {
			t.Fatalf("expected origin=%q to still be denied by AllowlistedExtraCheck, got allowed", origin)
		}
	}
}

// End-to-end control mirroring the real OneCLI shape (contributionFromArgs'
// CA-cert/credential-stub file mounts): with NO AllowlistedExtraCheck wired
// at all (this project's still-current default — see the package doc
// comment), a provider-origin mount was already allowed unconditionally
// before this fix, and must remain so — Origin only ever narrows what the
// hardened check would otherwise deny, it never changes the unhardened
// default's behavior.
func TestOriginProvider_UnhardenedDefaultUnaffected(t *testing.T) {
	policy := basePolicy() // AllowlistedExtraCheck left nil
	spec := m(ClassAllowlistedExtra, "/tmp/onecli-ca-cert.pem", "/workspace/extra/ca.pem", ModeRO)
	spec.Origin = OriginProvider
	session := baseSpec([]Spec{spec})
	if err := ValidateSpec(session, policy, caps()); err != nil {
		t.Fatalf("expected the unhardened default to still allow this mount, got denied: %v", err)
	}
}
