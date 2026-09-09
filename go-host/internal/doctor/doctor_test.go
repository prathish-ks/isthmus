package doctor

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
)

// fakeRunner lets each test control LookPath/Run per binary name without
// touching the real OS.
type fakeRunner struct {
	lookPath map[string]error      // name -> error to return from LookPath (nil = found)
	run      map[string]fakeResult // name -> canned Run result
}

type fakeResult struct {
	out string
	err error
}

func (f fakeRunner) LookPath(name string) (string, error) {
	if err, ok := f.lookPath[name]; ok {
		if err != nil {
			return "", err
		}
		return "/usr/bin/" + name, nil
	}
	return "/usr/bin/" + name, nil
}

func (f fakeRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	if r, ok := f.run[name]; ok {
		return r.out, r.err
	}
	return "", nil
}

func resultFor(t *testing.T, results []Result, name string) Result {
	t.Helper()
	for _, r := range results {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("no result named %q among %d results", name, len(results))
	return Result{}
}

func TestCheckContainerRuntime_DockerMissing(t *testing.T) {
	r := checkContainerRuntime(context.Background(), Options{
		Runner: fakeRunner{lookPath: map[string]error{"docker": errors.New("not found")}},
	})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
	if r.Remediation == "" {
		t.Fatal("Remediation must not be empty on failure")
	}
}

func TestCheckContainerRuntime_DaemonUnresponsive(t *testing.T) {
	r := checkContainerRuntime(context.Background(), Options{
		Runner: fakeRunner{
			lookPath: map[string]error{"docker": nil},
			run:      map[string]fakeResult{"docker": {out: "", err: errors.New("cannot connect")}},
		},
	})
	if r.Level != LevelWarn {
		t.Fatalf("Level = %q, want warn", r.Level)
	}
}

func TestCheckContainerRuntime_Healthy(t *testing.T) {
	r := checkContainerRuntime(context.Background(), Options{
		Runner: fakeRunner{
			lookPath: map[string]error{"docker": nil},
			run:      map[string]fakeResult{"docker": {out: "27.0.0", err: nil}},
		},
	})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

func TestCheckAgentImage_NoneConfiguredSkipsAsPass(t *testing.T) {
	r := checkAgentImage(context.Background(), Options{Runner: fakeRunner{}})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass (skipped)", r.Level)
	}
}

func TestCheckAgentImage_NotFound(t *testing.T) {
	r := checkAgentImage(context.Background(), Options{
		AgentImage: "nanoclaw-agent:latest",
		Runner: fakeRunner{
			run: map[string]fakeResult{"docker": {out: "", err: errors.New("no such image")}},
		},
	})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckAgentImage_Found(t *testing.T) {
	r := checkAgentImage(context.Background(), Options{
		AgentImage: "nanoclaw-agent:latest",
		Runner: fakeRunner{
			run: map[string]fakeResult{"docker": {out: "sha256:abc", err: nil}},
		},
	})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

func TestCheckCentralDB_NoDataDir(t *testing.T) {
	r := checkCentralDB(Options{})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckCentralDB_Healthy(t *testing.T) {
	r := checkCentralDB(Options{Config: config.Config{DataDir: t.TempDir()}})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass: %+v", r.Level, r)
	}
}

func TestCheckCredentialProvider_MissingWarnsNotFails(t *testing.T) {
	r := checkCredentialProvider(Options{
		Runner: fakeRunner{lookPath: map[string]error{"onecli": errors.New("not found")}},
	})
	if r.Level != LevelWarn {
		t.Fatalf("Level = %q, want warn (missing onecli is not fatal)", r.Level)
	}
}

func TestCheckCredentialProvider_Found(t *testing.T) {
	r := checkCredentialProvider(Options{
		Runner: fakeRunner{lookPath: map[string]error{"onecli": nil}},
	})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass", r.Level)
	}
}

func TestCheckKernelBoundary_NotConfiguredWarns(t *testing.T) {
	r := checkKernelBoundary(Options{})
	if r.Level != LevelWarn {
		t.Fatalf("Level = %q, want warn", r.Level)
	}
}

func TestCheckKernelBoundary_UnreachableFails(t *testing.T) {
	r := checkKernelBoundary(Options{KernelSocket: filepath.Join(os.TempDir(), "nanoclaw-go-lab-doctor-test-no-such.sock")})
	if r.Level != LevelFail {
		t.Fatalf("Level = %q, want fail", r.Level)
	}
}

func TestCheckKernelBoundary_ReachablePasses(t *testing.T) {
	sockPath := filepath.Join(os.TempDir(), "nanoclaw-go-lab-doctor-reachable.sock")
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	defer func() { _ = os.Remove(sockPath) }()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	r := checkKernelBoundary(Options{KernelSocket: sockPath})
	if r.Level != LevelPass {
		t.Fatalf("Level = %q, want pass: %+v", r.Level, r)
	}
}

func TestRunAll_ReturnsAllSixNamedChecksInFixedOrder(t *testing.T) {
	results := RunAll(context.Background(), Options{
		Config: config.Config{DataDir: t.TempDir()},
		Runner: fakeRunner{
			lookPath: map[string]error{"docker": errors.New("nope"), "onecli": errors.New("nope")},
		},
	})
	if len(results) != 6 {
		t.Fatalf("len(results) = %d, want 6", len(results))
	}
	for _, name := range []string{
		"container runtime", "agent image", "central db / mailboxes",
		"credential provider (OneCLI)", "kernel boundary (Unix socket)",
		egressCheckName,
	} {
		resultFor(t, results, name) // fatals if missing
	}
}

func TestCheckMetadataEgressBlock_SkippedByDefault_NoRealDockerCall(t *testing.T) {
	// CheckEgressBlock defaults to false (the zero value) precisely so an
	// ordinary RunAll/doctor call never spawns a container — see
	// Options.CheckEgressBlock's doc comment. This calls
	// checkMetadataEgressBlock directly rather than going through RunAll:
	// an earlier version of this test drove it through RunAll with a
	// shared spyRunner and asserted zero total calls, but RunAll's other
	// checks (checkContainerRuntime, checkAgentImage,
	// checkCredentialProvider) legitimately call the same Runner too — a
	// real `go test` run on real hardware caught this directly (spy.calls
	// == 3, all from those other checks, none from egress), which is
	// exactly the kind of self-caught-by-actually-running-it regression
	// this project's own testing discipline exists to produce. Isolating
	// the call under test to just checkMetadataEgressBlock is what makes
	// "zero calls" mean what this test claims it means.
	spy := &spyRunner{}
	r := checkMetadataEgressBlock(context.Background(), Options{Runner: spy})
	if r.Level != LevelPass {
		t.Fatalf("egress check Level = %q, want pass (skipped, not failed) when CheckEgressBlock is unset", r.Level)
	}
	if spy.calls != 0 {
		t.Fatalf("expected zero Runner calls with CheckEgressBlock unset, got %d", spy.calls)
	}
}

func TestCheckMetadataEgressBlock_ChecksWhenOptedIn(t *testing.T) {
	// internal/egress's mechanism is deliberately Linux-only (see that
	// package's own doc comment: Docker Desktop for Mac's --network host
	// is a proxy/forwarding emulation, not a real shared network
	// namespace) — egress.Check no-ops WITHOUT touching the Runner at all
	// on any other GOOS, reporting a disclosed LevelWarn gap rather than a
	// false LevelPass. An earlier version of this test assumed the Runner
	// was always invoked once CheckEgressBlock is true, regardless of
	// platform; a real `go test` run on a real Mac caught that directly
	// (spy.calls == 0, not the expected >0) — this branches on GOOS so the
	// assertion matches what the code actually promises on each platform,
	// same as egress_test.go's own Linux/non-Linux split.
	spy := &spyRunner{}
	r := checkMetadataEgressBlock(context.Background(), Options{Runner: spy, CheckEgressBlock: true})
	if r.Name != egressCheckName {
		t.Fatalf("Name = %q, want %q", r.Name, egressCheckName)
	}
	if runtime.GOOS != "linux" {
		if spy.calls != 0 {
			t.Fatalf("expected zero Runner calls on non-Linux (%s) — internal/egress no-ops there by design", runtime.GOOS)
		}
		if r.Level != LevelWarn {
			t.Fatalf("Level = %q, want warn (disclosed non-Linux gap), on %s", r.Level, runtime.GOOS)
		}
		return
	}
	if spy.calls == 0 {
		t.Fatal("expected CheckEgressBlock: true to actually invoke the Runner on Linux, got zero calls")
	}
}

func TestRunAll_EgressBlockSkippedByDefault_ResultStillPresent(t *testing.T) {
	// Complements TestCheckMetadataEgressBlock_SkippedByDefault_NoRealDockerCall
	// above: confirms the "skipped, not failed" Result is still what shows
	// up when egress is wired into the full RunAll list, using the
	// map-based fakeRunner (like every other RunAll test in this file)
	// rather than spyRunner, since spyRunner's simple total-call count is
	// only a meaningful assertion when isolated to one check.
	results := RunAll(context.Background(), Options{
		Config: config.Config{DataDir: t.TempDir()},
		Runner: fakeRunner{lookPath: map[string]error{"docker": errors.New("nope"), "onecli": errors.New("nope")}},
	})
	r := resultFor(t, results, egressCheckName)
	if r.Level != LevelPass {
		t.Fatalf("egress check Level = %q, want pass (skipped, not failed) when CheckEgressBlock is unset", r.Level)
	}
}

// spyRunner counts Run/LookPath invocations without needing a real OS or a
// canned-per-binary map — used where a test's whole point is "was this
// called at all", not what it returned.
type spyRunner struct{ calls int }

func (s *spyRunner) LookPath(name string) (string, error) { s.calls++; return "/usr/bin/" + name, nil }
func (s *spyRunner) Run(_ context.Context, _ string, _ ...string) (string, error) {
	s.calls++
	return "", nil
}

func TestRunAll_DefaultsToRealRunnerWhenNil(t *testing.T) {
	// Just proves RunAll doesn't panic/nil-deref when Runner is left unset —
	// it will exercise the real OS's docker/onecli lookups, whatever the
	// sandbox's actual answer is. CheckEgressBlock is left false, so this
	// still makes zero real Docker calls for that check specifically.
	results := RunAll(context.Background(), Options{Config: config.Config{DataDir: t.TempDir()}})
	if len(results) != 6 {
		t.Fatalf("len(results) = %d, want 6", len(results))
	}
}
