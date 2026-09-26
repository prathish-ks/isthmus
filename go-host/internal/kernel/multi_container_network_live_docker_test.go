package kernel

// multi_container_network_live_docker_test.go is Workstream A5 of the
// v2.4.0 promotion (docs/promotion-v2.4.0.md): live-Docker proof for A3's
// multi-container/network executor. Everything A3 itself unit-tested
// (network create, container create, network connect, start ordering,
// rollback) was proved against a fake `docker` runner recording argv —
// real, valuable coverage of "does this code construct the right
// commands," but not "does a real Docker daemon actually realize the
// isolation those commands claim to produce." This file closes that gap,
// mirroring mount_confinement_live_docker_test.go's own "requested vs.
// actually observed, from a real container, via a real daemon" standard
// for the mount-confinement case.
//
// Verified against a real daemon both locally (this sandbox, once Docker
// became available — repeatedly, `-count=1`, no caching) and on real
// GitHub Actions CI (see "real CI evidence over local" — this project's
// own standing principle). The first CI run genuinely caught something
// local runs hadn't: TestLive_Wake_MultiContainerSession_
// PrivateNetworkIsolatesAgentAndReachesProxy's own alias-resolution check
// failed once on a GitHub Actions runner with no local reproduction —
// root-caused to a Docker embedded-DNS propagation race the runner's
// daemon exposed and the local one didn't happen to (see
// dockerExecOKEventually's own comment). Fixed with a short poll instead
// of a single attempt, re-verified 3x fresh locally and re-run on CI.

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// dockerNetworkInspect returns the named network's real, live inspect
// output — the same "requested vs. observed" oracle dockerInspectMounts
// already is for container mounts, applied to the network this test's
// headline case creates.
func dockerNetworkInspect(t *testing.T, networkName string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// #nosec G204 -- name/args are fixed except networkName, which every
	// caller of this helper derives from sessionNetworkName(spec.Key) on a
	// fixed test fixture, never from external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", "network", "inspect", networkName).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Fatalf("docker network inspect %s: %v: %s", networkName, err, strings.TrimSpace(string(out)))
	}
	var results []map[string]any
	if err := json.Unmarshal(out, &results); err != nil {
		t.Fatalf("unmarshal docker network inspect output %q: %v", strings.TrimSpace(string(out)), err)
	}
	if len(results) != 1 {
		t.Fatalf("expected exactly one network named %s, got %d", networkName, len(results))
	}
	return results[0]
}

