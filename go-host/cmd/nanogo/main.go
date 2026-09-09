// Command nanogo is the entry point for NanoClaw's experimental Go host
// kernel (see ../../../docs/host-decomposition.md and
// ../../../docs/design-laws.md for the surrounding project's rationale).
//
// P3-01 proved this module builds, runs, and is unit-tested. P3-02 added the
// minimal, single-instance config this proof needs (one user, one agent,
// one session — see internal/config) and a CLI flag to validate it. P3-03
// adds -write-chat, which writes one real inbound chat message into the
// configured session's inbound.db (see internal/mailbox) — the piece needed
// to prove the original, unmodified agent-runner can read a message a Go
// process wrote. P3-04 proved the real, unmodified agent-runner container
// can consume that message and write a reply (via a standalone shell
// harness, scripts/p3-04-launch.sh — not this binary). P3-05 adds
// -read-outbound, which reads that reply back out of the session's
// outbound.db and prints it — the container→host half of the round trip,
// completing what -write-chat started. P3-06 adds -prepare-outbound, a thin
// CLI surface for mailbox.OpenForSetup — so scripts/p3-06-e2e.sh's
// deterministic round-trip proof (a fake, non-Claude provider wired into the
// real, unmodified agent-runner via scripts/p3-06-mock-provider.ts) no
// longer needs to hand-create outbound.db's schema with the sqlite3 CLI the
// way P3-04's harness had to. This binary still does not launch a container
// itself; that stays out of scope until Phase 3's later, more careful
// Go-kernel work.
//
// Phase 7 (UX & Operations, ADR-010) adds four subcommands — status,
// doctor, trace, security-check — dispatched on argv[1] before any of the
// flags above are even parsed, so every P3-era invocation (which always
// starts with "-config", never a bare word) keeps working unchanged: an
// unrecognized first argument falls straight through to the original,
// unmodified flag.Parse()-based body (see runLegacyCLI). At the time those
// four were added, none of them required a running kernel process — status
// and doctor could only ever opportunistically probe a kernel socket if one
// happened to be running, because nothing in this binary ever listened on
// one.
//
// Phase 9 (Enforcement Closure, EC-03) closes that gap: `serve` (see
// serve.go) runs Kernel.Serve as a real, long-lived process, so status and
// doctor's kernel-socket checks stop being "opportunistic probe" and become
// "the expected common case," and EC-02's TypeScript client has a real
// process to dial instead of nothing.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/config"
	"github.com/prathish-ks/isthmus/go-host/internal/doctor"
	"github.com/prathish-ks/isthmus/go-host/internal/hostinfo"
	"github.com/prathish-ks/isthmus/go-host/internal/mailbox"
	"github.com/prathish-ks/isthmus/go-host/internal/securitycheck"
	"github.com/prathish-ks/isthmus/go-host/internal/status"
	msgtrace "github.com/prathish-ks/isthmus/go-host/internal/trace"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "status":
			runStatusCmd(os.Args[2:])
			return
		case "doctor":
			runDoctorCmd(os.Args[2:])
			return
		case "trace":
			runTraceCmd(os.Args[2:])
			return
		case "security-check":
			runSecurityCheckCmd(os.Args[2:])
			return
		case "serve":
			runServeCmd(os.Args[2:])
			return
		}
	}
	runLegacyCLI(os.Args[1:])
}

// runLegacyCLI is P3-01 through P3-06's original main() body, verbatim in
// behavior, moved into its own function and given its own FlagSet (rather
// than the top-level flag package) purely so main can dispatch to the four
// new subcommands first without the two flag-parsing paths interfering.
func runLegacyCLI(args []string) {
	fs := flag.NewFlagSet("nanogo", flag.ExitOnError)
	configPath := fs.String("config", "", "path to a minimal one-user/one-agent/one-session config JSON file (P3-02)")
	writeChat := fs.String("write-chat", "", "write one inbound chat message with this text into the configured session's inbound.db (P3-03); requires -config")
	readOutbound := fs.Bool("read-outbound", false, "read and print due messages from the configured session's outbound.db (P3-05); requires -config")
	prepareOutbound := fs.Bool("prepare-outbound", false, "create/ensure the configured session's outbound.db schema without starting a container (P3-06); requires -config")
	_ = fs.Parse(args)

	if *configPath == "" {
		fmt.Println(hostinfo.Describe())
		fmt.Println("pass -config <path> to validate a minimal config file (P3-02)")
		fmt.Println("pass -config <path> -write-chat <text> to write one inbound chat message (P3-03)")
		fmt.Println("pass -config <path> -read-outbound to read due messages from outbound.db (P3-05)")
		fmt.Println("pass -config <path> -prepare-outbound to create the session's outbound.db schema ahead of a container run (P3-06)")
		fmt.Println("subcommands (Phase 7): status | doctor | trace <id> | security-check — each takes -h for its own flags")
		fmt.Println("subcommand (Phase 9, EC-03): serve — runs the kernel as a long-lived process; -h for its own flags")
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "config invalid: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf(
		"config valid: user=%s agent_group=%s (folder=%s) session=%s data_dir=%s groups_dir=%s\n",
		cfg.UserID, cfg.AgentGroupID, cfg.AgentFolder, cfg.SessionID, cfg.DataDir, cfg.GroupsDir,
	)

	if *prepareOutbound {
		if err := prepareOutboundMailbox(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "prepare-outbound failed: %v\n", err)
			os.Exit(1)
		}
	}

	if *writeChat != "" {
		if err := writeChatMessage(cfg, *writeChat); err != nil {
			fmt.Fprintf(os.Stderr, "write-chat failed: %v\n", err)
			os.Exit(1)
		}
	}

	if *readOutbound {
		if err := readOutboundMessages(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "read-outbound failed: %v\n", err)
			os.Exit(1)
		}
	}
}

