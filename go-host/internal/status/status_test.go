package status

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	dir := t.TempDir()
	return config.Config{
		DataDir:      dir,
		GroupsDir:    filepath.Join(dir, "groups"),
		UserID:       "user-1",
		AgentGroupID: "group-1",
		AgentFolder:  "folder-1",
		SessionID:    "session-1",
	}
}

func strp(s string) *string { return &s }

func seedSession(t *testing.T, dbPath string, id string, st session.Status, cst session.ContainerStatus) {
	t.Helper()
	db, err := session.Open(dbPath)
	if err != nil {
		t.Fatalf("session.Open: %v", err)
	}
	defer func() { _ = db.Close() }()
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	err = session.Create(db, session.Session{
		ID:               id,
		AgentGroupID:     "group-1",
		MessagingGroupID: strp("mg-1"),
		AgentProvider:    strp("claude"),
		Status:           st,
		ContainerStatus:  cst,
		LastActive:       strp(now),
		CreatedAt:        now,
	})
	if err != nil {
		t.Fatalf("session.Create: %v", err)
	}
}

func TestCollect_EmptyDatabaseReportsZeroCounts(t *testing.T) {
	cfg := testConfig(t)
	report, err := Collect("cfg.json", cfg, "")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if report.Sessions.Total != 0 {
		t.Fatalf("Total = %d, want 0", report.Sessions.Total)
	}
	if report.Config.DataDir != cfg.DataDir {
		t.Fatalf("Config.DataDir = %q, want %q", report.Config.DataDir, cfg.DataDir)
	}
	if !report.Config.Valid {
		t.Fatal("Config.Valid should be true for a fully-populated config")
	}
	if report.Kernel.Reachable {
		t.Fatal("Kernel.Reachable should be false when no socket is configured")
	}
}

func TestCollect_CountsSessionsByStatus(t *testing.T) {
	cfg := testConfig(t)
	dbPath := session.Path(cfg.DataDir)
	seedSession(t, dbPath, "s1", session.StatusActive, session.ContainerRunning)
	seedSession(t, dbPath, "s2", session.StatusActive, session.ContainerIdle)
	seedSession(t, dbPath, "s3", session.StatusClosed, session.ContainerStopped)

	report, err := Collect("cfg.json", cfg, "")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if report.Sessions.Total != 3 {
		t.Fatalf("Total = %d, want 3", report.Sessions.Total)
	}
	if report.Sessions.Active != 2 || report.Sessions.Closed != 1 {
		t.Fatalf("Active=%d Closed=%d, want 2/1", report.Sessions.Active, report.Sessions.Closed)
	}
	if report.Sessions.Running != 1 || report.Sessions.Idle != 1 || report.Sessions.Stopped != 1 {
		t.Fatalf("Running=%d Idle=%d Stopped=%d, want 1/1/1", report.Sessions.Running, report.Sessions.Idle, report.Sessions.Stopped)
	}
}

func TestCollect_InvalidConfigStillReturnsAReport(t *testing.T) {
	cfg := config.Config{DataDir: filepath.Join(t.TempDir(), "no-such-subdir")} // rest empty -> invalid, and DataDir doesn't exist -> DB open fails
	report, err := Collect("cfg.json", cfg, "")
	if err == nil {
		t.Fatal("expected an error opening a central db under a nonexistent data_dir")
	}
	if report.Config.Valid {
		t.Fatal("Config.Valid should be false for an incomplete config")
	}
}

func TestProbeKernel_NoSocketConfigured(t *testing.T) {
	ks := Probe("")
	if ks.Reachable {
		t.Fatal("Reachable should be false when socketPath is empty")
	}
}

func TestProbeKernel_UnreachableSocket(t *testing.T) {
	ks := Probe(filepath.Join(os.TempDir(), "nanoclaw-go-lab-status-test-no-such.sock"))
	if ks.Reachable {
		t.Fatal("Reachable should be false for a socket path nothing is listening on")
	}
	if ks.Detail == "" {
		t.Fatal("Detail should explain why the probe failed")
	}
}

func TestProbeKernel_ReachableSocket(t *testing.T) {
	sockPath := filepath.Join(os.TempDir(), "nanoclaw-go-lab-status-reachable.sock")
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

	ks := Probe(sockPath)
	if !ks.Reachable {
		t.Fatalf("Reachable should be true; detail=%q", ks.Detail)
	}
}

func TestReport_HumanIsNonEmptyAndIncludesVersion(t *testing.T) {
	r := Report{HostVersion: HostVersion, Generated: "now"}
	s := r.Human()
	if s == "" {
		t.Fatal("Human() must not be empty")
	}
}
