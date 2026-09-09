// EC-03 (Phase 9, Enforcement Closure): runs Kernel.Serve as a real,
// long-lived process listening on a Unix socket. This is the gap named at
// the close of both Phase 6 and Phase 7 ("cmd/nanogo does not yet run
// Kernel.Serve as a long-lived process") — without this command, every
// kernel capability was provable only inside a Go test process, never
// reachable by anything outside it. EC-02's TypeScript client dials exactly
// this process; EC-03 has to exist first because there is nothing to wire
// EC-02 onto otherwise.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/egress"
	"github.com/prathish-ks/isthmus/go-host/internal/kernel"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
	msgtrace "github.com/prathish-ks/isthmus/go-host/internal/trace"
)

// stringList collects a repeatable flag (e.g. -surface-root, which may
// legitimately name more than one install-surface root) into a slice — the
// standard flag package has no built-in repeatable-string type.
type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// serveFlags is every -serve-specific flag value, gathered into one value so
// buildServeKernel can be unit-tested without going through flag parsing or
// os.Exit at all.
type serveFlags struct {
	allowlistPath   string
	materialsRoot   string
	resolveSymlinks bool
	traceFile       string
	traceCapacity   int
	surfaceRoots    []string
	// dockerNetwork mirrors drivers/index.ts's dockerNetworkArgs (EC-02,
	// Phase 9): a fixed, install-level Docker network every container.wake
	// attaches to. Empty means no --network flag — see ADR-016.
	dockerNetwork string
}

// buildServeKernel assembles the real mount.Policy and Kernel options a
// production `nanogo serve` run needs, from cfg and the parsed flags. Pure
// construction — no listening, no signal handling — specifically so tests
// can exercise the assembly logic (policy fields, allowlist wiring, the
// session-db-open-or-degrade decision, tracer wiring) without needing a real
// socket or process lifecycle. traceCapacity <= 0 means "no tracer", the
// same as leaving -trace-file empty.
//
// A session DB that fails to open is a warning, not a fatal error: per
// kernel.WithSessionDB's own doc comment, omitting it leaves SessionLookup
// permanently denied rather than making the whole kernel unusable — a
// personal host missing its central DB on first run should still be able to
// serve container.wake/kill/build_image once the DB exists, not refuse to
// start at all over a narrower gap. The returned closer must be called by
// the caller once serving stops (nil-safe: closing a nil *sql.DB via this
// wrapper is a no-op).
func buildServeKernel(cfg config.Config, sf serveFlags, warn func(string)) (*kernel.Kernel, func() error, error) {
	materialsRoot := sf.materialsRoot
	if materialsRoot == "" {
		materialsRoot = filepath.Join(cfg.DataDir, "session-materials")
	}

	policy := mount.Policy{
		GroupsRoot:      cfg.GroupsDir,
		DataRoot:        cfg.DataDir,
		SurfaceRoots:    append([]string(nil), sf.surfaceRoots...),
		MaterialsRoot:   materialsRoot,
		ResolveSymlinks: sf.resolveSymlinks,
	}
	if sf.allowlistPath != "" {
		allowlistPath := sf.allowlistPath // capture by value, not by flag pointer
		policy.AllowlistedExtraCheck = func(hostPath string) (bool, string) {
			return mount.CheckAllowlistedExtra(hostPath, allowlistPath)
		}
	} else if warn != nil {
		// EC-05/ADR-018 (go-host/docs/ADR-018-p9-ec05-adversarial-pass-findings.md):
		// confirmed live, against a real Docker daemon, that with no
		// -allowlist configured, ANY host path a caller labels
		// allowlisted-extra — including the Docker socket — is unconditionally
		// trusted with no independent check (mount.go's own mountAllowed
		// comment already named this as the pinned baseline's documented
		// gap; this warning is what makes it visible at the moment it
		// actually matters, on every serve startup, rather than only to
		// someone who has read that comment or ADR-018 itself). Reuses the
		// same warn callback the session-db-open-failure case above uses,
		// rather than a separate mechanism, so both "serve is running with a
		// narrower guarantee than it could have" cases surface identically.
		warn("SECURITY: no -allowlist configured — every 'allowlisted-extra' mount (e.g. a Docker-socket or credential-directory bind mount) is unconditionally trusted with no independent check (see ADR-018). Pass -allowlist <path> to enable mount.CheckAllowlistedExtra.")
	}

	opts := []kernel.Option{}
	var db *sql.DB

	dbPath := session.Path(cfg.DataDir)
	openedDB, err := session.Open(dbPath)
	if err != nil {
		if warn != nil {
			warn(fmt.Sprintf("could not open session db at %s: %v (session.lookup will stay denied until it exists)", dbPath, err))
		}
	} else {
		db = openedDB
		opts = append(opts, kernel.WithSessionDB(db))
	}

	if sf.traceFile != "" && sf.traceCapacity > 0 {
		opts = append(opts, kernel.WithTracer(msgtrace.NewFileBackedStore(sf.traceFile, sf.traceCapacity)))
	}
	if sf.dockerNetwork != "" {
		opts = append(opts, kernel.WithDockerNetwork(sf.dockerNetwork))
	}

	k := kernel.New(policy, opts...)

	closeDB := func() error {
		if db == nil {
			return nil
		}
		return db.Close()
	}
	return k, closeDB, nil
}

