package kernel

// EC-05 (Phase 9, roadmap-to-v1.md): the post-wiring adversarial pass named
// by the Phase 5 readiness review ("no red-team/adversarial pass after any
// P5 task — define-then-implement is only half the loop") and held off
// until EC-02 (real enforcement wiring) and Phase 10 (hardening) both
// landed and were verified on the real Mac.
//
// Every test in this file drives k.Dispatch — the exact function
// Kernel.Serve's serveConn loop calls for every line read off the real Unix
// socket (server.go) — so "blocked" here means blocked at the same seam a
// real TypeScript caller, or a raw process dialing the socket directly,
// would hit. Where a fakeExecutor is used, the point is never "did Dispatch
// return an error" alone: it is "did k.executor.Wake/Kill/BuildImage get
// invoked at all" (fakeExecutor.wakeCalls/killCalls/buildCalls), matching
// doc.go's own claim that a denial never reaches exec. Findings that
// specifically need a REAL `docker create`/`docker inspect` to prove
// exploitability (not just "the Go validator returned nil") are in
// adversarial_live_docker_test.go instead, gated behind an explicit opt-in
// env var since they have real side effects on the machine running them.
//
// Named misuse cases from the threat model this file attempts, per
// roadmap-to-v1.md's own EC-05 text: forged session IDs, allowlisted-extra
// mount abuse, root runAs, and a malformed spec trying to reach the
// executor by a route other than the kernel's own validated path. Two
// additional cases surfaced by this pass itself (agent-group impersonation,
// auxiliary-container-role smuggling) are included below too — EC-05's own
// purpose is to find what the four named cases don't already cover, not
// just to re-confirm exactly four things.

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// ---------- 1. allowlisted-extra mount abuse (Docker socket, .ssh) ----------

// dockerSocketMountSpec builds a container.wake spec whose agent container
// requests exactly one mount: the real Docker socket path, classed
// allowlisted-extra (the class the caller controls freely — see mount.go's
// ClassRequiredByPath, which returns "" for any path outside MaterialsRoot/
// SurfaceRoots, imposing no required class on it at all), mode rw. This is
// not a contrived shape: TS's own buildMounts composes allowlisted-extra
// mounts from operator config and gateway-provider contributions, and
// nothing in the wire protocol stops a caller — TS or a raw socket client —
// from naming any absolute path there.
func dockerSocketMountSpec() mount.Session {
	spec := validSession()
	spec.Containers[0].Mounts = []mount.Spec{
		{
			Class:         mount.ClassAllowlistedExtra,
			HostPath:      "/var/run/docker.sock",
			ContainerPath: "/var/run/docker.sock",
			Mode:          mount.ModeRW,
		},
	}
	return spec
}

// sshKeyMountSpec is the same shape, targeting a real SSH private-key
// directory instead of the Docker socket — proving the gap this test file
// finds is the allowlisted-extra class itself having no default check, not
// something specific to one path. /home/attacker/.ssh does not need to
// exist: hostPathCanonical only requires an absolute, lexically clean path
// (mount.go:299-311); nothing in the default (ResolveSymlinks: false)
// pipeline requires the path to be real at validation time.
func sshKeyMountSpec() mount.Session {
	spec := validSession()
	spec.Containers[0].Mounts = []mount.Spec{
		{
			Class:         mount.ClassAllowlistedExtra,
			HostPath:      "/home/attacker/.ssh",
			ContainerPath: "/root/.ssh",
			Mode:          mount.ModeRO,
		},
	}
	return spec
}

