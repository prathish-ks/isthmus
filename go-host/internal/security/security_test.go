package security

import (
	"path/filepath"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/credential"
	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
	"github.com/prathish-ks/isthmus/go-host/internal/ownership"
)

func policy() mount.Policy {
	return mount.Policy{
		GroupsRoot:    "/data/groups",
		DataRoot:      "/data",
		SurfaceRoots:  []string{"/app/container/agent-runner/src"},
		MaterialsRoot: "/data/session-materials",
	}
}

func agentSession(mounts []mount.Spec) mount.Session {
	return mount.Session{
		Key:         mount.SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels:      map[string]string{mount.GroupFolderLabel: "test-agent"},
		RuntimeTier: "container",
		Containers:  []mount.Container{{Role: "agent", Env: map[string]string{}, Mounts: mounts}},
	}
}

// --- 1. Docker socket ---

func TestInvariant_DockerSocketCannotReachAgentViaHardenedPolicy(t *testing.T) {
	dir := t.TempDir()
	allowlistPath := filepath.Join(dir, "mount-allowlist.json")
	p := policy()
	p.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return mount.CheckAllowlistedExtra(hostPath, allowlistPath) // missing file -> fail closed
	}
	spec := agentSession([]mount.Spec{{Class: mount.ClassAllowlistedExtra, HostPath: "/var/run/docker.sock", ContainerPath: "/var/run/docker.sock", Mode: mount.ModeRW, GroupScope: "ag-1"}})
	if err := mount.ValidateSpec(spec, p, nil); err == nil {
		t.Fatal("Docker socket must never reach an agent container under the hardened policy")
	}
}

// --- 2. Privileged/root execution ---

func TestInvariant_AgentContainerCannotRunAsRoot(t *testing.T) {
	if err := containerdefaults.ValidateRunAs(containerdefaults.RunAs{UID: 0, GID: 0, Set: true}); err == nil {
		t.Fatal("an explicit root runAs must be rejected")
	}
}

// --- 3. Forbidden mounts (class pinning cannot be bypassed by relabeling) ---

func TestInvariant_IdentityMaterialCannotBeRelabeledIntoAgent(t *testing.T) {
	spec := agentSession([]mount.Spec{{Class: mount.ClassAllowlistedExtra, HostPath: "/data/session-materials/ag-1/client.key", ContainerPath: "/run/session/client.key", Mode: mount.ModeRW, GroupScope: "ag-1"}})
	if err := mount.ValidateSpec(spec, policy(), nil); err == nil {
		t.Fatal("a path under materialsRoot must be forced to class identity-material regardless of the label a composer chose")
	}
}

// --- 4. Path traversal / symlink escape ---

func TestInvariant_LexicalTraversalRejectedInMounts(t *testing.T) {
	spec := agentSession([]mount.Spec{{Class: mount.ClassGroupState, HostPath: "/data/v2-sessions/ag-1/../../etc", ContainerPath: "/workspace", Mode: mount.ModeRW, GroupScope: "ag-1"}})
	if err := mount.ValidateSpec(spec, policy(), nil); err == nil {
		t.Fatal("a '..'-bearing mount host path must be rejected")
	}
}

func TestInvariant_ForgedSessionIDCannotEscapeMailboxRoot(t *testing.T) {
	if _, err := ownership.SafeMailboxDir("/data", "ag-1", "../../etc/passwd"); err == nil {
		t.Fatal("a forged sessionId must never be allowed to construct a mailbox path")
	}
	// And the underlying gap this guards against is real, not hypothetical:
	unsafe := mailbox.Path("/data", "ag-1", "../../etc/passwd")
	root := filepath.Join("/data", "v2-sessions") + string(filepath.Separator)
	if len(unsafe) >= len(root) && unsafe[:len(root)] == root {
		t.Fatal("expected the unguarded mailbox.Path to actually escape /data/v2-sessions for this forged id — the invariant above would be untested against a real risk otherwise")
	}
}

// --- 5. Cross-session access ---

func TestInvariant_GroupStateMountScopedToOwnAgentGroup(t *testing.T) {
	spec := agentSession([]mount.Spec{{Class: mount.ClassGroupState, HostPath: "/data/v2-sessions/ag-2/sess-2", ContainerPath: "/workspace", Mode: mount.ModeRW, GroupScope: "ag-2"}})
	if err := mount.ValidateSpec(spec, policy(), nil); err == nil {
		t.Fatal("a mount scoped to a different agent group than the session's own key must be denied")
	}
}

func TestInvariant_MailboxOwnershipRejectsClaimedGroupMismatch(t *testing.T) {
	if err := ownership.ValidateOwnership("ag-1", "ag-2"); err == nil {
		t.Fatal("a caller claiming a different agent group than the session actually belongs to must be denied")
	}
}

// --- 6. Secret exposure ---

func TestInvariant_SecretShapedEnvKeyRejected(t *testing.T) {
	spec := agentSession(nil)
	spec.Containers[0].Env["ANTHROPIC_API_KEY"] = "sk-abcdefghijklmnopqrstuvwx"
	if err := mount.ValidateSpec(spec, policy(), nil); err == nil {
		t.Fatal("a credential-shaped env value must be denied regardless of key name")
	}
}

func TestInvariant_RealCredentialFlowNeverPutsAValueInEnv(t *testing.T) {
	c, err := credential.ContributionFromArgs([]string{"-e", "ANTHROPIC_AUTH_TOKEN=placeholder", "-v", "/tmp/onecli/ca.pem:/etc/ssl/ca.pem:ro"}, "ag-1")
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	for k, v := range c.Env {
		if mount.LooksLikeCredential(v) {
			t.Fatalf("OneCLI's own contributed env must never carry a real credential value (key=%s)", k)
		}
	}
	if len(c.Mounts) != 1 || c.Mounts[0].Mode != mount.ModeRO {
		t.Fatal("the real credential material (the CA cert) must ride as a read-only mount, not an env value")
	}
}
