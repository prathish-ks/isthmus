package kernel

// build_image_live_docker_test.go — the live-Docker leg `container.build_image`
// was missing.
//
// container.wake and container.kill both have a live-Docker proof against a
// real daemon: adversarial_live_docker_test.go (this package) for wake, and
// EC-07 (scripts/ec07-live-host-smoke.ts, go-host/docs/ADR-023) for kill.
// build_image had neither — every existing test (TestBuildImage_* in
// kernel_test.go, TestDockerExecutor_BuildImage_PipesDockerfileOnStdin in
// exec_test.go) uses a fakeExecutor/scripted stdin runner that never shells
// a real `docker build`. That is exactly the ADR-024 shape the 2026-09-24
// wiring/boundary audit flagged: a real, guard-gated, production-reachable
// capability with no test exercising it against anything real on either
// side of the TS/Go boundary — see docs/traceability.md's "End-to-end
// wiring / seam coverage" table and
// src/modules/self-mod/apply-install-packages.smoke.test.ts for the
// TypeScript-side half of the same closure.
//
// Gating: same opt-in as adversarial_live_docker_test.go
// (NANOCLAW_EC05_LIVE_DOCKER=1 + a responding daemon), reusing
// requireLiveDocker so this runs automatically inside the existing
// go-ec05-live-docker CI job (`go test ./internal/kernel/... -run TestLive`)
// with no ci.yml change needed.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// buildImagePolicy returns a policy whose GroupsRoot is a real, existing
// temp directory containing one group folder — handleBuildImage derives the
// build context as filepath.Join(GroupsRoot, GroupFolder) and hands that
// path straight to `docker build`, which requires the context directory to
// actually exist on disk even though the Dockerfile body itself is piped on
// stdin (see exec.go's BuildImage doc comment). testPolicy()'s fixed
// "/data/groups" is fine for the fake-executor unit tests but does not
// exist on this machine, so a live build needs its own policy.
func buildImagePolicy(t *testing.T, groupFolder string) mount.Policy {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, groupFolder), 0o750); err != nil {
		t.Fatalf("mkdir group folder: %v", err)
	}
	policy := testPolicy()
	policy.GroupsRoot = root
	return policy
}

// dockerImageExists shells `docker image inspect` directly — independent of
// this package's own ImageID bookkeeping — the same "don't trust the
// component under test to grade its own homework" discipline
// dockerInspectMounts uses for wake, in adversarial_live_docker_test.go.
func dockerImageExists(t *testing.T, tag string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- tag is always a fixed test-fixture literal here, never
	// external/attacker-controlled input.
	err := exec.CommandContext(ctx, "docker", "image", "inspect", tag).Run() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return err == nil
}

func removeDockerImage(t *testing.T, tag string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// #nosec G204 -- tag is always a fixed test-fixture literal here, never
	// external/attacker-controlled input.
	_ = exec.CommandContext(ctx, "docker", "image", "rm", "-f", tag).Run() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
}

// TestLive_BuildImage_RealDockerBuildProducesRealTaggedImage is this file's
// headline case: a container.build_image request reaches a REAL `docker
// build`, and the resulting image genuinely exists under the requested tag
// — not just that the in-process response said Allowed:true (which
// TestBuildImage_Success in kernel_test.go already proves against
// fakeExecutor, without needing a live daemon).
func TestLive_BuildImage_RealDockerBuildProducesRealTaggedImage(t *testing.T) {
	requireLiveDocker(t)

	const groupFolder = "live-build-smoke"
	policy := buildImagePolicy(t, groupFolder)
	k := New(policy, withExecutor(newDockerExecutor("")))

	imageTag := "isthmus-live-build-smoke:test"
	t.Cleanup(func() { removeDockerImage(t, imageTag) })

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-live-build-smoke",
		GroupFolder:  groupFolder,
		ImageTag:     imageTag,
		// alpine:3 is already the base liveAgentSession uses elsewhere in
		// this package, so it's already warm in any CI runner that has run
		// the wake live-Docker tests in the same job.
		Dockerfile: "FROM alpine:3\nRUN echo isthmus-live-build-smoke > /build-marker\n",
	})
	if !resp.OK {
		t.Fatalf("expected a real docker build to succeed, got denial %+v", resp.Error)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if payload.ImageID != imageTag {
		t.Fatalf("expected ImageID %q (dockerExecutor.BuildImage returns the tag itself), got %q", imageTag, payload.ImageID)
	}

	if !dockerImageExists(t, imageTag) {
		t.Fatalf("SECURITY/WIRING FINDING: kernel reported a successful build (Allowed:true, ImageID %q) but `docker image inspect %s` found nothing — the response does not reflect reality", imageTag, imageTag)
	}
	t.Logf("CONFIRMED LIVE: container.build_image produced a real image tagged %s", imageTag)
}

// TestLive_BuildImage_IllegalImageTag_NeverReachesDocker is the live-Docker
// control: a malformed tag is denied before dockerExecutor.BuildImage ever
// runs, confirmed here by asserting no image under that tag exists
// afterward — not merely that resp.OK was false (which
// TestBuildImage_RejectsIllegalTag in kernel_test.go already proves without
// a live daemon). Mirrors
// TestLive_Wake_DockerSocketMount_WithAllowlistConfigured_NeverReachesDocker's
// "prove the denial by absence, not just by the in-process response" shape.
func TestLive_BuildImage_IllegalImageTag_NeverReachesDocker(t *testing.T) {
	requireLiveDocker(t)

	const groupFolder = "live-build-illegal-tag"
	policy := buildImagePolicy(t, groupFolder)
	k := New(policy, withExecutor(newDockerExecutor("")))

	// Uppercase and a leading slash are both illegal per legalTagFragment
	// and per Docker's own reference-name rules — chosen so this fails
	// capability.go's regex check, not a real `docker build`'s own tag
	// validation, keeping the two failure modes from being confused.
	illegalTag := "/Not-A-Legal-Tag"

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-live-build-illegal-tag",
		GroupFolder:  groupFolder,
		ImageTag:     illegalTag,
		Dockerfile:   "FROM alpine:3\n",
	})
	if resp.OK {
		t.Cleanup(func() { removeDockerImage(t, illegalTag) })
		t.Fatalf("expected an illegal image tag to be denied before reaching Docker, got success %+v", resp)
	}
	if resp.Error == nil || resp.Error.Code != ErrDenied {
		t.Fatalf("expected ErrDenied, got %+v", resp.Error)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- illegalTag is a fixed test-fixture literal, never
	// external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", "image", "inspect", illegalTag).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err == nil {
		t.Fatalf("SECURITY: `docker image inspect %s` succeeded despite the build being denied — a real image was created: %s", illegalTag, strings.TrimSpace(string(out)))
	}
}