// TestWake_DockerSocketMount_NoAllowlistConfigured_ReachesExecutorUnblocked
// is this pass's headline finding. testPolicy() (this file's shared fixture,
// used by every other test in this package) leaves AllowlistedExtraCheck
// nil — exactly cmd/nanogo/serve.go's actual default: buildServeKernel only
// sets Policy.AllowlistedExtraCheck when the operator passes -allowlist, and
// that flag defaults to "" (unset). mountAllowed's own ClassAllowlistedExtra
// case (mount.go:381-389) is explicit about what nil means: "Vetted upstream
// by the mount-allowlist feature (unconditional trust — the pinned
// baseline's own documented gap)." This test proves that gap end-to-end
// through the real dispatch path, not just by reading the comment: a wake
// request mounting the real Docker socket rw into the agent container is
// ALLOWED, and fakeExecutor.Wake is actually invoked with that mount intact
// — meaning a real dockerExecutor would have run `docker create -v
// /var/run/docker.sock:/var/run/docker.sock ...` for real (confirmed against
// a live daemon in adversarial_live_docker_test.go). A container with the
// host's own Docker socket bind-mounted can create sibling containers with
// arbitrary host mounts/capabilities — full host compromise from inside a
// supposedly-sandboxed agent container, the same primitive OpenClaw's
// CVE-2026-27002 exploited.
//
// This is NOT a bug in mount.ValidateSpec, containerdefaults, or
// internal/kernel — every one of those packages does exactly what its own
// tests say it does. It is a deployment-default gap: the allowlist hook
// exists and works (see the next test), but nothing requires an operator to
// wire it, and cmd/nanogo serve does not warn, refuse to start, or even log
// when it isn't. See adversarial-findings-ec05.md for the recommendation.
func TestWake_DockerSocketMount_NoAllowlistConfigured_ReachesExecutorUnblocked(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec)) // testPolicy(): AllowlistedExtraCheck is nil, matching the real default
	spec := dockerSocketMountSpec()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if !resp.OK {
		t.Fatalf("FINDING NOT REPRODUCED (good, but re-check this test): expected the default (no -allowlist) kernel to ALLOW a Docker-socket mount classed allowlisted-extra, got denial %+v", resp.Error)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected the executor to be invoked once for the allowed wake, got %d calls", exec.wakeCalls)
	}
}

// TestWake_SSHPrivateKeyMount_NoAllowlistConfigured_ReachesExecutorUnblocked
// is the same finding against a second real blocked-pattern target
// (mount.go's own defaultBlockedPatterns lists ".ssh" first), confirming
// this is a property of the allowlisted-extra class having no default
// check at all, not an artifact of the Docker socket specifically.
func TestWake_SSHPrivateKeyMount_NoAllowlistConfigured_ReachesExecutorUnblocked(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := sshKeyMountSpec()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if !resp.OK {
		t.Fatalf("expected the default (no -allowlist) kernel to ALLOW an .ssh mount classed allowlisted-extra, got denial %+v", resp.Error)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected the executor to be invoked once for the allowed wake, got %d calls", exec.wakeCalls)
	}
}

// TestWake_DockerSocketMount_WithAllowlistConfigured_Denied is the control:
// it proves the fix for the previous two findings already exists and works
// — an operator who DOES pass -allowlist gets real protection, wired through
// mount.CheckAllowlistedExtra exactly as cmd/nanogo/serve.go's
// buildServeKernel wires it. A minimal, real allowlist file (one allowed
// root, none of which is /var/run or the caller's home directory) is
// written to a temp dir and loaded through the identical function
// buildServeKernel calls, not a hand-rolled stand-in — so this test would
// catch a regression in the real wiring path, not just in
// CheckAllowlistedExtra's own unit tests.
func TestWake_DockerSocketMount_WithAllowlistConfigured_Denied(t *testing.T) {
	allowlistPath := writeTempAllowlist(t, mount.Allowlist{
		AllowedRoots: []mount.AllowedRoot{
			{Path: "/data/operator-approved", AllowReadWrite: true},
		},
	})
	policy := testPolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return mount.CheckAllowlistedExtra(hostPath, allowlistPath)
	}
	exec := &fakeExecutor{}
	k := New(policy, withExecutor(exec))
	spec := dockerSocketMountSpec()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if resp.OK {
		t.Fatalf("expected an allowlist-configured kernel to DENY a Docker-socket mount, got %+v", resp)
	}
	if resp.Error.Code != ErrDenied {
		t.Fatalf("expected denied-by-policy (ErrDenied), got code %q", resp.Error.Code)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite the mount being denied (calls=%d)", exec.wakeCalls)
	}
}

// ---------- 2. root runAs ----------

