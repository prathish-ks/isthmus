// Package egress implements ADR-013's Decision 3 (docs/ADR-013-p8-05-egress-network-controls.md):
// block outbound reachability to the cloud-metadata/link-local address
// range (169.254.0.0/16 — the range AWS, GCP, and Azure all use for their
// instance-metadata services) from every agent container, regardless of
// whether NANOCLAW_EGRESS_LOCKDOWN (src/egress-lockdown.ts) is enabled.
// That existing feature is a much stronger, opt-in posture (agents get NO
// internet route except through the OneCLI gateway); this package is a
// narrow, always-on-by-default denylist entry with — per the ADR's own
// evidence — near-zero compatibility cost, because no legitimate skill or
// MCP tool has a reason to reach a cloud metadata endpoint.
//
// # Why a container, not a direct host exec
//
// Docker has no `docker create`/`docker run` flag that blocks a specific
// destination CIDR — ADR-013 named the real mechanism as a firewall rule on
// DOCKER-USER, the chain Docker itself reserves for exactly this kind of
// operator-added rule. That rule has to live in the network namespace where
// the real Docker daemon's bridge networks terminate. On native Linux,
// that's simply the host's own namespace, reachable via a normal
// `exec.Command("iptables", ...)` from this process. On Docker Desktop
// (macOS), it is NOT — dockerd runs inside a hidden Linux VM, and this
// process's own host (macOS) has no netfilter tables Docker's containers
// ever consult at all. Running `iptables` on the Mac's own shell would
// silently do nothing.
//
// The fix that reaches the right namespace on both platforms would be a
// helper container run with `--network host` — same Docker daemon, so it
// lands in the same namespace bridge networks terminate in, on any OS.
// This was the original design here, until real verification (checking
// Docker Desktop's own documented behavior, not assuming) found it doesn't
// hold: Docker Desktop for Mac's `--network host` (beta since v4.31) is
// explicitly NOT a real shared network namespace — Docker's own community
// forum describes it as implemented through "proxies/forwarding rules,"
// not kernel-level namespace sharing. A helper container run that way could
// insert a rule that never affects the bridge networks agent containers
// actually run on, while doctor/security-check reports a false PASS.
//
// # What this package actually does, honestly scoped
//
// Linux only, for now. Ensure/Check both no-op with a clearly-labeled
// "not implemented on this platform" result on any other GOOS, rather than
// attempting a mechanism known not to hold there. This mirrors the
// project's existing practice of naming a real platform gap outright (see
// docs/ADR — the native-Windows POSIX-host-path limitation) instead of
// implying broader coverage than what's actually verified. A macOS-covering
// mechanism (most likely something built on Docker Desktop's own
// networking internals, not a plain container) is a real follow-up, not
// solved here.
package egress

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// MetadataCIDR is the link-local range every major cloud provider (AWS,
// GCP, Azure) uses for its instance-metadata service — see the package doc
// comment and ADR-013 Decision 3 for why this specific range and nothing
// broader.
const MetadataCIDR = "169.254.0.0/16"

// dockerUserChain is the chain Docker itself reserves for operator-added
// rules that must survive Docker's own chain manipulation on daemon
// restart — the documented, correct extension point for exactly this case.
const dockerUserChain = "DOCKER-USER"

// helperImage is a small, official base image used only to run `iptables`
// inside the Docker daemon's own network namespace (see the package doc
// comment). Pinned to a specific release, not `latest`.
//
// TODO(security): pin by digest, not just tag, once run somewhere with
// registry access — this was written in a sandboxed environment whose
// egress policy blocks the Docker Hub registry API, so a verified digest
// could not be looked up while authoring this.
const helperImage = "alpine:3.20"

// Runner is the narrow seam this package's Docker calls go through, so
// tests can fake the one external dependency (what `docker` prints, what
// it exits with) without a real Docker daemon. Deliberately smaller than
// doctor.CommandRunner (Run only, no LookPath) — any doctor.CommandRunner
// value already satisfies this by having a compatible Run method.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// OSRunner is the production Runner: the real `docker` binary via os/exec.
type OSRunner struct{}

