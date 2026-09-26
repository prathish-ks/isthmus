package mount

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// basePolicy mirrors capture.ts's `policy` object, plus GatewayTrustRoot
// (v2.4.0 promotion) — set here, not left empty, because a real deployment
// always configures it (see ClassGatewayTrust/ClassRequiredByPath's own
// comments on why an empty root is a defensive-guard case, not a normal
// one). "/data/gateway-trust" doesn't collide with any other fixture path
// used across this file's existing cases.
func basePolicy() Policy {
	return Policy{
		GroupsRoot:       "/data/groups",
		DataRoot:         "/data",
		SurfaceRoots:     []string{"/app/container/agent-runner/src", "/app/container/skills", "/app/container/CLAUDE.md"},
		MaterialsRoot:    "/data/session-materials",
		GatewayTrustRoot: "/data/gateway-trust",
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

// ---------- gateway-trust (v2.4.0 promotion, commit 249bbe93) ----------

// Table-driven, mirroring TestParityWithCapture_DefaultPolicyMatchesPinnedBaseline's
// style: every rule types.ts's own diff added for 'gateway-trust', exercised
// against the real ValidateSpec entry point rather than the unexported
// helpers directly, so a regression anywhere in the admission chain (class
// pinning, ro-only, role scope) is caught the same way a real caller would
// hit it.
func TestGatewayTrust_AdmissionRules(t *testing.T) {
	policy := basePolicy() // GatewayTrustRoot: "/data/gateway-trust"
	cases := []struct {
		name      string
		spec      Session
		wantAllow bool
	}{
		{
			"correctly-classed-readonly-on-agent-role-allowed",
			baseSpec([]Spec{m(ClassGatewayTrust, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRO)}),
			true, // unlike identity-material, gateway-trust IS allowed on the agent role
		},
		// The non-agent-role case (a gateway-trust mount on an auxiliary proxy
		// container, the real Iron Proxy shape) needs a genuine second
		// container to satisfy the "exactly one agent container" invariant —
		// baseSpec's single-container helper can't express that, so it's
		// TestGatewayTrust_AllowedOnAuxiliaryProxyRole below instead of a row
		// here.
		{
			"writable-gateway-trust-mount-rejected-even-off-agent-role",
			baseSpec([]Spec{m(ClassGatewayTrust, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRW)}, func(c *Container) { c.Role = "proxy" }),
			false, // ro-only is unconditional, not role-scoped like identity-material's agent restriction
		},
		{
			"path-under-gateway-trust-root-mislabeled-as-allowlisted-extra-rejected",
			baseSpec([]Spec{m(ClassAllowlistedExtra, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRO)}),
			false, // ClassRequiredByPath pins this path to gateway-trust; the composer doesn't get to relabel it, same principle as identity-material/install-surface
		},
		{
			"path-under-gateway-trust-root-mislabeled-as-identity-material-rejected",
			baseSpec([]Spec{m(ClassIdentityMaterial, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRO)}),
			false,
		},
		{
			"gateway-trust-label-on-path-outside-the-root-rejected",
			baseSpec([]Spec{m(ClassGatewayTrust, "/data/session-materials/ag-1/not-actually-gateway-trust", "/etc/ssl/gateway-ca.pem", ModeRO)}),
			false, // mountAllowed's gateway-trust case requires the path to actually be under GatewayTrustRoot
		},
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

// gateway-trust on a non-agent role — the real Iron Proxy shape (CA material
// mounted into an auxiliary proxy container, not the agent). Needs a genuine
// two-container session (agent + proxy) to satisfy ValidateSpec's "exactly
// one agent container" invariant while still putting the mount under test on
// the non-agent one; baseSpec's single-container helper can't express that.
func TestGatewayTrust_AllowedOnAuxiliaryProxyRole(t *testing.T) {
	policy := basePolicy()
	spec := Session{
		Key:    SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels: map[string]string{GroupFolderLabel: "test-agent"},
		Containers: []Container{
			{Role: "agent", Env: map[string]string{}},
			{Role: "proxy", Env: map[string]string{}, Mounts: []Spec{
				m(ClassGatewayTrust, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRO),
			}},
		},
		RuntimeTier: "container",
	}
	if err := ValidateSpec(spec, policy, caps()); err != nil {
		t.Fatalf("expected a read-only gateway-trust mount on a non-agent (proxy) role to validate, got denied: %v", err)
	}
}

// GatewayTrustRoot unset (the pre-v2.4.0-fixture zero value, or any caller
// that hasn't migrated its Policy construction yet) must fail closed — deny
// a gateway-trust mount, not implicitly allow it via underRoot's
// empty-root-matches-every-absolute-path behavior. This is the regression
// this package's own existing test suite caught when GatewayTrustRoot was
// first added (see ClassRequiredByPath's doc comment) — kept as an explicit
// test so it can't silently regress again.
func TestGatewayTrust_UnconfiguredRootFailsClosed(t *testing.T) {
	policy := basePolicy()
	policy.GatewayTrustRoot = ""

	t.Run("mount_correctly_classed_still_denied", func(t *testing.T) {
		spec := baseSpec([]Spec{m(ClassGatewayTrust, "/data/gateway-trust/ca.pem", "/etc/ssl/gateway-ca.pem", ModeRO)})
		if err := ValidateSpec(spec, policy, caps()); err == nil {
			t.Fatal("expected denial: GatewayTrustRoot unconfigured must fail closed, not allow every path")
		}
	})

	t.Run("unrelated_mount_not_misclassified_as_gateway_trust", func(t *testing.T) {
		// The actual bug this guard fixes: before the empty-root guard, EVERY
		// absolute hostPath satisfied underRoot(path, "") — including this
		// entirely unrelated, correctly-classed group-state mount (chosen
		// deliberately over identity-material: identity-material is never
		// valid on the agent role at all, for reasons unrelated to
		// GatewayTrustRoot, which would confound what this specific case is
		// meant to prove — see mount.go's own role-scope comment).
		spec := baseSpec([]Spec{m(ClassGroupState, "/data/v2-sessions/ag-1/sess-1", "/workspace", ModeRW)})
		if err := ValidateSpec(spec, policy, caps()); err != nil {
			t.Fatalf("expected this group-state mount to validate normally regardless of GatewayTrustRoot being unset, got: %v", err)
		}
	})
}

// ClassRequiredByPath checks GatewayTrustRoot before MaterialsRoot — pins
// that order so a hostPath under both roots (a misconfiguration nothing else
// prevents) classifies as gateway-trust here, matching the identical
// precedence this package's TS mirror (classRequiredByPath, drivers/types.ts)
// now also uses. Before this test and the matching TS one existed, nothing
// on either side would have caught the two mirrors disagreeing on which
// class wins the overlap.
func TestClassRequiredByPath_GatewayTrustPrecedesMaterials(t *testing.T) {
	policy := basePolicy()
	policy.MaterialsRoot = "/data/shared-root"
	policy.GatewayTrustRoot = "/data/shared-root/gateway-trust"

	got := ClassRequiredByPath("/data/shared-root/gateway-trust/ca.pem", policy)
	if got != ClassGatewayTrust {
		t.Fatalf("expected ClassGatewayTrust for a path under both roots, got %q", got)
	}
}

// ResolveSymlinks hardening (this package's own Go-only addition, item 1 in
// the package doc comment) must cover gateway-trust the same way it already
// covers identity-material/install-surface — a symlink planted inside an
// otherwise-legal gateway-trust directory must not be able to point the
// real bind target outside GatewayTrustRoot.
func TestGatewayTrust_ResolveSymlinksEscapeDenied(t *testing.T) {
	trustDir := t.TempDir()
	outsideDir := t.TempDir()
	realTarget := filepath.Join(outsideDir, "not-actually-trusted.pem")
	if err := os.WriteFile(realTarget, []byte("fake"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(trustDir, "ca.pem")
	if err := os.Symlink(realTarget, symlinkPath); err != nil {
		t.Fatal(err)
	}

	policy := basePolicy()
	policy.GatewayTrustRoot = trustDir
	policy.ResolveSymlinks = true

	spec := baseSpec([]Spec{m(ClassGatewayTrust, symlinkPath, "/etc/ssl/gateway-ca.pem", ModeRO)})
	if err := ValidateSpec(spec, policy, caps()); err == nil {
		t.Fatal("expected denial: symlink under GatewayTrustRoot resolves outside it")
	}
}

// ---------- NetworkAccessIntent (v2.4.0 promotion, Workstream A2) ----------

// The actual wire-contract concern A2 exists for: TS's NetworkAccessIntent
// serializes as {"endpoint":"...","target":{"kind":"...","identity":"..."}}
// (a discriminated union flattened into one object with a "kind" tag) --
// this proves Go's mirror produces and consumes exactly that shape, field
// names included, not just that the Go types compile.
func TestNetworkAccessIntent_JSONRoundTrip(t *testing.T) {
	cases := []struct {
		name       string
		intent     NetworkAccessIntent
		wantFields map[string]any
	}{
		{
			"host-target-has-no-identity-or-role-field",
			NetworkAccessIntent{Endpoint: "gateway.internal:443", Target: NetworkAccessTarget{Kind: NetworkTargetHost}},
			map[string]any{"endpoint": "gateway.internal:443", "target": map[string]any{"kind": "host"}},
		},
		{
			"runtime-target-carries-identity",
			NetworkAccessIntent{Endpoint: "gateway.internal:443", Target: NetworkAccessTarget{Kind: NetworkTargetRuntime, Identity: "fly-machine-abc123"}},
			map[string]any{"endpoint": "gateway.internal:443", "target": map[string]any{"kind": "runtime", "identity": "fly-machine-abc123"}},
		},
		{
			"session-container-target-carries-role",
			NetworkAccessIntent{Endpoint: "gateway.internal:443", Target: NetworkAccessTarget{Kind: NetworkTargetSessionContainer, Role: "proxy"}},
			map[string]any{"endpoint": "gateway.internal:443", "target": map[string]any{"kind": "session-container", "role": "proxy"}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.intent)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var decoded map[string]any
			if err := json.Unmarshal(raw, &decoded); err != nil {
				t.Fatalf("unmarshal into generic map: %v", err)
			}
			if !reflect.DeepEqual(decoded, tc.wantFields) {
				t.Fatalf("wire shape mismatch:\n got:  %#v\n want: %#v\n raw:  %s", decoded, tc.wantFields, raw)
			}

			// Round-trip back into the typed struct and confirm equality —
			// proves decoding is as faithful as encoding.
			var roundTripped NetworkAccessIntent
			if err := json.Unmarshal(raw, &roundTripped); err != nil {
				t.Fatalf("unmarshal into NetworkAccessIntent: %v", err)
			}
			if roundTripped != tc.intent {
				t.Fatalf("round-trip mismatch: got %+v, want %+v", roundTripped, tc.intent)
			}
		})
	}
}

// Session.NetworkAccess rides the same "carried whole across
// CapabilityRequestPayload" wire path as everything else in Session — this
// confirms it actually appears under the "networkAccess" key TS expects
// when a whole Session is marshaled, not just when NetworkAccessIntent is
// marshaled in isolation.
func TestSession_NetworkAccessFieldName(t *testing.T) {
	spec := baseSpec(nil)
	spec.NetworkAccess = NetworkAccessIntent{Endpoint: "gateway.internal:443", Target: NetworkAccessTarget{Kind: NetworkTargetHost}}
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	na, ok := decoded["networkAccess"].(map[string]any)
	if !ok {
		t.Fatalf("expected a \"networkAccess\" object key in the marshaled Session, got: %s", raw)
	}
	if na["endpoint"] != "gateway.internal:443" {
		t.Fatalf("expected networkAccess.endpoint to round-trip, got: %#v", na)
	}
}