// TestWake_RootRunAs_DeniedBeforeExec confirms containerdefaults.ValidateRunAs
// (P5-03) actually holds end-to-end: a wake request explicitly asserting
// RunAs{UID:0, GID:0, Set:true} — root — is denied before the executor is
// ever reached, closing the gap docker-driver.ts's own userArgs left open
// (spec.runAs passed straight to --user with no check at all).
func TestWake_RootRunAs_DeniedBeforeExec(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
		RunAs:      &containerdefaults.RunAs{UID: 0, GID: 0, Set: true},
	})

	if resp.OK {
		t.Fatalf("expected root runAs to be denied, got %+v", resp)
	}
	if resp.Error.Code != ErrDenied {
		t.Fatalf("expected denied-by-policy (ErrDenied), got code %q: %s", resp.Error.Code, resp.Error.Detail)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a root runAs request (calls=%d)", exec.wakeCalls)
	}
}

// TestWake_RootGID_OnlyUID_NonZero_StillDenied confirms the check is a real
// OR, not accidentally only checking UID: root group membership alone
// (uid 1000, gid 0) is exactly as denied as uid 0.
func TestWake_RootGID_OnlyUID_NonZero_StillDenied(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
		RunAs:      &containerdefaults.RunAs{UID: 1000, GID: 0, Set: true},
	})

	if resp.OK {
		t.Fatalf("expected uid=1000/gid=0 (root group) to be denied, got %+v", resp)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a root-group runAs request (calls=%d)", exec.wakeCalls)
	}
}

// ---------- 3. forged session/agent-group IDs (path traversal) ----------

// TestWake_ForgedAgentGroupID_PathTraversal_DeniedBeforeExec attempts the
// exact attack shape docs/threat-model-addendum-p5.md and internal/ownership's
// own package comment name: an agentGroupId containing "../" segments, which
// filepath.Join would silently collapse rather than reject if it ever
// reached internal/mailbox.Path or internal/session's DB paths unchecked.
// ownership.ValidateID (called from handleWake before the executor) is the
// closure for this at the kernel boundary.
func TestWake_ForgedAgentGroupID_PathTraversal_DeniedBeforeExec(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	spec.Key.AgentGroupID = "../../../../etc"

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if resp.OK {
		t.Fatalf("expected a path-traversal-shaped agentGroupId to be denied, got %+v", resp)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a forged agentGroupId (calls=%d)", exec.wakeCalls)
	}
}

// TestWake_ForgedSessionID_PathTraversal_DeniedBeforeExec is the same attack
// against sessionId instead of agentGroupId — the field internal/mailbox's
// path-building actually keys the innermost directory/file on.
func TestWake_ForgedSessionID_PathTraversal_DeniedBeforeExec(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	spec.Key.SessionID = "../../outside"

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if resp.OK {
		t.Fatalf("expected a path-traversal-shaped sessionId to be denied, got %+v", resp)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a forged sessionId (calls=%d)", exec.wakeCalls)
	}
}

// TestKill_ForgedSessionID_PathTraversal_DeniedBeforeExec confirms the same
// gate applies to container.kill's sessionId, independent of (before) the
// registry lookup that would separately deny an unknown session.
func TestKill_ForgedSessionID_PathTraversal_DeniedBeforeExec(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "../../../etc/passwd",
	})

	if resp.OK {
		t.Fatalf("expected a path-traversal-shaped sessionId to be denied, got %+v", resp)
	}
	if resp.Error.Code == ErrUnknownSession {
		t.Fatalf("expected denied-by-policy from ownership.ValidateID, not unknown-session from the registry lookup — the traversal shape itself must be rejected first, got code %q", resp.Error.Code)
	}
	if exec.killCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a forged sessionId (calls=%d)", exec.killCalls)
	}
}

// TestWake_ForgedSessionID_NulByte_DeniedBeforeExec: a NUL byte is not a
// path separator on any of this project's target platforms, but idRe's
// allowlist-not-denylist design (ownership.go's own doc comment names this
// exact byte as the reason it chose an allowlist) rejects it regardless of
// whether any current filepath-handling code would mishandle it.
func TestWake_ForgedSessionID_NulByte_DeniedBeforeExec(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	spec.Key.SessionID = "sess-1\x00../../etc"

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if resp.OK {
		t.Fatalf("expected a NUL-byte-shaped sessionId to be denied, got %+v", resp)
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was invoked despite a NUL-byte sessionId (calls=%d)", exec.wakeCalls)
	}
}

// ---------- 4. agent-group impersonation (documented v1 limit, not a bug) ----------