func (OSRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	// name is always the literal "docker" passed by this file's own callers
	// (Ensure/Check above) and args are entirely fixed by this package
	// (helperImage, the DOCKER-USER chain name, MetadataCIDR) — never
	// caller-supplied or remote input, and exec.Command never invokes a
	// shell for this outer call (the inner `sh -c` runs inside the helper
	// container's own filesystem, not this process's).
	// #nosec G204 -- name is always the literal "docker"; args are fixed by this package, not attacker input
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return strings.TrimSpace(string(out)), err
}

// Level mirrors internal/doctor's Level, redeclared here (not imported) so
// this package stays a leaf with no dependency on doctor — doctor imports
// egress, not the other way around, avoiding an import cycle.
type Level string

const (
	LevelPass Level = "pass"
	LevelWarn Level = "warn"
	LevelFail Level = "fail"
)

// Result mirrors internal/doctor's Result shape — see the Level comment
// above for why this is redeclared rather than imported. Callers that want
// a doctor.Result convert this trivially (identical field names/types).
type Result struct {
	Name        string
	Level       Level
	Detail      string
	Remediation string
}

func unsupportedPlatformResult(verb string) Result {
	return Result{
		Name:  "egress: cloud-metadata/link-local block",
		Level: LevelWarn,
		Detail: fmt.Sprintf(
			"not implemented on %s yet (%s skipped) — see internal/egress's package doc comment for why Docker Desktop's own network isolation makes the Linux mechanism unreliable here",
			runtime.GOOS, verb,
		),
		Remediation: "no action needed; this is a disclosed gap, not a misconfiguration. Tracked in docs/ADR-013-p8-05-egress-network-controls.md",
	}
}

func checkScript() string {
	return fmt.Sprintf("iptables -C %s -d %s -j DROP 2>/dev/null", dockerUserChain, MetadataCIDR)
}

func ensureScript() string {
	check := checkScript()
	insert := fmt.Sprintf("iptables -I %s -d %s -j DROP", dockerUserChain, MetadataCIDR)
	// apk install first (idempotent itself — a no-op if already present);
	// `;` not `&&` so a failed install still lets the two iptables calls
	// run and surface their own real error (e.g. binary genuinely missing)
	// rather than masking it behind an install-step failure.
	return fmt.Sprintf("apk add --no-cache iptables >/dev/null 2>&1; %s && exit 0; %s", check, insert)
}

// Ensure installs the DOCKER-USER rule blocking MetadataCIDR if it is not
// already present. Idempotent — safe to call on every kernel startup, in
// keeping with this project's other startup-time self-healing checks (see
// src/egress-lockdown.ts's ensureEgressNetwork for the same shape on the TS
// side). Mutates host firewall state via a one-shot helper container;
// unlike Check below, never called from doctor/security-check, which must
// never change what they inspect.
func Ensure(ctx context.Context, run Runner) error {
	if runtime.GOOS != "linux" {
		// Not an error — a disclosed, known gap (see package doc comment).
		// The caller (nanogo serve) is expected to report this via its own
		// warn callback, mirroring how it already handles a missing
		// -allowlist (ADR-018/EC-05 follow-up), not fail the whole process.
		return nil
	}
	args := []string{"run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", helperImage, "sh", "-c", ensureScript()}
	if _, err := run.Run(ctx, "docker", args...); err != nil {
		return fmt.Errorf("egress: could not install cloud-metadata/link-local block: %w", err)
	}
	return nil
}

// Check is doctor's read-only view: reports whether the block is active
// without ever changing anything (this package's mutating call is Ensure,
// called only from nanogo serve's startup path — see doc.go's
// non-capabilities convention for why doctor/security-check never mutate).
func Check(ctx context.Context, run Runner) Result {
	const name = "egress: cloud-metadata/link-local block"
	if runtime.GOOS != "linux" {
		return unsupportedPlatformResult("check")
	}
	args := []string{"run", "--rm", "--network", "host", helperImage, "sh", "-c", checkScript()}
	if _, err := run.Run(ctx, "docker", args...); err != nil {
		return Result{
			Name:  name,
			Level: LevelWarn,
			Detail: MetadataCIDR + " (cloud-metadata/link-local) is NOT confirmed blocked — an agent " +
				"container may be able to reach cloud instance-metadata services",
			Remediation: "run `nanogo serve` without -block-metadata-egress=false, or see ADR-013 for the manual iptables rule",
		}
	}
	return Result{
		Name:   name,
		Level:  LevelPass,
		Detail: "DOCKER-USER firewall rule blocking " + MetadataCIDR + " is active",
	}
}
