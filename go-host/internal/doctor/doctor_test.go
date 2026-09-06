package doctor

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
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

func TestRunAll_ReturnsAllFiveNamedChecksInFixedOrder(t *testing.T) {
	results := RunAll(context.Background(), Options{
		Config: config.Config{DataDir: t.TempDir()},
		Runner: fakeRunner{
			lookPath: map[string]error{"docker": errors.New("nope"), "onecli": errors.New("nope")},
		},
	})
	if len(results) != 5 {
		t.Fatalf("len(results) = %d, want 5", len(results))
	}
	for _, name := range []string{
		"container runtime", "agent image", "central db / mailboxes",
		"credential provider (OneCLI)", "kernel boundary (Unix socket)",
	} {
		resultFor(t, results, name) // fatals if missing
	}
}

func TestRunAll_DefaultsToRealRunnerWhenNil(t *testing.T) {
	// Just proves RunAll doesn't panic/nil-deref when Runner is left unset —
	// it will exercise the real OS's docker/onecli lookups, whatever the
	// sandbox's actual answer is.
	results := RunAll(context.Background(), Options{Config: config.Config{DataDir: t.TempDir()}})
	if len(results) != 5 {
		t.Fatalf("len(results) = %d, want 5", len(results))
	}
}