// TestWake_AgentGroupImpersonation_NotIndependentlyVerified_DocumentedLimit
// is deliberately named to describe what it PROVES, not "denied" or
// "allowed" — this is EC-05 exercising the exact accepted limit ADR-015
// already names: "actor identity itself... the TypeScript host process is
// the sole terminus of every per-container connection, and the kernel has
// no independent channel to 'which agent group is really asking'"
// (roadmap-to-v1.md's EC-04 entry, verbatim). A well-FORMED agentGroupId —
// one that passes ownership.ValidateID because it contains no traversal or
// illegal characters, e.g. one naming a real victim agent group rather than
// the caller's own — is not, and per the accepted-limit design cannot be,
// independently rejected at this boundary: GroupScope==AgentGroupID is
// purely internally self-consistent (mount.go's mountAllowed ClassGroupState
// case), never checked against who is actually asking. This test exists so
// that fact is pinned as executable, not just prose in an ADR someone could
// forget to re-read — if a future change ever added an independent actor
// check, this test would need to be updated to expect a denial, which is
// exactly the kind of change that should be deliberate and reviewed, not
// silent.
func TestWake_AgentGroupImpersonation_NotIndependentlyVerified_DocumentedLimit(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	// A well-formed id naming a plausible OTHER agent group — nothing
	// distinguishes it from the caller's own at this boundary.
	spec.Key.AgentGroupID = "victim-agent-group"
	spec.Labels[mount.GroupFolderLabel] = "victim-agent-group-folder"
	spec.Containers[0].Mounts = []mount.Spec{
		{
			Class:         mount.ClassGroupState,
			HostPath:      "/data/v2-sessions/victim-agent-group",
			ContainerPath: "/workspace/state",
			Mode:          mount.ModeRW,
			GroupScope:    "victim-agent-group",
		},
	}

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if !resp.OK {
		t.Fatalf("documented-limit test itself needs updating: expected this kernel version to allow a well-formed but unverified agentGroupId (matching ADR-015's accepted limit), got denial %+v — if this is now denied, an independent actor check was added and this comment/test should be revised to say so, not deleted", resp.Error)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected the executor to be invoked once, got %d calls", exec.wakeCalls)
	}
	// The practical mitigation this boundary actually relies on instead is
	// named in doc.go and server.go: the Unix socket is mode 0600, and only
	// the one TypeScript host process is ever meant to hold the other end of
	// it — see TestServe_SocketPermissions_Are0600 below for that half being
	// independently verified, not merely asserted in a comment.
}

// ---------- 5. malformed spec / role smuggling ----------

// TestWake_AuxiliaryContainerRole_Denied attempts to smuggle a second,
// non-agent-role container into the spec. mount.ValidateSpec does NOT reject
// this shape by itself — its agentCount check only requires exactly one
// Role=="agent" container to be present, and imposes no rule at all against
// an EXTRA, differently-roled sibling. The actual refusal is findAgentContainer
// (exec.go), which walks every container and rejects any Role other than
// "agent" outright, so this spec never even reaches the point of picking
// which container to realize.
//
// This is why this test deliberately uses the REAL dockerExecutor
// (newDockerExecutor), not this file's other tests' fakeExecutor: fakeExecutor
// ignores container roles entirely and would report a false ALLOW here,
// since nothing upstream of exec.go actually inspects them.
// findAgentContainer runs and returns its error before dockerExecutor.Wake
// ever calls d.runner (see exec.go: the error return happens before the
// first `docker create` argv is even built), so this proves the real refusal
// path with no live Docker daemon required. The denial is attributed to
// exec.go's own error code (ErrExecFailed, since findAgentContainer's error
// surfaces through Wake) rather than assumed identical to a mount.ValidateSpec
// denial (ErrDenied/ErrSpecInvalid).
func TestWake_AuxiliaryContainerRole_Denied(t *testing.T) {
	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	spec := validSession()
	spec.Containers = append(spec.Containers, mount.Container{Role: "sidecar", Env: map[string]string{}})

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})

	if resp.OK {
		t.Fatalf("expected a spec naming a non-agent container role to be denied, got %+v", resp)
	}
	if resp.Error.Code != ErrExecFailed {
		t.Fatalf("expected the denial to surface as ErrExecFailed (findAgentContainer's error, via dockerExecutor.Wake), got code %q: %s", resp.Error.Code, resp.Error.Detail)
	}
}

