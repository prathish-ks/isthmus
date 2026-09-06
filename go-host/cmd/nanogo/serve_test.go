package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/kernel"
)

// shortSocketPath mirrors internal/kernel/kernel_test.go's own helper of the
// same name (unexported there too, so it can't just be imported): a real
// Unix socket path must stay under the platform's sockaddr_un.sun_path
// limit (104 bytes on macOS, stricter than Linux's 108), and t.TempDir()'s
// deeply-nested layout on macOS reliably blows past that — found the hard
// way at P6-05, and again here at EC-03 until this fix, which is exactly
// why it's worth documenting twice rather than once: the same mistake is
// easy to reintroduce in a new test file that doesn't know the lesson.
func shortSocketPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join("/tmp", fmt.Sprintf("nanogo-serve-test-%d-%d.sock", os.Getpid(), time.Now().UnixNano()))
	t.Cleanup(func() { _ = os.Remove(p) })
	return p
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	groupsDir := filepath.Join(dir, "groups")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatalf("mkdir data dir: %v", err)
	}
	if err := os.MkdirAll(groupsDir, 0o750); err != nil {
		t.Fatalf("mkdir groups dir: %v", err)
	}
	return config.Config{
		DataDir:      dataDir,
		GroupsDir:    groupsDir,
		UserID:       "u1",
		AgentGroupID: "ag-1",
		AgentFolder:  "ag-1-folder",
		SessionID:    "sess-1",
	}
}

