package kernel

// adversarial_live_docker_test.go complements adversarial_test.go's
// TestWake_DockerSocketMount_NoAllowlistConfigured_ReachesExecutorUnblocked
// and its .ssh sibling: those two prove the validation-layer gap ("the
// kernel's own Dispatch path allows the mount through and invokes
// executor.Wake") using fakeExecutor, which never runs a real `docker`
// command. That is sufficient to prove the VALIDATION bypass, but EC-05's
// own text (roadmap-to-v1.md) asks for the misuse cases to be attempted
// "against the real kernel enforcement path" end-to-end — so this file goes
// one step further and runs the real dockerExecutor against a real Docker
// daemon: it actually creates a container with the host's Docker socket
// bind-mounted, confirms via `docker inspect` that the mount is real (not
// just that Go's validator returned nil), then tears the container down.
//
// This is deliberately split from adversarial_test.go rather than folded in,
// for two reasons named in that file's own package doc comment: (1) it has
// real side effects on whatever machine runs it — creating and destroying
// an actual container — which the rest of this package's tests never do,
// and (2) it requires a running Docker daemon, which most CI environments
// and this project's own sandbox do not have (see doctor.go's
// checkContainerRuntime for the project's existing "docker present but
// daemon unreachable" distinction, reused below).
//
// Gating: skipped unless NANOCLAW_EC05_LIVE_DOCKER=1 is set in the
// environment AND a Docker daemon actually responds. Both conditions are
// deliberate: the env var is an explicit opt-in (this test's side effects
// should never surprise a plain `go test ./...` run), and the daemon check
// means a developer who sets the env var on a machine without Docker
// running gets a clear skip reason instead of a confusing failure.
//
// Run explicitly with:
//
//	NANOCLAW_EC05_LIVE_DOCKER=1 go test ./internal/kernel/... -run TestLive -v

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

const liveDockerOptInEnv = "NANOCLAW_EC05_LIVE_DOCKER"

// requireLiveDocker skips the calling test unless the opt-in env var is set
// and a real Docker daemon responds — mirroring doctor.go's
// checkContainerRuntime check (LookPath, then `docker info`) rather than
// inventing a second convention for the same fact.
func requireLiveDocker(t *testing.T) {
	t.Helper()
	if os.Getenv(liveDockerOptInEnv) != "1" {
		t.Skipf("skipping live-Docker EC-05 test: set %s=1 to run it (it creates and destroys a real container)", liveDockerOptInEnv)
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("skipping live-Docker EC-05 test: docker not found on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// name and every arg here are fixed string literals — nothing
	// caller/environment-controlled reaches this argv.
	out, err := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}").CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Skipf("skipping live-Docker EC-05 test: docker daemon did not respond: %s", strings.TrimSpace(string(out)))
	}
}

// dockerInspectMounts runs `docker inspect <name> --format {{json .Mounts}}`
// and decodes the resulting JSON array of Docker's own inspect Mount shape
// (Source/Destination/Mode are the fields this test needs; the rest ride
// along unused via the map).
func dockerInspectMounts(t *testing.T, containerName string) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- name/args are fixed except containerName, which every
	// caller of this helper derives from ContainerName(spec.Key) on a
	// fixed test fixture, never from external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", "inspect", containerName, "--format", "{{json .Mounts}}").CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Fatalf("docker inspect %s: %v: %s", containerName, err, strings.TrimSpace(string(out)))
	}
	var mounts []map[string]any
	if err := json.Unmarshal(out, &mounts); err != nil {
		t.Fatalf("unmarshal docker inspect mounts output %q: %v", strings.TrimSpace(string(out)), err)
	}
	return mounts
}

// liveAgentSession builds a real, launchable session: unlike
// adversarial_test.go's specs (which only need to survive validation, since
// fakeExecutor never actually launches anything), this one needs an Image
// and Command a real `docker create`/`docker start` can run, plus the one
// mount under test.
func liveAgentSession(t *testing.T, extraMount mount.Spec) mount.Session {
	t.Helper()
	spec := validSession()
	spec.Containers[0].Image = "alpine:3"
	// Long enough to comfortably survive `docker create`+`docker start`+
	// `docker inspect` (a few seconds on a warm image cache), short enough
	// that a test that forgets to clean up doesn't leave something running
	// for long. t.Cleanup below stops/removes it regardless.
	spec.Containers[0].Command = []string{"sleep", "20"}
	spec.Containers[0].Mounts = []mount.Spec{extraMount}
	return spec
}