// runServeCmd is EC-03's `nanogo serve` CLI surface: parse flags (exiting on
// a missing/invalid config, matching every other subcommand's
// mustLoadConfig convention), build the kernel via buildServeKernel, then
// block in Kernel.Serve until SIGINT/SIGTERM.
func runServeCmd(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	configPath := fs.String("config", "", "path to a config file (required)")
	socketPath := fs.String("kernel-socket", "", "Unix socket path to listen on (required)")
	allowlistPath := fs.String("allowlist", "", "optional mount-allowlist.json path; when set, re-checks 'allowlisted-extra' mounts independently (see mount.CheckAllowlistedExtra)")
	materialsRoot := fs.String("materials-root", "", "root for session-scoped materials mounts; defaults to <data_dir>/session-materials")
	resolveSymlinks := fs.Bool("resolve-symlinks", false, "additionally resolve each mount's real filesystem path before validating containment (see mount.Policy.ResolveSymlinks)")
	traceFile := fs.String("trace-file", "", "optional durable trace file; when set, every dispatched request becomes readable later via 'nanogo trace'")
	traceCapacity := fs.Int("trace-capacity", 200, "per-key event capacity for -trace-file's in-memory mirror (ignored if -trace-file is unset)")
	var surfaceRoots stringList
	fs.Var(&surfaceRoots, "surface-root", "an install-surface root mounts may reference read-only (repeatable)")
	dockerNetwork := fs.String("docker-network", "", "optional fixed Docker network every container.wake attaches to (EC-02; mirrors drivers/index.ts's dockerNetworkArgs — a per-install constant, not a per-request value)")
	blockMetadataEgress := fs.Bool("block-metadata-egress", true, "install a DOCKER-USER firewall rule blocking 169.254.0.0/16 (cloud-metadata/link-local) from every agent container (ADR-013 Decision 3; Linux only today, see internal/egress's package doc comment). Set false to opt out.")
	_ = fs.Parse(args)

	cfg := mustLoadConfig(*configPath, "serve")
	if *socketPath == "" {
		fmt.Fprintln(os.Stderr, "serve: -kernel-socket is required")
		os.Exit(1)
	}

	k, closeDB, err := buildServeKernel(cfg, serveFlags{
		allowlistPath:   *allowlistPath,
		materialsRoot:   *materialsRoot,
		resolveSymlinks: *resolveSymlinks,
		traceFile:       *traceFile,
		traceCapacity:   *traceCapacity,
		surfaceRoots:    []string(surfaceRoots),
		dockerNetwork:   *dockerNetwork,
	}, func(msg string) { fmt.Fprintf(os.Stderr, "serve: warning: %s\n", msg) })
	if err != nil {
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = closeDB() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ADR-013 Decision 3: block cloud-metadata/link-local egress by
	// default. Best-effort and non-fatal, same posture as the missing
	// -allowlist warning above — an optional hardening layer that isn't
	// the primary security boundary shouldn't refuse to start the host
	// over. On non-Linux, egress.Ensure no-ops silently (a disclosed gap,
	// not a failure); the warning below only fires on Linux when the
	// helper container invocation itself genuinely failed.
	if *blockMetadataEgress {
		if err := egress.Ensure(ctx, egress.OSRunner{}); err != nil {
			fmt.Fprintf(os.Stderr, "serve: warning: SECURITY: %v — an agent container may be able to reach cloud instance-metadata services. Run `nanogo doctor` for more detail.\n", err)
		}
	}

	fmt.Printf("nanogo: kernel listening on %s (pid %d) — Ctrl-C or SIGTERM to stop\n", *socketPath, os.Getpid())
	if err := k.Serve(ctx, *socketPath); err != nil {
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("nanogo: kernel stopped")
}
