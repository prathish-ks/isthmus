// Package doctor implements P7-02 (Phase 7 — UX & Operations): a set of
// independent, named, read-only checks over the pieces a NanoClaw Go host
// depends on — container runtime, agent image, central DB/mailboxes,
// credential-provider connectivity, and the kernel socket boundary — each
// returning a Result a person or a script can act on. Per the task's own
// instruction, doctor never auto-fixes anything it finds wrong; every
// Result with Level != LevelPass carries a Remediation string describing
// the manual next step instead.
package doctor

import (
	"context"
	"os/exec"
	"strings"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/hosterrors"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
	"github.com/prathish-ks/isthmus/go-host/internal/status"
)

// Level is a check's outcome. There is no fourth value — a check that
// cannot run at all (e.g. no AgentImage configured) reports LevelPass with
// a Detail explaining it was skipped, never a silent absence from the
// result list, so `nanogo doctor`'s output always accounts for every named
// check it claims to run.
type Level string

const (
	// LevelPass means the check found nothing to report.
	LevelPass Level = "pass"
	// LevelWarn means the check found something worth an operator's
	// attention but not severe enough to fail on.
	LevelWarn Level = "warn"
	// LevelFail means the check found a real problem.
	LevelFail Level = "fail"
)

// Result is one named check's outcome.
type Result struct {
	Name        string `json:"name"`
	Level       Level  `json:"level"`
	Detail      string `json:"detail"`
	Remediation string `json:"remediation,omitempty"`
}

// CommandRunner is the narrow seam doctor's runtime-dependent checks go
// through, so tests can fake exactly one external dependency (whether a
// binary exists, what it prints) without needing a real Docker/OneCLI
// installation in CI.
type CommandRunner interface {
	// LookPath reports whether name is found on PATH, mirroring
	// exec.LookPath's (path, err) shape.
	LookPath(name string) (string, error)
	// Run executes name with args and returns its combined output,
	// mirroring exec.CommandContext(...).CombinedOutput()'s ([]byte, err)
	// shape, trimmed to a string for convenience.
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// execRunner is the production CommandRunner — the real OS.
type execRunner struct{}

func (execRunner) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (execRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	// name is always the literal "docker" passed by this file's own callers
	// (RunAll, below) and args are fixed diagnostic flags plus opts.AgentImage,
	// an operator-configured image tag from this host's own config file — not
	// remote/attacker-controlled input, and exec.Command never invokes a shell.
	// #nosec G204 -- name is always the literal "docker"; args are fixed flags plus an operator-configured image tag, not attacker input, and no shell is invoked
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return strings.TrimSpace(string(out)), err
}

// Options configures RunAll. Runner defaults to the real OS when nil —
// tests are the only caller expected to supply a fake.
type Options struct {
	Config       config.Config
	AgentImage   string // docker image tag to check for; empty skips the check
	KernelSocket string // Unix socket path to probe; empty skips the check
	Runner       CommandRunner
}

// RunAll runs every named check and returns all of their Results, in a
// fixed order, regardless of whether earlier checks failed — doctor's whole
// point is a complete picture in one pass, not fail-fast.
func RunAll(ctx context.Context, opts Options) []Result {
	if opts.Runner == nil {
		opts.Runner = execRunner{}
	}
	return []Result{
		checkContainerRuntime(ctx, opts),
		checkAgentImage(ctx, opts),
		checkCentralDB(opts),
		checkCredentialProvider(opts),
		checkKernelBoundary(opts),
	}
}

func checkContainerRuntime(ctx context.Context, opts Options) Result {
	const name = "container runtime"
	if _, err := opts.Runner.LookPath("docker"); err != nil {
		return Result{Name: name, Level: LevelFail,
			Detail:      "docker was not found on PATH",
			Remediation: "install Docker (or the configured container runtime) and ensure it is on PATH"}
	}
	out, err := opts.Runner.Run(ctx, "docker", "info", "--format", "{{.ServerVersion}}")
	if err != nil {
		return Result{Name: name, Level: LevelWarn,
			Detail:      "docker binary found, but the daemon did not respond: " + firstLine(out, err),
			Remediation: "start Docker (e.g. open Docker Desktop, or `sudo systemctl start docker`) and re-run doctor"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "docker daemon reachable, server version " + out}
}

func checkAgentImage(ctx context.Context, opts Options) Result {
	const name = "agent image"
	if opts.AgentImage == "" {
		return Result{Name: name, Level: LevelPass, Detail: "no image configured to check (pass -agent-image to enable)"}
	}
	out, err := opts.Runner.Run(ctx, "docker", "image", "inspect", opts.AgentImage, "--format", "{{.Id}}")
	if err != nil {
		return Result{Name: name, Level: LevelFail,
			Detail:      "image " + opts.AgentImage + " was not found locally: " + firstLine(out, err),
			Remediation: "build or pull the image (see buildAgentGroupImage / container.build_image) before waking a session"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "image " + opts.AgentImage + " present, id " + out}
}

func checkCentralDB(opts Options) Result {
	const name = "central db / mailboxes"
	if opts.Config.DataDir == "" {
		return Result{Name: name, Level: LevelFail,
			Detail:      "no data_dir configured",
			Remediation: "pass -config pointing at a valid config file (see internal/config)"}
	}
	dbPath := session.Path(opts.Config.DataDir)
	db, err := session.Open(dbPath)
	if err != nil {
		he := hosterrors.Categorize(err)
		return Result{Name: name, Level: LevelFail,
			Detail:      "could not open central db at " + dbPath + ": " + he.Error(),
			Remediation: he.Guidance}
	}
	defer func() { _ = db.Close() }()
	if err := db.Ping(); err != nil {
		he := hosterrors.Categorize(err)
		return Result{Name: name, Level: LevelFail,
			Detail:      "central db at " + dbPath + " did not respond to ping: " + he.Error(),
			Remediation: he.Guidance}
	}
	return Result{Name: name, Level: LevelPass, Detail: "central db reachable at " + dbPath}
}

func checkCredentialProvider(opts Options) Result {
	const name = "credential provider (OneCLI)"
	runner := opts.Runner
	if runner == nil {
		runner = execRunner{}
	}
	if _, err := runner.LookPath("onecli"); err != nil {
		return Result{Name: name, Level: LevelWarn,
			Detail:      "onecli was not found on PATH",
			Remediation: "install onecli if this install uses the OneCLI gateway provider; otherwise this warning is expected and safe to ignore"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "onecli found on PATH"}
}

func checkKernelBoundary(opts Options) Result {
	const name = "kernel boundary (Unix socket)"
	if opts.KernelSocket == "" {
		return Result{Name: name, Level: LevelWarn,
			Detail:      "no kernel socket configured — cmd/nanogo does not yet run as a long-lived kernel process (ADR-009's carried-forward gap)",
			Remediation: "pass -kernel-socket once cmd/nanogo -serve is standing up a long-lived kernel; expected to warn until then"}
	}
	ks := status.Probe(opts.KernelSocket)
	if !ks.Reachable {
		return Result{Name: name, Level: LevelFail,
			Detail:      "kernel socket at " + opts.KernelSocket + " did not accept a connection: " + ks.Detail,
			Remediation: "start the kernel process, or correct the socket path"}
	}
	return Result{Name: name, Level: LevelPass, Detail: "kernel socket at " + opts.KernelSocket + " reachable"}
}

func firstLine(out string, err error) string {
	if out != "" {
		if i := strings.IndexByte(out, '\n'); i >= 0 {
			out = out[:i]
		}
		return out
	}
	return err.Error()
}
