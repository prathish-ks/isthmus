package kernel

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// recordingCall is one invocation captured by a fake runner.
type recordingCall struct {
	name  string
	args  []string
	stdin string
}

func newFakeDockerExecutor(t *testing.T, networkName string) (*dockerExecutor, *[]recordingCall) {
	t.Helper()
	var calls []recordingCall
	d := &dockerExecutor{
		dockerBin:   "docker",
		networkName: networkName,
		runner: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, recordingCall{name: name, args: args})
			// "docker create" must return a fake container id on stdout;
			// everything else returns empty.
			if len(args) > 0 && args[0] == "create" {
				return []byte("fake-container-id\n"), nil
			}
			return nil, nil
		},
		runnerStdin: func(ctx context.Context, name string, stdin string, args ...string) ([]byte, error) {
			calls = append(calls, recordingCall{name: name, args: args, stdin: stdin})
			return []byte(""), nil
		},
	}
	return d, &calls
}

func testWakeSpec() mount.Session {
	return mount.Session{
		Key:    mount.SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels: map[string]string{mount.GroupFolderLabel: "ag-1-folder"},
		Containers: []mount.Container{{
			Role:           "agent",
			Env:            map[string]string{"FOO": "bar"},
			ContributedEnv: map[string]string{"BEARER": "placeholder"},
			Mounts: []mount.Spec{
				{Class: mount.ClassGroupState, HostPath: "/host/group", ContainerPath: "/container/group", Mode: mount.ModeRW},
			},
			Image:   "nanoclaw-agent:ag-1",
			Command: []string{"/bin/entrypoint.sh"},
			Args:    []string{"--flag"},
			Labels:  map[string]string{"nanoclaw-container-name": "legacy-name"},
		}},
		RuntimeTier:      "container",
		StopGraceSeconds: 5,
	}
}

func findCreateCall(calls []recordingCall) (recordingCall, bool) {
	for _, c := range calls {
		if len(c.args) > 0 && c.args[0] == "create" {
			return c, true
		}
	}
	return recordingCall{}, false
}

func TestDockerExecutor_Wake_IncludesFullHardeningPosture(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if _, _, _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, ok := findCreateCall(*calls)
	if !ok {
		t.Fatal("no docker create call recorded")
	}
	joined := strings.Join(create.args, " ")
	for _, flag := range containerdefaults.HardeningPosture {
		if !strings.Contains(joined, flag) {
			t.Fatalf("docker create args missing hardening flag %q: %v", flag, create.args)
		}
	}
	if !strings.Contains(joined, "--rm") {
		t.Fatalf("docker create args missing --rm: %v", create.args)
	}
}

func TestDockerExecutor_Wake_DerivesNameFromKeyNotCaller(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	spec := testWakeSpec()
	_, gotName, _, _, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{})
	if err != nil {
		t.Fatalf("Wake: %v", err)
	}
	wantName := ContainerName(spec.Key)
	if gotName != wantName {
		t.Fatalf("returned name = %q, want kernel-derived %q", gotName, wantName)
	}
	create, ok := findCreateCall(*calls)
	if !ok {
		t.Fatal("no docker create call recorded")
	}
	joined := strings.Join(create.args, " ")
	if !strings.Contains(joined, "--name "+wantName) {
		t.Fatalf("docker create did not use the kernel-derived name %q: %v", wantName, create.args)
	}
}

func TestDockerExecutor_Wake_SplitsEntrypointFromCommand(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if _, _, _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, _ := findCreateCall(*calls)
	joined := strings.Join(create.args, " ")
	if !strings.Contains(joined, "--entrypoint /bin/entrypoint.sh") {
		t.Fatalf("docker create args missing --entrypoint split: %v", create.args)
	}
	// image and trailing args come after the entrypoint flag pair.
	last := create.args[len(create.args)-2:]
	if last[0] != "nanoclaw-agent:ag-1" || last[1] != "--flag" {
		t.Fatalf("docker create args did not end with image+args: %v", create.args)
	}
}

func TestDockerExecutor_Wake_ContributedEnvAppendedAfterComposedEnv(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if _, _, _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, _ := findCreateCall(*calls)
	fooIdx, bearerIdx := -1, -1
	for i, a := range create.args {
		if a == "FOO=bar" {
			fooIdx = i
		}
		if a == "BEARER=placeholder" {
			bearerIdx = i
		}
	}
	if fooIdx == -1 || bearerIdx == -1 {
		t.Fatalf("expected both env entries present: %v", create.args)
	}
	if bearerIdx < fooIdx {
		t.Fatalf("contributed env (BEARER) must come after composed env (FOO) so it wins on collision: %v", create.args)
	}
}