// dockerExecOK runs a command inside a real container and reports only
// whether it succeeded — the live, from-inside half of a reachability
// claim, independent of anything this package's own network-construction
// logic believes it built.
func dockerExecOK(t *testing.T, containerName string, timeout time.Duration, args ...string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	full := append([]string{"exec", containerName}, args...)
	// #nosec G204 -- containerName is kernel-derived from a fixed test
	// fixture; the remaining args are fixed string literals at every call
	// site below. Neither is external/attacker-controlled input.
	_, err := exec.CommandContext(ctx, "docker", full...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return err == nil
}

// dockerExecOKEventually retries dockerExecOK for up to totalTimeout,
// polling every 250ms. Real-world root cause this exists for (found on a
// GitHub Actions run, not reproduced on the slower/warmer local daemon this
// test was first written and verified against): Docker's embedded DNS
// (127.0.0.11) registers a newly `network connect`-ed container's alias
// asynchronously relative to that connect call returning — both containers
// here are already started by the time this test runs its own checks (Wake
// starts auxiliaries before the agent), so the alias itself is correctly
// configured; what's not guaranteed is that the daemon's DNS server has
// finished propagating it the instant the agent's own process starts
// resolving. A single immediate nslookup can lose that race on a slower or
// more heavily loaded daemon; polling for a few seconds tolerates the
// propagation window without weakening what the check actually proves —
// it still fails for real (a name that genuinely never resolves, like
// check 3 below, exhausts every retry and fails exactly the same as a
// single attempt would).
func dockerExecOKEventually(t *testing.T, containerName string, totalTimeout time.Duration, args ...string) bool {
	t.Helper()
	deadline := time.Now().Add(totalTimeout)
	for {
		if dockerExecOK(t, containerName, 2*time.Second, args...) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// multiContainerLiveSession builds a real, launchable two-container
// session — an agent plus one auxiliary "proxy" role, with a
// session-container networkAccess target naming it (the shape A3's
// validateNetworkAccessTarget requires for the network/auxiliary path to
// engage at all). Mirrors liveAgentSession's own realism bar: real images,
// real (short-lived, cleaned-up-by-t.Cleanup) commands.
func multiContainerLiveSession(t *testing.T) mount.Session {
	t.Helper()
	spec := validSession()
	spec.Containers[0].Image = "alpine:3"
	spec.Containers[0].Command = []string{"sleep", "20"}
	spec.Containers = append(spec.Containers, mount.Container{
		Role:    "proxy",
		Env:     map[string]string{},
		Image:   "alpine:3",
		Command: []string{"sleep", "20"},
	})
	spec.NetworkAccess = mount.NetworkAccessIntent{
		Endpoint: "gateway-proxy",
		Target:   mount.NetworkAccessTarget{Kind: mount.NetworkTargetSessionContainer, Role: "proxy"},
	}
	return spec
}

// TestLive_Wake_MultiContainerSession_PrivateNetworkIsolatesAgentAndReachesProxy
// is this file's headline case, proving A3's core security claim for real:
// a multi-container session's agent container can reach its own auxiliary
// (proxy) container by the alias networkAccess named, but CANNOT reach the
// outside internet directly — the --internal network flag's actual,
// observed effect, not just its presence in the generated argv (A3's own
// unit tests already confirmed the argv; this confirms the daemon honors
// it).
func TestLive_Wake_MultiContainerSession_PrivateNetworkIsolatesAgentAndReachesProxy(t *testing.T) {
	requireLiveDocker(t)

	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	spec := multiContainerLiveSession(t)

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if !resp.OK {
		t.Fatalf("expected a valid multi-container session to be allowed, got denial %+v", resp.Error)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	wantNetwork := sessionNetworkName(spec.Key)
	wantAuxiliaryName := auxiliaryContainerName(spec.Key, "proxy")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = newDockerExecutor("").Kill(ctx, payload.ContainerName, []string{wantAuxiliaryName}, wantNetwork, 1)
	})

	// 1. The private network genuinely exists and is --internal (Docker's
	// own "Internal" inspect field, not this package's own belief about
	// what it asked for).
	network := dockerNetworkInspect(t, wantNetwork)
	if internal, _ := network["Internal"].(bool); !internal {
		t.Fatalf("expected the session's private network to be Internal:true, got: %+v", network["Internal"])
	}
	containers, _ := network["Containers"].(map[string]any)
	if len(containers) != 2 {
		t.Fatalf("expected exactly 2 containers on the private network (agent + auxiliary), got %d: %+v", len(containers), containers)
	}

	// 2. The agent, from inside the real container, CAN reach the
	// auxiliary by the alias networkAccess.Endpoint named — the actual
	// gateway-reachability path this whole mechanism exists to provide.
	// `nslookup` over `getent`: it's a standard, universally-present
	// busybox applet (getent's presence in a minimal Alpine image is less
	// certain), and Docker's own embedded DNS at 127.0.0.11 is exactly
	// what resolves a user-defined network's container aliases — a
	// successful resolution here is real, daemon-mediated confirmation of
	// network membership and the alias, not an inference from argv.
	//
	// Polled rather than a single attempt: see dockerExecOKEventually's own
	// comment for the real DNS-propagation race this tolerates.
	if !dockerExecOKEventually(t, payload.ContainerName, 10*time.Second, "nslookup", "gateway-proxy") {
		t.Fatal("expected the agent to resolve its auxiliary container's alias (gateway-proxy) on the shared private network")
	}

	// 3. The agent CANNOT reach the outside internet directly — the actual
	// security property --internal exists to provide, confirmed from
	// inside the real container rather than inferred from the network's
	// own Internal:true flag alone. An --internal network's embedded DNS
	// has no upstream resolver to forward an unrecognized name to, so this
	// should fail fast (not hang) rather than time out.
	if dockerExecOK(t, payload.ContainerName, 5*time.Second, "nslookup", "one.one.one.one") {
		t.Fatal("SECURITY: expected the agent, on an --internal private network with no upstream DNS route, to be unable to resolve a real external host")
	}

	t.Logf("CONFIRMED LIVE: private network %s is Internal:true with exactly 2 members; agent %s reaches auxiliary %s by alias but not the outside internet", wantNetwork, payload.ContainerName, wantAuxiliaryName)
}

// TestLive_Wake_MultiContainerSession_AuxiliaryIsReadOnly proves A3's other
// new hardening property for real: the auxiliary container's root
// filesystem is genuinely read-only from inside it, not merely requested
// --read-only in the argv A3's unit tests already checked.
func TestLive_Wake_MultiContainerSession_AuxiliaryIsReadOnly(t *testing.T) {
	requireLiveDocker(t)

	k := New(testPolicy(), withExecutor(newDockerExecutor("")))
	spec := multiContainerLiveSession(t)

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if !resp.OK {
		t.Fatalf("expected a valid multi-container session to be allowed, got denial %+v", resp.Error)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	wantNetwork := sessionNetworkName(spec.Key)
	wantAuxiliaryName := auxiliaryContainerName(spec.Key, "proxy")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = newDockerExecutor("").Kill(ctx, payload.ContainerName, []string{wantAuxiliaryName}, wantNetwork, 1)
	})

	if dockerExecOK(t, wantAuxiliaryName, 5*time.Second, "sh", "-c", "echo x > /root-write-test") {
		t.Fatal("SECURITY: expected the auxiliary container's root filesystem to be genuinely read-only from inside it")
	}
	// Confirm the container is actually reachable at all (so the write
	// failure above is evidence of read-only, not evidence the exec itself
	// never landed) by running a command that only reads.
	if !dockerExecOK(t, wantAuxiliaryName, 5*time.Second, "true") {
		t.Fatal("auxiliary container did not respond to docker exec at all — the write-failure check above is not meaningful without this")
	}
}
