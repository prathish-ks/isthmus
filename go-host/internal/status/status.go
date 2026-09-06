// Package status implements P7-01 (Phase 7 — UX & Operations): a single,
// point-in-time snapshot of host state — version, config validity, session
// counts, and kernel-socket reachability — with no secrets in the output
// (session/db.go, req 5: "without exposing secrets"). It reads the central
// DB and config directly rather than requiring a running daemon, because
// cmd/nanogo does not yet run as a long-lived process (see ADR-009's
// carried-forward gap); once it does, Collect's kernel probe becomes a real
// liveness check instead of "not configured."
package status

import (
	"database/sql"
	"fmt"
	"net"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/hosterrors"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// HostVersion identifies this Go host build. Independent of the wire
// protocol version internal/kernel freezes (ADR-008) — this changes with
// any host release; that changes only when the socket protocol shape does.
const HostVersion = "0.1.0-dev"

// Report is nanogo status's full output shape — human- and machine-
// (JSON-)readable alike, since every field is already a plain value.
type Report struct {
	HostVersion string        `json:"hostVersion"`
	Generated   string        `json:"generated"`
	Config      ConfigInfo    `json:"config"`
	Sessions    SessionCounts `json:"sessions"`
	Kernel      KernelStatus  `json:"kernel"`
}

// ConfigInfo reports which config was read and whether it validated —
// never its contents beyond the two directory paths, which are not secret.
type ConfigInfo struct {
	Path      string `json:"path"`
	DataDir   string `json:"dataDir"`
	GroupsDir string `json:"groupsDir"`
	Valid     bool   `json:"valid"`
}

// SessionCounts summarizes the sessions table by lifecycle and container
// status (session.Status / session.ContainerStatus) — never row content.
type SessionCounts struct {
	Total   int `json:"total"`
	Active  int `json:"active"`
	Closed  int `json:"closed"`
	Running int `json:"running"`
	Idle    int `json:"idle"`
	Stopped int `json:"stopped"`
}

// KernelStatus reports whether the configured kernel Unix socket accepted a
// connection just now. Reachable=false is the expected, non-error state
// until a long-lived kernel process is standing up (see package doc).
type KernelStatus struct {
	SocketPath string `json:"socketPath,omitempty"`
	Reachable  bool   `json:"reachable"`
	Detail     string `json:"detail"`
}

// Collect builds a Report for cfg, read from cfgPath (recorded verbatim,
// not re-validated against disk) and probing kernelSocket if non-empty.
// Returns a *hosterrors.HostError (via errors.As) on any DB failure — the
// partial Report built so far is still returned alongside it, since a
// failed session count shouldn't hide that config parsed fine.
func Collect(cfgPath string, cfg config.Config, kernelSocket string) (Report, error) {
	report := Report{
		HostVersion: HostVersion,
		Generated:   time.Now().UTC().Format(time.RFC3339),
		Config: ConfigInfo{
			Path:      cfgPath,
			DataDir:   cfg.DataDir,
			GroupsDir: cfg.GroupsDir,
			Valid:     cfg.Validate() == nil,
		},
		Kernel: Probe(kernelSocket),
	}

	dbPath := session.Path(cfg.DataDir)
	db, err := session.Open(dbPath)
	if err != nil {
		return report, fmt.Errorf("status: opening central db %q: %w", dbPath, hosterrors.Categorize(err))
	}
	defer func() { _ = db.Close() }()

	counts, err := countSessions(db)
	if err != nil {
		return report, fmt.Errorf("status: counting sessions: %w", hosterrors.Categorize(err))
	}
	report.Sessions = counts
	return report, nil
}

func countSessions(db *sql.DB) (SessionCounts, error) {
	var c SessionCounts
	rows, err := db.Query(`SELECT status, container_status, COUNT(*) FROM sessions GROUP BY status, container_status`)
	if err != nil {
		return c, err
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var st, cst string
		var n int
		if err := rows.Scan(&st, &cst, &n); err != nil {
			return c, err
		}
		c.Total += n
		switch session.Status(st) {
		case session.StatusActive:
			c.Active += n
		case session.StatusClosed:
			c.Closed += n
		}
		switch session.ContainerStatus(cst) {
		case session.ContainerRunning:
			c.Running += n
		case session.ContainerIdle:
			c.Idle += n
		case session.ContainerStopped:
			c.Stopped += n
		}
	}
	return c, rows.Err()
}

// Probe dials socketPath with a short timeout and reports whether anything
// is listening. A closed connection right after connecting is fine — this
// only proves something is listening, it never speaks the protocol (that's
// what a real capability/status call would do, out of scope for a liveness
// probe). Exported so other packages (internal/doctor's kernel-boundary
// check) can reuse the exact same probe instead of re-implementing it.
func Probe(socketPath string) KernelStatus {
	ks := KernelStatus{SocketPath: socketPath}
	if socketPath == "" {
		ks.Detail = "no kernel socket configured (pass -kernel-socket to probe one)"
		return ks
	}
	conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
	if err != nil {
		ks.Detail = hosterrors.Categorize(err).Guidance
		return ks
	}
	_ = conn.Close()
	ks.Reachable = true
	ks.Detail = "kernel socket accepted a connection"
	return ks
}

// Human renders r as the multi-line text `nanogo status` prints by default;
// -json prints the same Report marshaled instead.
func (r Report) Human() string {
	kernelLine := "kernel: not configured — " + r.Kernel.Detail
	if r.Kernel.SocketPath != "" {
		state := "unreachable"
		if r.Kernel.Reachable {
			state = "reachable"
		}
		kernelLine = fmt.Sprintf("kernel: %s at %s (%s)", state, r.Kernel.SocketPath, r.Kernel.Detail)
	}
	return fmt.Sprintf(
		"nanogo %s — generated %s\nconfig: %s (data_dir=%s groups_dir=%s valid=%t)\nsessions: %d total (active=%d closed=%d; container running=%d idle=%d stopped=%d)\n%s",
		r.HostVersion, r.Generated,
		r.Config.Path, r.Config.DataDir, r.Config.GroupsDir, r.Config.Valid,
		r.Sessions.Total, r.Sessions.Active, r.Sessions.Closed,
		r.Sessions.Running, r.Sessions.Idle, r.Sessions.Stopped,
		kernelLine,
	)
}