func TestDockerExecutor_Wake_AppendsFixedNetworkWhenConfigured(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "nanoclaw-egress")
	if _, _, _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, _ := findCreateCall(*calls)
	joined := strings.Join(create.args, " ")
	if !strings.Contains(joined, "--network nanoclaw-egress") {
		t.Fatalf("docker create args missing configured --network flag: %v", create.args)
	}
}

func TestDockerExecutor_Wake_NoNetworkFlagWhenUnconfigured(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if _, _, _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, _ := findCreateCall(*calls)
	for _, a := range create.args {
		if a == "--network" {
			t.Fatalf("docker create args contain --network with no network configured: %v", create.args)
		}
	}
}

// Pre-v2.4.0-promotion, this driver refused any non-agent container role
// outright — see the pre-249bbe93 version of this test,
// TestWake_AuxiliaryContainerRole_Denied in adversarial_test.go, updated
// alongside this one. Workstream A3 replaced that blanket refusal with
// validateNetworkAccessTarget's two specific rules; a spec that adds an
// auxiliary container WITHOUT a matching session-container networkAccess
// target still fails, but now for that reason, not "auxiliary containers
// are unsupported" (which is no longer true — see
// TestDockerExecutor_Wake_AuxiliaryContainer_CreatesNetworkAndBothContainers,
// below, for the accepted case).
func TestDockerExecutor_Wake_AuxiliaryWithoutMatchingNetworkAccessTarget_Rejected(t *testing.T) {
	d, _ := newFakeDockerExecutor(t, "")
	spec := testWakeSpec()
	spec.Containers = append(spec.Containers, mount.Container{Role: "proxy"})
	// spec.NetworkAccess left at its zero value: Target.Kind == "", which
	// is not "session-container" — validateNetworkAccessTarget's first
	// rule fires.
	if _, _, _, _, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{}); err == nil {
		t.Fatal("expected denial: an auxiliary container with no matching session-container networkAccess target")
	} else if !strings.Contains(err.Error(), "cannot use both a central gateway network and an auxiliary gateway container") {
		t.Fatalf("expected validateNetworkAccessTarget's specific reason, got: %v", err)
	}
}