// runStatusCmd is P7-01's `nanogo status`.
func runStatusCmd(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", "", "path to a config file (required)")
	kernelSocket := fs.String("kernel-socket", "", "optional kernel Unix socket path to probe for reachability")
	jsonOut := fs.Bool("json", false, "print machine-readable JSON instead of text")
	_ = fs.Parse(args)

	cfg := mustLoadConfig(*configPath, "status")
	report, err := status.Collect(*configPath, cfg, *kernelSocket)
	if *jsonOut {
		printJSON(report)
	} else {
		fmt.Println(report.Human())
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "status: %v\n", err)
		os.Exit(1)
	}
}

// runDoctorCmd is P7-02's `nanogo doctor`. Exits non-zero if any check
// reports LevelFail (a warn alone does not fail the exit code — it is
// informational, matching doctor's own doc comment on what warn means).
func runDoctorCmd(args []string) {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	configPath := fs.String("config", "", "path to a config file (required)")
	kernelSocket := fs.String("kernel-socket", "", "optional kernel Unix socket path to check")
	agentImage := fs.String("agent-image", "", "optional docker image tag to check for locally")
	checkEgressBlock := fs.Bool("check-egress-block", true, "verify the ADR-013 cloud-metadata/link-local firewall rule is active (spawns a short-lived container; set false to skip for a faster, container-free doctor run)")
	jsonOut := fs.Bool("json", false, "print machine-readable JSON instead of text")
	_ = fs.Parse(args)

	cfg := mustLoadConfig(*configPath, "doctor")
	results := doctor.RunAll(context.Background(), doctor.Options{
		Config: cfg, AgentImage: *agentImage, KernelSocket: *kernelSocket, CheckEgressBlock: *checkEgressBlock,
	})

	if *jsonOut {
		printJSON(results)
	} else {
		printChecks(results)
	}
	os.Exit(exitCodeFor(results))
}

// runSecurityCheckCmd is P7-04's `nanogo security-check`. Read-only: it
// changes nothing it inspects, per the task's own instruction.
func runSecurityCheckCmd(args []string) {
	fs := flag.NewFlagSet("security-check", flag.ExitOnError)
	allowlistPath := fs.String("allowlist", "", "optional mount-allowlist.json path to scan for dangerous roots")
	jsonOut := fs.Bool("json", false, "print machine-readable JSON instead of text")
	_ = fs.Parse(args)

	results := securitycheck.RunAll(securitycheck.Options{AllowlistPath: *allowlistPath})
	if *jsonOut {
		printJSON(results)
	} else {
		printChecks(results)
	}
	os.Exit(exitCodeFor(results))
}

// runTraceCmd is P7-03's `nanogo trace <id>`: reads a message/session id's
// recorded events from a durable trace file (see internal/trace's
// AppendToFile/ReadFile) — the same file a live kernel process would have
// been given via trace.NewFileBackedStore. This CLI invocation never holds
// a kernel's in-memory Store itself (a fresh process each time has none),
// which is exactly why the durable file exists.
func runTraceCmd(args []string) {
	fs := flag.NewFlagSet("trace", flag.ExitOnError)
	traceFile := fs.String("trace-file", "", "path to the durable trace file a kernel process was configured with (required)")
	jsonOut := fs.Bool("json", false, "print machine-readable JSON instead of text")
	_ = fs.Parse(args)

	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: nanogo trace -trace-file <path> <message-or-session-id>")
		os.Exit(1)
	}
	if *traceFile == "" {
		fmt.Fprintln(os.Stderr, "trace: -trace-file is required (no kernel daemon exists yet to query instead — see ADR-009)")
		os.Exit(1)
	}
	key := fs.Arg(0)

	events, err := msgtrace.ReadFile(*traceFile, key)
	if err != nil {
		fmt.Fprintf(os.Stderr, "trace: reading %s: %v\n", *traceFile, err)
		os.Exit(1)
	}

	if *jsonOut {
		printJSON(events)
		return
	}
	if len(events) == 0 {
		fmt.Printf("no events recorded for %q in %s\n", key, *traceFile)
		return
	}
	for _, e := range events {
		fmt.Printf("%s  %-16s  %s\n", e.At.UTC().Format(time.RFC3339), e.Stage, e.Summary)
	}
}

