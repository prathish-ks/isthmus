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

// dockerExecResult runs a command inside a real container and returns
// whether it succeeded plus its combined stdout/stderr — the live,
// from-inside half of a reachability claim, independent of anything this
// package's own network-construction logic believes it built. The output
// is kept (not discarded) so a caller can log it on failure — necessary to
// actually diagnose a failure on a CI runner nobody can attach a debugger
// to.
func dockerExecResult(t *testing.T, containerName string, timeout time.Duration, args ...string) (ok bool, output string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	full := append([]string{"exec", containerName}, args...)
	// #nosec G204 -- containerName is kernel-derived from a fixed test
	// fixture; the remaining args are fixed string literals at every call
	// site below. Neither is external/attacker-controlled input.
	out, err := exec.CommandContext(ctx, "docker", full...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return err == nil, strings.TrimSpace(string(out))
}

// dockerExecOK is dockerExecResult without the output, for the (majority
// of) call sites that only care about success/failure.
func dockerExecOK(t *testing.T, containerName string, timeout time.Duration, args ...string) bool {
	t.Helper()
	ok, _ := dockerExecResult(t, containerName, timeout, args...)
	return ok
}

// dockerExecOKEventually retries dockerExecResult for up to totalTimeout,
// polling every 250ms, returning the last attempt's output either way (so a
// caller can log it whether the final result was success or failure).
//
// This exists because a single immediate attempt failed once on a GitHub
// Actions run with no local reproduction — first suspected as Docker's
// embedded DNS (127.0.0.11) registering a newly `network connect`-ed
// container's alias asynchronously relative to that connect call
// returning. A 10s version of this retry loop was tried next and *still*
// failed on CI, for the entire window, not just an initial attempt — which
// argues against pure propagation lag (that would resolve within a couple
// of retries, not exhaust 10 seconds) and toward something more structural
// in that environment's Docker networking that a longer wait alone may not
// fix. This version widens the window further (a cheap hedge, in case the
// lag genuinely is just longer than expected there) but more importantly
// keeps every attempt's raw output so the caller can log the actual
// nslookup/getent failure text and container network state on the next
// failure, instead of guessing a third time from a bare pass/fail.
func dockerExecOKEventually(t *testing.T, containerName string, totalTimeout time.Duration, args ...string) (ok bool, lastOutput string) {
	t.Helper()
	deadline := time.Now().Add(totalTimeout)
	for {
		ok, lastOutput = dockerExecResult(t, containerName, 2*time.Second, args...)
		if ok {
			return true, lastOutput
		}
		if time.Now().After(deadline) {
			return false, lastOutput
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// logNetworkDiagnostics dumps everything this package's own live-Docker
// suite can cheaply observe about a session's private network and its two
// containers' actual network state — for t.Log, not t.Fatal, so it runs
// only when explicitly called (on a failure path) and never fails the test
// itself if any individual probe does. Exists so a CI failure comes with
// enough real data to root-cause it (raw resolver output, actual assigned
// aliases/IPs, DNS config inside the container) instead of triggering
// another guess-and-push cycle.
func logNetworkDiagnostics(t *testing.T, networkName, agentContainer, auxiliaryContainer string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := func(name string, args ...string) {
		// #nosec G204 -- every argument here is a fixed literal or one of
		// this test's own kernel-derived container/network names, never
		// external input.
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
		t.Logf("DIAGNOSTIC %s (err=%v):\n%s", name, err, strings.TrimSpace(string(out)))
	}
	run("network inspect", "network", "inspect", networkName)
	run("agent inspect NetworkSettings", "inspect", "--format", "{{json .NetworkSettings.Networks}}", agentContainer)
	run("auxiliary inspect NetworkSettings", "inspect", "--format", "{{json .NetworkSettings.Networks}}", auxiliaryContainer)
	run("agent resolv.conf", "exec", agentContainer, "cat", "/etc/resolv.conf")
	getentOK, getentOut := dockerExecResult(t, agentContainer, 5*time.Second, "getent", "hosts", "gateway-proxy")
	t.Logf("DIAGNOSTIC agent getent hosts gateway-proxy (ok=%v):\n%s", getentOK, getentOut)
	run("agent logs", "logs", "--tail", "20", agentContainer)
	run("auxiliary logs", "logs", "--tail", "20", auxiliaryContainer)
}

// multiContainerLiveSession builds a real, launchable two-container
// session — an agent plus one auxiliary "proxy" role, with a
// session-container networkAccess target naming it (the shape A3's
// validateNetworkAccessTarget requires for the network/auxiliary path to
// engage at all). Mirrors liveAgentSession's own realism bar: real images,
// real (short-lived, cleaned-up-by-t.Cleanup) commands.
//
// The 90s sleep is deliberately much longer than any check this file runs
// against these containers (dockerExecOKEventually's own retry window is
// 20s) — found the hard way: an earlier version used a 20s sleep, which
// raced dockerExecOKEventually's own then-20s deadline, so a deliberately
// forced failure (to verify logNetworkDiagnostics itself produces useful
// output) surfaced "No such container" instead of the intended DNS
// diagnostics, because the container had already exited from old age by
// the time the retry loop gave up. Not itself the root cause of the real
// CI failure (that one failed resolving the *correct* name inside a 10s
// window, comfortably under the old sleep's remaining lifetime) — but a
// real, separate bug this file should not carry regardless, and one that
// would have made a genuine future failure's diagnostics equally useless.
func multiContainerLiveSession(t *testing.T) mount.Session {
	t.Helper()
	spec := validSession()
	spec.Containers[0].Image = "alpine:3"
	spec.Containers[0].Command = []string{"sleep", "90"}
	spec.Containers = append(spec.Containers, mount.Container{
		Role:    "proxy",
		Env:     map[string]string{},
		Image:   "alpine:3",
		Command: []string{"sleep", "90"},
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
	// "gateway-proxy." with the trailing dot — not "gateway-proxy" — is
	// the actual fix, found from real diagnostics on the second CI
	// failure rather than a third guess: the CI runner (Azure-hosted)
	// injects a real DNS search domain into the container's resolv.conf
	// (something like "<id>.<region>.internal.cloudapp.net" — this
	// sandbox's own Docker Desktop VM doesn't set one, which is exactly
	// why this never reproduced locally). A bare, few-dots name triggers
	// the resolver's normal search-domain suffixing *before* trying the
	// name as-is, so busybox nslookup queried
	// "gateway-proxy.<search-domain>" first — 127.0.0.11 correctly
	// doesn't know that name and returns SERVFAIL, and the resolver
	// treats that as terminal rather than falling through to the bare
	// name. A trailing dot marks the name as already fully-qualified in
	// standard DNS syntax, which suppresses search-domain suffixing
	// entirely — confirmed locally against a container given an explicit
	// --dns-search override (this sandbox's own environment doesn't
	// otherwise have one to test against): a bare lookup gets the
	// search-suffixed query, a trailing-dot lookup does not.
	//
	// Retained the poll (dockerExecOKEventually) and diagnostics
	// regardless of finding the real cause — a fast, correct check
	// costs nothing extra, and the diagnostics remain valuable if
	// anything about this ever regresses again.
	if ok, out := dockerExecOKEventually(t, payload.ContainerName, 20*time.Second, "nslookup", "gateway-proxy."); !ok {
		t.Logf("last nslookup attempt output:\n%s", out)
		logNetworkDiagnostics(t, wantNetwork, payload.ContainerName, wantAuxiliaryName)
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