// The positive case: a correctly-specified auxiliary container (a
// session-container networkAccess target naming it) is genuinely realized
// — network created, both containers created and started, aliased
// correctly on the private network. This is the actual new capability
// Workstream A3 exists to add, so it needs its own real proof, not just an
// absence-of-denial inference from the rejection test above.
func TestDockerExecutor_Wake_AuxiliaryContainer_CreatesNetworkAndBothContainers(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	spec := testWakeSpec()
	spec.Containers = append(spec.Containers, mount.Container{
		Role:  "proxy",
		Env:   map[string]string{},
		Image: "nanoclaw-proxy:v1",
	})
	spec.NetworkAccess = mount.NetworkAccessIntent{
		Endpoint: "gateway.internal:443",
		Target:   mount.NetworkAccessTarget{Kind: mount.NetworkTargetSessionContainer, Role: "proxy"},
	}

	containerID, containerName, auxiliaryNames, privateNetwork, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{})
	if err != nil {
		t.Fatalf("Wake: %v", err)
	}
	if containerID == "" || containerName == "" {
		t.Fatalf("expected a real container id/name, got id=%q name=%q", containerID, containerName)
	}
	wantPrivateNetwork := sessionNetworkName(spec.Key)
	if privateNetwork != wantPrivateNetwork {
		t.Fatalf("privateNetwork = %q, want %q", privateNetwork, wantPrivateNetwork)
	}
	wantAuxiliaryName := auxiliaryContainerName(spec.Key, "proxy")
	if len(auxiliaryNames) != 1 || auxiliaryNames[0] != wantAuxiliaryName {
		t.Fatalf("auxiliaryNames = %v, want [%q]", auxiliaryNames, wantAuxiliaryName)
	}

	var sawNetworkCreate, sawAuxiliaryCreate, sawNetworkConnect, sawAgentCreate bool
	var sawAuxiliaryStartBeforeAgentStart, sawAuxiliaryStart, sawAgentStart bool
	for _, c := range *calls {
		joined := strings.Join(c.args, " ")
		switch {
		case len(c.args) > 1 && c.args[0] == "network" && c.args[1] == "create":
			sawNetworkCreate = true
			if !strings.Contains(joined, "--internal") {
				t.Fatalf("network create missing --internal: %v", c.args)
			}
			if !strings.Contains(joined, wantPrivateNetwork) {
				t.Fatalf("network create did not name the session's own private network: %v", c.args)
			}
		case len(c.args) > 0 && c.args[0] == "create" && strings.Contains(joined, "--name "+wantAuxiliaryName):
			sawAuxiliaryCreate = true
			if !strings.Contains(joined, "--read-only") {
				t.Fatalf("auxiliary container create missing --read-only hardening: %v", c.args)
			}
			if strings.Contains(joined, "--network "+wantPrivateNetwork) {
				t.Fatalf("auxiliary container must NOT be created directly on the private network (its own uplink is the bridge network; it joins the private network via a separate network connect) — args: %v", c.args)
			}
			if !strings.Contains(joined, "--network bridge") {
				t.Fatalf("auxiliary container missing its own bridge uplink: %v", c.args)
			}
		case len(c.args) > 1 && c.args[0] == "network" && c.args[1] == "connect":
			sawNetworkConnect = true
			if !strings.Contains(joined, "--alias gateway.internal:443") {
				t.Fatalf("network connect did not alias the auxiliary to the configured gateway endpoint: %v", c.args)
			}
			if !strings.Contains(joined, wantPrivateNetwork) || !strings.Contains(joined, wantAuxiliaryName) {
				t.Fatalf("network connect did not target the private network + auxiliary container: %v", c.args)
			}
		case len(c.args) > 0 && c.args[0] == "create" && strings.Contains(joined, "--name "+containerName):
			sawAgentCreate = true
			if strings.Contains(joined, "--read-only") {
				t.Fatalf("agent container must NOT be created --read-only: %v", c.args)
			}
			if !strings.Contains(joined, "--network "+wantPrivateNetwork) {
				t.Fatalf("agent container must be attached to the session's private network, not the driver's fixed network: %v", c.args)
			}
		case len(c.args) > 1 && c.args[0] == "start" && c.args[1] == wantAuxiliaryName:
			sawAuxiliaryStart = true
		case len(c.args) > 1 && c.args[0] == "start" && c.args[1] == containerName:
			sawAgentStart = true
			// By the time the agent starts, the auxiliary must already have.
			sawAuxiliaryStartBeforeAgentStart = sawAuxiliaryStart
		}
	}
	if !sawNetworkCreate {
		t.Fatal("expected a docker network create call")
	}
	if !sawAuxiliaryCreate {
		t.Fatal("expected a docker create call for the auxiliary container")
	}
	if !sawNetworkConnect {
		t.Fatal("expected a docker network connect call for the auxiliary container")
	}
	if !sawAgentCreate {
		t.Fatal("expected a docker create call for the agent container")
	}
	if !sawAgentStart {
		t.Fatal("expected a docker start call for the agent container")
	}
	if !sawAuxiliaryStartBeforeAgentStart {
		t.Fatal("expected the auxiliary container to be started before the agent container")
	}
}

func TestDockerExecutor_BuildImage_PipesDockerfileOnStdin(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	dockerfile := "FROM scratch\nCMD [\"true\"]\n"
	if _, err := d.BuildImage(context.Background(), "/data/groups/g1", "nanoclaw-agent:g1", dockerfile); err != nil {
		t.Fatalf("BuildImage: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected exactly one call, got %d", len(*calls))
	}
	got := (*calls)[0]
	if got.stdin != dockerfile {
		t.Fatalf("dockerfile was not piped on stdin: got %q, want %q", got.stdin, dockerfile)
	}
	joined := strings.Join(got.args, " ")
	if !strings.Contains(joined, "-f -") {
		t.Fatalf("docker build args missing -f - (read dockerfile from stdin): %v", got.args)
	}
}

func TestDockerExecutor_Kill_StopsGracefullyThenRemoves(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if err := d.Kill(context.Background(), "some-container", nil, "", 7); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("expected stop then rm (2 calls), got %d: %v", len(*calls), *calls)
	}
	stop, rm := (*calls)[0], (*calls)[1]
	if stop.args[0] != "stop" || !strings.Contains(strings.Join(stop.args, " "), "-t 7") {
		t.Fatalf("first call was not a graceful stop with the given grace period: %v", stop.args)
	}
	if rm.args[0] != "rm" || !strings.Contains(strings.Join(rm.args, " "), "--force") {
		t.Fatalf("second call was not rm --force: %v", rm.args)
	}
	if stop.args[len(stop.args)-1] != "some-container" || rm.args[len(rm.args)-1] != "some-container" {
		t.Fatalf("stop/rm did not target the given container name: stop=%v rm=%v", stop.args, rm.args)
	}
}

func TestDockerExecutor_Kill_ZeroOrNegativeGraceDefaultsToOne(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if err := d.Kill(context.Background(), "c1", nil, "", 0); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	stop := (*calls)[0]
	if !strings.Contains(strings.Join(stop.args, " "), "-t 1") {
		t.Fatalf("expected default grace of 1 second, got: %v", stop.args)
	}
}