// TestWake_BuildImageFieldsIgnored_OnWakeRequest sends a container.wake
// request that ALSO sets every container.build_image-only field
// (AgentGroupID/GroupFolder/ImageTag/Dockerfile) alongside a real Session —
// exactly the shape a confused or malicious caller might send hoping one
// handler reads a field meant for another. CapabilityRequestPayload's own
// doc comment states unused fields for a given capability are "ignored,
// never treated as an alternate way to reach the exec"; this test proves it
// by confirming the wake succeeds (on its own Session's merits) and the
// executor's BuildImage is never invoked.
func TestWake_BuildImageFieldsIgnored_OnWakeRequest(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerWake,
		Session:      &spec,
		AgentGroupID: "not-the-real-one",
		GroupFolder:  "../../etc",
		ImageTag:     "not a legal tag at all!!",
		Dockerfile:   "FROM scratch\nRUN rm -rf /",
	})

	if !resp.OK {
		t.Fatalf("expected the wake to succeed on its own Session field, unaffected by build_image-only fields, got denial %+v", resp.Error)
	}
	if exec.buildCalls != 0 {
		t.Fatalf("SECURITY: BuildImage was invoked from a container.wake request (calls=%d)", exec.buildCalls)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly one Wake call, got %d", exec.wakeCalls)
	}
}

// TestBuildImage_MaliciousGroupFolder_PathTraversal_Denied attempts the
// build_image-side equivalent: a GroupFolder value that would, if joined
// unchecked, escape GroupsRoot as the build context directory
// (handleBuildImage's contextDir := filepath.Join(k.mountPolicy.GroupsRoot,
// req.GroupFolder)). mount.LabelValueLegal's character class ([A-Za-z0-9._-],
// alphanumeric at both ends) has no "/" in it at all, so this is rejected
// before filepath.Join ever runs.
func TestBuildImage_MaliciousGroupFolder_PathTraversal_Denied(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "../../../etc",
		ImageTag:     "nanoclaw-agent-v2-ab12cd34:group-xyz",
		Dockerfile:   "FROM alpine\n",
	})

	if resp.OK {
		t.Fatalf("expected a path-traversal-shaped groupFolder to be denied, got %+v", resp)
	}
	if exec.buildCalls != 0 {
		t.Fatalf("SECURITY: BuildImage was invoked with a path-traversal-shaped groupFolder (calls=%d)", exec.buildCalls)
	}
}

// ---------- 6. socket-level trust boundary ----------

// TestServe_SocketPermissions_Are0600 independently verifies the actual
// claim doc.go and server.go's Serve doc comment make — "mode 0600, created
// by and readable only by the host process's own user" — against a real
// socket file on the real filesystem, rather than trusting the os.Chmod
// call in server.go to have been written correctly and never regress. This
// is the practical mitigation TestWake_AgentGroupImpersonation... above
// notes the kernel actually relies on in place of independent actor
// verification, so it is worth its own direct proof.
func TestServe_SocketPermissions_Are0600(t *testing.T) {
	sockPath := shortSocketPath(t)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveErr := make(chan error, 1)
	go func() { serveErr <- k.Serve(ctx, sockPath) }()

	conn := dialWithRetry(t, sockPath)
	defer func() { _ = conn.Close() }()

	info, err := os.Stat(sockPath)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("SECURITY: kernel socket %s has mode %o, want exactly 0600 (readable/writable by owner only) — a broader mode would let any other local user on this machine reach every capability this boundary exposes", sockPath, perm)
	}
}

// ---------- helpers ----------

// writeTempAllowlist marshals allowlist to a temp JSON file and returns its
// path — used by TestWake_DockerSocketMount_WithAllowlistConfigured_Denied
// to exercise mount.CheckAllowlistedExtra's real file-loading path
// (mount.LoadAllowlist), not just its in-memory decision logic.
func writeTempAllowlist(t *testing.T, allowlist mount.Allowlist) string {
	t.Helper()
	data, err := json.Marshal(allowlist)
	if err != nil {
		t.Fatalf("marshal allowlist: %v", err)
	}
	path := t.TempDir() + "/mount-allowlist.json"
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write allowlist: %v", err)
	}
	return path
}
