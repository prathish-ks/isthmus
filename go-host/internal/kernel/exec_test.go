package kernel

import (
	"context"
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
	if _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
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
	_, gotName, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{})
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
	if _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
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
	if _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
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
	if _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
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
	if _, _, err := d.Wake(context.Background(), testWakeSpec(), containerdefaults.RunAs{}, containerdefaults.Resources{}); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	create, _ := findCreateCall(*calls)
	for _, a := range create.args {
		if a == "--network" {
			t.Fatalf("docker create args contain --network with no network configured: %v", create.args)
		}
	}
}

func TestDockerExecutor_Wake_RejectsAuxiliaryContainerRole(t *testing.T) {
	d, _ := newFakeDockerExecutor(t, "")
	spec := testWakeSpec()
	spec.Containers = append(spec.Containers, mount.Container{Role: "proxy"})
	if _, _, err := d.Wake(context.Background(), spec, containerdefaults.RunAs{}, containerdefaults.Resources{}); err == nil {
		t.Fatal("expected an error for a non-agent container role; this driver does not manage auxiliary containers")
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
	if err := d.Kill(context.Background(), "some-container", 7); err != nil {
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
	if err := d.Kill(context.Background(), "c1", 0); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	stop := (*calls)[0]
	if !strings.Contains(strings.Join(stop.args, " "), "-t 1") {
		t.Fatalf("expected default grace of 1 second, got: %v", stop.args)
	}
}