// Kill's teardown symmetry with Wake's multi-container creation (v2.4.0
// promotion, Workstream A3): auxiliaries stop+rm in REVERSE creation order,
// then the private network — mirroring DockerHandle.stop's own order
// (docker-driver.ts, commit 249bbe93) exactly. Two auxiliaries used
// specifically so "reverse order" is an observable, not an assumed,
// property.
func TestDockerExecutor_Kill_TearsDownAuxiliariesInReverseThenNetwork(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if err := d.Kill(context.Background(), "agent-1", []string{"aux-first", "aux-second"}, "session-net", 5); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	var seq []string
	for _, c := range *calls {
		if len(c.args) < 2 {
			continue
		}
		// "network rm X" is a 3-arg call (args[0]=="network") — summarize
		// as its own two-word verb, distinct from the 2-arg "stop"/"rm"
		// calls this loop otherwise reduces to "<verb> <target>".
		if c.args[0] == "network" && len(c.args) >= 2 {
			seq = append(seq, "network "+c.args[1]+" "+c.args[len(c.args)-1])
			continue
		}
		seq = append(seq, c.args[0]+" "+c.args[len(c.args)-1])
	}
	want := []string{
		"stop agent-1", "rm agent-1",
		"stop aux-second", "rm aux-second",
		"stop aux-first", "rm aux-first",
		"network rm session-net",
	}
	if len(seq) != len(want) {
		t.Fatalf("call sequence = %v, want %v", seq, want)
	}
	for i := range want {
		if seq[i] != want[i] {
			t.Fatalf("call %d = %q, want %q (full sequence: %v)", i, seq[i], want[i], seq)
		}
	}
}

// An ordinary single-container session (nil auxiliaryNames, "" privateNetwork
// — the zero value every pre-v2.4.0 Kill call already passed) must not issue
// any network-teardown call at all.
func TestDockerExecutor_Kill_NoAuxiliariesOrNetwork_OnlyTearsDownAgent(t *testing.T) {
	d, calls := newFakeDockerExecutor(t, "")
	if err := d.Kill(context.Background(), "agent-1", nil, "", 5); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("expected exactly stop+rm for the agent only, got %d calls: %v", len(*calls), *calls)
	}
}

// The "allocate all or leave nothing" property Wake's own doc comment
// promises: a failure partway through a multi-container wake (the agent
// create, after the network and auxiliary already succeeded) must roll
// back everything already created, not leave a live auxiliary container or
// network behind.
func TestDockerExecutor_Wake_AgentCreateFailure_RollsBackAuxiliaryAndNetwork(t *testing.T) {
	var calls []recordingCall
	d := &dockerExecutor{
		dockerBin: "docker",
		runner: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, recordingCall{name: name, args: args})
			if len(args) > 0 && args[0] == "create" {
				// Fail specifically the agent's create (identifiable as the
				// one NOT creating the auxiliary role's own name) — the
				// auxiliary and the network must already have succeeded by
				// the time this fires.
				joined := strings.Join(args, " ")
				if strings.Contains(joined, "nanoclaw-proxy") {
					return []byte("fake-aux-id\n"), nil
				}
				return nil, fmt.Errorf("simulated docker daemon failure on agent create")
			}
			return nil, nil
		},
	}
	spec := testWakeSpec()
	spec.Containers = append(spec.Containers, mount.Container{Role: "proxy", Env: map[string]string{}, Image: "nanoclaw-proxy:v1"})
	spec.NetworkAccess = mount.NetworkAccessIntent{
		Endpoint: "gateway.internal:443",
		Target:   mount.NetworkAccessTarget{Kind: mount.NetworkTargetSessionContainer, Role: "proxy"},
	}

	_, _, _, _, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{})
	if err == nil {
		t.Fatal("expected the simulated agent-create failure to surface as an error")
	}

	wantAuxiliaryName := auxiliaryContainerName(spec.Key, "proxy")
	wantNetwork := sessionNetworkName(spec.Key)
	var sawAuxiliaryRemoved, sawNetworkRemoved bool
	for _, c := range calls {
		joined := strings.Join(c.args, " ")
		if c.args[0] == "rm" && strings.Contains(joined, wantAuxiliaryName) {
			sawAuxiliaryRemoved = true
		}
		if len(c.args) > 1 && c.args[0] == "network" && c.args[1] == "rm" && strings.Contains(joined, wantNetwork) {
			sawNetworkRemoved = true
		}
	}
	if !sawAuxiliaryRemoved {
		t.Fatalf("expected the already-created auxiliary container to be rolled back, calls: %+v", calls)
	}
	if !sawNetworkRemoved {
		t.Fatalf("expected the already-created private network to be rolled back, calls: %+v", calls)
	}
}
