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
// NOT executed or verified by this promotion's own work session (no Docker
// daemon in that sandbox — see the "What 'the gate passed' means" section
// of docs/promotion-v2.4.0.md and this project's own established "real CI
// evidence over local" principle). Written carefully against
// mount_confinement_live_docker_test.go's exact conventions and reviewed
// for correctness, but its first real verification has to be an actual CI
// run (or a machine with Docker) — same "correct by careful reading,
// confirmed on real infrastructure later" posture already applied
// elsewhere in this package's live-Docker suite.

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
	if !dockerExecOK(t, payload.ContainerName, 5*time.Second, "nslookup", "gateway-proxy") {
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