func mustLoadConfig(path, cmdName string) config.Config {
	if path == "" {
		fmt.Fprintf(os.Stderr, "%s: -config is required\n", cmdName)
		os.Exit(1)
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: config invalid: %v\n", cmdName, err)
		os.Exit(1)
	}
	return cfg
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintf(os.Stderr, "encoding output: %v\n", err)
		os.Exit(1)
	}
}

// printChecks renders doctor.Result/securitycheck.Result (the same
// underlying type — see securitycheck's doc comment on reusing doctor's
// shape) as one line per check plus an indented remediation line for
// anything not at LevelPass.
func printChecks(results []doctor.Result) {
	for _, r := range results {
		fmt.Printf("[%s] %s: %s\n", strings.ToUpper(string(r.Level)), r.Name, r.Detail)
		if r.Remediation != "" {
			fmt.Printf("    -> %s\n", r.Remediation)
		}
	}
}

func exitCodeFor(results []doctor.Result) int {
	for _, r := range results {
		if r.Level == doctor.LevelFail {
			return 1
		}
	}
	return 0
}

func writeChatMessage(cfg config.Config, text string) error {
	dbPath := mailbox.Path(cfg.DataDir, cfg.AgentGroupID, cfg.SessionID)

	db, err := mailbox.Open(dbPath)
	if err != nil {
		return fmt.Errorf("opening inbound mailbox: %w", err)
	}
	defer func() { _ = db.Close() }()

	content, err := json.Marshal(struct {
		Text string `json:"text"`
	}{Text: text})
	if err != nil {
		return fmt.Errorf("encoding chat content: %w", err)
	}

	rec, err := mailbox.Insert(db, mailbox.InboundMessage{
		ID:        newMessageID(),
		Kind:      mailbox.KindChat,
		Timestamp: mailbox.FormatTimestamp(time.Now()),
		Content:   string(content),
	})
	if err != nil {
		return fmt.Errorf("writing inbound message: %w", err)
	}

	fmt.Printf("wrote inbound message id=%s seq=%d db=%s\n", rec.ID, rec.Sequence, dbPath)
	return nil
}

// readOutboundMessages mirrors what the P3-04 shell harness verified by hand
// with the sqlite3 CLI (`SELECT id, seq, kind, content FROM messages_out
// ORDER BY seq`), but through this package's own validated reader
// (mailbox.DueOutbound) instead of a raw, unvalidated query — the same
// "due" set the real host's delivery path would read (see
// src/mailbox/sqlite/index.ts's getDueMessages), normalized down to the
// fields a recipient actually needs (mailbox.ToDelivery).
func readOutboundMessages(cfg config.Config) error {
	dbPath := mailbox.OutboundPath(cfg.DataDir, cfg.AgentGroupID, cfg.SessionID)

	db, err := mailbox.OpenReadOnly(dbPath)
	if err != nil {
		return fmt.Errorf("opening outbound mailbox: %w", err)
	}
	defer func() { _ = db.Close() }()

	records, err := mailbox.DueOutbound(db)
	if err != nil {
		return fmt.Errorf("reading outbound messages: %w", err)
	}

	if len(records) == 0 {
		fmt.Printf("no due outbound messages in %s\n", dbPath)
		return nil
	}

	for _, rec := range records {
		delivery := mailbox.ToDelivery(rec)
		seq := "?"
		if rec.Sequence != nil {
			seq = fmt.Sprintf("%d", *rec.Sequence)
		}
		fmt.Printf("seq=%s id=%s kind=%s content=%s\n", seq, delivery.ID, delivery.Kind, delivery.Content)
	}
	return nil
}

// prepareOutboundMailbox mirrors what P3-04's shell harness had to do by
// hand with the sqlite3 CLI (hand-writing OUTBOUND_SCHEMA's CREATE TABLE
// statements one column at a time) because this package exposed no setup
// path yet at that point. P3-05's mailbox.OpenForSetup closed that gap;
// this flag is just the CLI surface P3-06 needed to actually call it from a
// shell harness instead of re-deriving the schema by hand a second time.
// Idempotent — safe to call against an already-prepared outbound.db.
func prepareOutboundMailbox(cfg config.Config) error {
	dbPath := mailbox.OutboundPath(cfg.DataDir, cfg.AgentGroupID, cfg.SessionID)

	db, err := mailbox.OpenForSetup(dbPath)
	if err != nil {
		return fmt.Errorf("preparing outbound mailbox: %w", err)
	}
	defer func() { _ = db.Close() }()

	fmt.Printf("prepared outbound mailbox schema at %s\n", dbPath)
	return nil
}

// newMessageID returns a short random hex id — good enough for this proof's
// single-writer usage; not a claim about the real host's id scheme.
func newMessageID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing on a real OS is exceptional; fall back to a
		// timestamp rather than crash a CLI proof tool over it.
		return fmt.Sprintf("msg-%d", time.Now().UnixNano())
	}
	return "msg-" + hex.EncodeToString(buf)
}