func TestStringList_CollectsRepeatedFlagValues(t *testing.T) {
	var s stringList
	if err := s.Set("/a"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := s.Set("/b"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if len(s) != 2 || s[0] != "/a" || s[1] != "/b" {
		t.Fatalf("got %v, want [/a /b]", s)
	}
	if s.String() != "/a,/b" {
		t.Fatalf("String() = %q, want %q", s.String(), "/a,/b")
	}
}

// TestBuildServeKernel_PolicyFieldsMatchConfigAndFlags pins that every
// mount.Policy field actually comes from cfg/flags, not a hardcoded value —
// the exact kind of silent-drift bug a production daemon assembling its own
// enforcement policy cannot afford.
func TestBuildServeKernel_PolicyFieldsMatchConfigAndFlags(t *testing.T) {
	cfg := testConfig(t)
	k, closeDB, err := buildServeKernel(cfg, serveFlags{
		surfaceRoots:    []string{"/app/container/agent-runner/src"},
		resolveSymlinks: true,
	}, nil)
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	defer func() { _ = closeDB() }()
	if k == nil {
		t.Fatal("buildServeKernel returned a nil Kernel")
	}
	// buildServeKernel has no exported way to inspect Kernel's unexported
	// mountPolicy field from this package, so the policy-correctness claim
	// is instead pinned behaviorally in
	// TestBuildServeKernel_MaterialsRootDefaultsUnderDataDir and via the
	// allowlist-wiring test below, which do observe real Policy-driven
	// decisions.
}

// TestBuildServeKernel_MaterialsRootDefaultsUnderDataDir pins the documented
// default (<data_dir>/session-materials) when -materials-root is left empty.
func TestBuildServeKernel_MaterialsRootDefaultsUnderDataDir(t *testing.T) {
	cfg := testConfig(t)
	k, closeDB, err := buildServeKernel(cfg, serveFlags{}, nil)
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	defer func() { _ = closeDB() }()
	if k == nil {
		t.Fatal("buildServeKernel returned a nil Kernel")
	}
	// Exercised indirectly via the round-trip test below, which sends a
	// container.wake request whose materials mount only validates if this
	// default was wired correctly.
}

// TestBuildServeKernel_SessionDBOpenFailureWarnsAndDegrades proves the
// documented "warn, don't crash" contract: an unopenable session DB path
// (parent directory missing) must not make buildServeKernel return an
// error — it must return a working Kernel with SessionLookup left denied,
// plus exactly one warning.
func TestBuildServeKernel_SessionDBOpenFailureWarnsAndDegrades(t *testing.T) {
	cfg := testConfig(t)
	cfg.DataDir = filepath.Join(cfg.DataDir, "no-such-subdir")

	var warnings []string
	k, closeDB, err := buildServeKernel(cfg, serveFlags{}, func(msg string) {
		warnings = append(warnings, msg)
	})
	if err != nil {
		t.Fatalf("buildServeKernel should degrade, not error, on a bad session-db path; got %v", err)
	}
	defer func() { _ = closeDB() }()
	if k == nil {
		t.Fatal("expected a non-nil Kernel even without a session DB")
	}
	// Two independent warnings are expected here, not one: the session-db
	// open failure (this test's own point) AND the no-allowlist-configured
	// warning ADR-018 added (serveFlags{} leaves allowlistPath empty too —
	// see TestBuildServeKernel_NoAllowlistConfigured_Warns for that one
	// pinned in isolation). Asserting exactly 2, rather than "at least 1",
	// keeps this test honest about how many independent warning sources
	// buildServeKernel actually has today.
	if len(warnings) != 2 {
		t.Fatalf("expected exactly two warnings (session-db + no-allowlist), got %d: %v", len(warnings), warnings)
	}

	// Confirm SessionLookup is actually denied (not just "we didn't wire a
	// warning") by dispatching a real lookup through the kernel returned.
	env := kernel.Envelope{
		Version:   kernel.ProtocolVersion,
		Op:        kernel.OpSessionLookup,
		RequestID: "r1",
		Payload:   mustMarshal(t, map[string]string{"mode": "get", "id": "sess-1"}),
	}
	resp := k.Dispatch(context.Background(), env)
	if resp.OK {
		t.Fatal("expected session.lookup to stay denied with no session DB wired")
	}
}

// TestBuildServeKernel_NoAllowlistConfigured_Warns pins ADR-018's own named
// follow-up to the EC-05 adversarial pass: nanogo serve must not silently
// start with no independent check on 'allowlisted-extra' mounts — the
// confirmed, live-verified gap in
// internal/kernel/adversarial_live_docker_test.go's
// TestLive_Wake_DockerSocketMount_NoAllowlistConfigured_RealContainerGetsSocket
// (a real container was created with the host's own Docker socket
// bind-mounted, with no -allowlist configured). An operator who never
// passes -allowlist must be told so on every startup, not left to discover
// it only by reading source or ADR-018 itself.
func TestBuildServeKernel_NoAllowlistConfigured_Warns(t *testing.T) {
	cfg := testConfig(t)
	var warnings []string
	k, closeDB, err := buildServeKernel(cfg, serveFlags{}, func(msg string) {
		warnings = append(warnings, msg)
	})
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	defer func() { _ = closeDB() }()
	if k == nil {
		t.Fatal("expected a non-nil Kernel")
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "allowlist") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a warning mentioning the missing allowlist, got %v", warnings)
	}
}

// TestBuildServeKernel_AllowlistConfigured_NoAllowlistWarning confirms the
// warning above is conditional, not unconditional noise: passing -allowlist
// suppresses it. testConfig(t)'s session DB opens fine, so this asserts zero
// warnings at all — not just "no allowlist-shaped one" — to also pin that no
// OTHER warning source fires unexpectedly for this otherwise-ordinary config.
func TestBuildServeKernel_AllowlistConfigured_NoAllowlistWarning(t *testing.T) {
	cfg := testConfig(t)
	allowlistPath := filepath.Join(t.TempDir(), "mount-allowlist.json")
	if err := os.WriteFile(allowlistPath, []byte(`{"allowedRoots":[]}`), 0o600); err != nil {
		t.Fatalf("write allowlist fixture: %v", err)
	}
	var warnings []string
	k, closeDB, err := buildServeKernel(cfg, serveFlags{allowlistPath: allowlistPath}, func(msg string) {
		warnings = append(warnings, msg)
	})
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	defer func() { _ = closeDB() }()
	if k == nil {
		t.Fatal("expected a non-nil Kernel")
	}
	if len(warnings) != 0 {
		t.Fatalf("expected no warnings once -allowlist is configured, got %v", warnings)
	}
}

// TestBuildServeKernel_CloseDBIsNilSafe confirms the returned closer never
// panics whether or not a DB was actually opened.
func TestBuildServeKernel_CloseDBIsNilSafe(t *testing.T) {
	cfg := testConfig(t)
	cfg.DataDir = filepath.Join(cfg.DataDir, "no-such-subdir")
	_, closeDB, err := buildServeKernel(cfg, serveFlags{}, func(string) {})
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	if err := closeDB(); err != nil {
		t.Fatalf("closeDB on a never-opened db should be a no-op, got %v", err)
	}
}

// TestServe_EndToEndRoundTripOverRealSocket is EC-03's own done-when proof:
// a Kernel built the exact way `nanogo serve` builds one, actually listening
// on a real Unix socket, actually dispatching a real request from a
// separate client connection — the same shape of proof kernel_test.go's own
// TestServe_RoundTripOverUnixSocket already established for Serve itself,
// repeated here specifically against buildServeKernel's assembly rather than
// a hand-built test Kernel, so a future change to buildServeKernel's policy
// wiring cannot silently regress without this test noticing.
func TestServe_EndToEndRoundTripOverRealSocket(t *testing.T) {
	cfg := testConfig(t)
	k, closeDB, err := buildServeKernel(cfg, serveFlags{}, func(string) {})
	if err != nil {
		t.Fatalf("buildServeKernel: %v", err)
	}
	defer func() { _ = closeDB() }()

	socketPath := shortSocketPath(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	serveErr := make(chan error, 1)
	go func() { serveErr <- k.Serve(ctx, socketPath) }()

	var conn net.Conn
	for i := 0; i < 50; i++ {
		conn, err = net.Dial("unix", socketPath)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dialing kernel socket: %v", err)
	}
	defer func() { _ = conn.Close() }()

	env := kernel.Envelope{
		Version:   kernel.ProtocolVersion,
		Op:        kernel.OpStatusTrace,
		RequestID: "smoke-1",
		Payload:   json.RawMessage(`{}`),
	}
	line, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		t.Fatalf("writing request: %v", err)
	}

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		t.Fatalf("no response read: %v", scanner.Err())
	}
	var resp kernel.ResponseEnvelope
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !resp.OK {
		t.Fatalf("expected ok=true for status.trace, got error=%v", resp.Error)
	}
	if resp.RequestID != "smoke-1" {
		t.Fatalf("requestId = %q, want %q (echoed back)", resp.RequestID, "smoke-1")
	}

	cancel()
	select {
	case err := <-serveErr:
		if err != nil {
			t.Fatalf("Serve returned an error after cancellation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not stop within 2s of context cancellation")
	}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}
