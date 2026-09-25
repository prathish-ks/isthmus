package kernel

// credential_boundary_live_docker_test.go closes the highest-priority
// finding from the 2026-09-24 boundary/containment audit (distinct from the
// wiring/seam audit that produced build_image_live_docker_test.go): the
// claim "credentials never land in a container's env" (CLAUDE.md, the
// OneCLI docs) rested entirely on in-process unit tests of
// mount.ValidateSpec's ContributedEnv loop — and EC-07/EC-08
// (scripts/ec07-live-host-smoke.ts, scripts/ec08-egress-lockdown-live-smoke.ts)
// *actively stub* the gateway's credential contribution to
// `{ env: {}, mounts: [] }` specifically to avoid exercising it. Nothing had
// ever spawned a REAL container and inspected its REAL environment to
// confirm the property actually holds at runtime — the same
// decided-but-unverified shape ADR-024 found for egress lockdown, before
// EC-08 closed it with a live assertion instead of a code-reading one.
//
// The check under test: mount.ValidateSpec denies a wake whose
// ContributedEnv carries a value LooksLikeCredential (internal/mount's
// regex heuristics — sk-…, ghp_…, AKIA…, a JWT, a PEM block, etc.) BEFORE
// dockerExecutor.Wake ever runs. That decision is already unit-tested
// (mount's own test file). This file proves it live: a credential-shaped
// contributed-env value never reaches a real `docker create`, confirmed by
// `docker inspect` finding no such container — and, as the positive
// control, an ordinary (non-credential-shaped) contributed env value DOES
// land in a real container's real environment, so the negative case is
// known to prove something rather than passing by construction.
//
// Gating: same opt-in as adversarial_live_docker_test.go and
// build_image_live_docker_test.go (NANOCLAW_EC05_LIVE_DOCKER=1 + a
// responding daemon), so this runs automatically inside the existing
// go-ec05-live-docker CI job with no ci.yml change.

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// dockerInspectEnv runs `docker inspect <name> --format {{json .Config.Env}}`
// — independent of this package's own bookkeeping, same "don't trust the
// component under test to grade its own homework" discipline
// dockerInspectMounts uses.
func dockerInspectEnv(t *testing.T, containerName string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- containerName is always derived from ContainerName(spec.Key)
	// on a fixed test fixture, never from external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", "inspect", containerName, "--format", "{{json .Config.Env}}").CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Fatalf("docker inspect %s: %v: %s", containerName, err, strings.TrimSpace(string(out)))
	}
	var env []string
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatalf("unmarshal docker inspect env output %q: %v", strings.TrimSpace(string(out)), err)
	}
	return env
}

// TestLive_Wake_CredentialShapedContributedEnv_NeverReachesDocker is this
// file's headline finding: a wake whose gateway-style ContributedEnv value
// looks like a real Anthropic API key is denied before any real `docker
// create` runs — proven by asserting no container with the kernel-derived
// name exists afterward, not merely that the in-process resp.OK was false.
func TestLive_Wake_CredentialShapedContributedEnv_NeverReachesDocker(t *testing.T) {
	requireLiveDocker(t)

	spec := liveAgentSession(t, mount.Spec{}) // no extra mount; the finding here is about env, not mounts
	spec.Containers[0].Mounts = nil
	spec.Containers[0].ContributedEnv = map[string]string{
		// Matches internal/mount's credSkRe (`^sk-[A-Za-z0-9_-]{20,}$`) —
		// the exact shape a real Anthropic/OpenAI-style API key has. A
		// fabricated test value, never a real credential.
		"ANTHROPIC_API_KEY": "sk-ant-api03-0000000000000000000000000000000000000000",
	}
	wantName := ContainerName(spec.Key)

	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if resp.OK {
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = newDockerExecutor("").Kill(ctx, wantName, nil, "", 1)
		})
		t.Fatalf("SECURITY: expected a credential-shaped contributed-env value to be denied, got success %+v", resp)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- wantName is derived via ContainerName(spec.Key) from a
	// fixed test fixture, never external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", "inspect", wantName).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err == nil {
		t.Fatalf("SECURITY: `docker inspect %s` succeeded despite the wake being denied — a real container was created with a credential-shaped env value: %s", wantName, strings.TrimSpace(string(out)))
	}
	t.Logf("CONFIRMED LIVE: no container named %s exists — the credential-shaped ContributedEnv value never reached Docker", wantName)
}

// TestLive_Wake_OrdinaryContributedEnv_LandsInRealContainerEnv is the
// positive control: a legitimate, non-credential-shaped contributed-env
// value (the normal case — a provider registering a non-secret setting)
// DOES land in the real container's real environment. Without this, the
// denial test above could pass for the wrong reason (e.g. ContributedEnv
// being silently dropped entirely, rather than the specific credential
// heuristic firing).
func TestLive_Wake_OrdinaryContributedEnv_LandsInRealContainerEnv(t *testing.T) {
	requireLiveDocker(t)

	spec := liveAgentSession(t, mount.Spec{})
	spec.Containers[0].Mounts = nil
	spec.Containers[0].ContributedEnv = map[string]string{
		"ONECLI_GATEWAY_MODE": "proxy",
	}

	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if !resp.OK {
		t.Fatalf("expected an ordinary contributed-env value to be allowed, got denial %+v", resp.Error)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = newDockerExecutor("").Kill(ctx, payload.ContainerName, nil, "", 1)
	})

	env := dockerInspectEnv(t, payload.ContainerName)
	found := false
	for _, e := range env {
		if e == "ONECLI_GATEWAY_MODE=proxy" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected ONECLI_GATEWAY_MODE=proxy in the real container's env, got %v", env)
	}
	t.Logf("CONFIRMED LIVE: ordinary contributed env landed in the real container's real environment")
}