// TestLive_Wake_DockerSocketMount_NoAllowlistConfigured_RealContainerGetsSocket
// is this pass's headline finding, proved end-to-end: with NO -allowlist
// configured (testPolicy()'s default, matching cmd/nanogo serve's own
// default), a container.wake request mounting the real host Docker socket
// (classed allowlisted-extra) is not just "allowed by the Go validator" —
// dockerExecutor.Wake runs a REAL `docker create -v
// /var/run/docker.sock:/var/run/docker.sock ...`, and `docker inspect`
// confirms the resulting container actually has that bind mount. A
// container with the host's own Docker socket reachable can create sibling
// containers with arbitrary host mounts and capabilities — full host
// compromise from inside a supposedly-sandboxed agent container, the same
// primitive OpenClaw's CVE-2026-27002 exploited.
func TestLive_Wake_DockerSocketMount_NoAllowlistConfigured_RealContainerGetsSocket(t *testing.T) {
	requireLiveDocker(t)

	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	spec := liveAgentSession(t, mount.Spec{
		Class:         mount.ClassAllowlistedExtra,
		HostPath:      "/var/run/docker.sock",
		ContainerPath: "/var/run/docker.sock",
		Mode:          mount.ModeRW,
	})

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if !resp.OK {
		t.Fatalf("FINDING NOT REPRODUCED (good, but re-check this test): expected the default (no -allowlist) kernel to allow and successfully realize a Docker-socket mount, got denial %+v", resp.Error)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if payload.ContainerName == "" {
		t.Fatalf("expected a non-empty containerName from a successful wake, got %+v", payload)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = newDockerExecutor("").Kill(ctx, payload.ContainerName, 1)
	})

	mounts := dockerInspectMounts(t, payload.ContainerName)
	found := false
	for _, m := range mounts {
		if m["Source"] == "/var/run/docker.sock" && m["Destination"] == "/var/run/docker.sock" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("SECURITY FINDING NOT CONFIRMED LIVE: expected `docker inspect` to show /var/run/docker.sock bind-mounted into %s, got mounts %+v", payload.ContainerName, mounts)
	}
	t.Logf("CONFIRMED LIVE: container %s was created with the host Docker socket bind-mounted rw, with no -allowlist configured", payload.ContainerName)
}

// TestLive_Wake_DockerSocketMount_WithAllowlistConfigured_NeverReachesDocker
// is the live-Docker control for the fix: with an operator-configured
// allowlist that does NOT cover /var/run/docker.sock, the wake is denied
// before dockerExecutor.Wake ever runs — confirmed here by asserting no
// container by the name the kernel would have used exists afterward, not
// merely that the in-process resp.OK was false (which
// TestWake_DockerSocketMount_WithAllowlistConfigured_Denied in
// adversarial_test.go already proves without needing a live daemon).
func TestLive_Wake_DockerSocketMount_WithAllowlistConfigured_NeverReachesDocker(t *testing.T) {
	requireLiveDocker(t)

	allowlistPath := writeTempAllowlist(t, mount.Allowlist{
		AllowedRoots: []mount.AllowedRoot{{Path: "/data/operator-approved", AllowReadWrite: true}},
	})
	policy := testPolicy()
	policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
		return mount.CheckAllowlistedExtra(hostPath, allowlistPath)
	}
	k := New(policy, withExecutor(newDockerExecutor("")))
	spec := liveAgentSession(t, mount.Spec{
		Class:         mount.ClassAllowlistedExtra,
		HostPath:      "/var/run/docker.sock",
		ContainerPath: "/var/run/docker.sock",
		Mode:          mount.ModeRW,
	})
	wantName := ContainerName(spec.Key)

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if resp.OK {
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = newDockerExecutor("").Kill(ctx, wantName, 1)
		})
		t.Fatalf("expected an allowlist-configured kernel to deny the Docker-socket mount, got success %+v", resp)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- name/args are fixed except wantName, which this test
	// derives itself via ContainerName(spec.Key) from a fixed test fixture,
	// never from external/attacker-controlled input; this is the same
	// pattern doctor.go/exec.go use elsewhere in this project for the
	// identical reason.
	out, err := exec.CommandContext(ctx, "docker", "inspect", wantName).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err == nil {
		t.Fatalf("SECURITY: `docker inspect %s` succeeded despite the wake being denied — a real container was created: %s", wantName, strings.TrimSpace(string(out)))
	}
}
