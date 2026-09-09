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

// Run executes name (always "docker") with args via the real OS and returns
// its combined output, satisfying Runner.
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

// The three levels a Result can report — see doctor's identically-shaped
// Level type for what each means; this block exists only so egress stays a
// leaf package (see the Level doc comment above for why it isn't imported).
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

// detectAndScript builds the shell script the helper container runs to
// interact with whichever backend actually owns the DOCKER-USER chain on
// this host — mutate=false for a read-only presence check (Check), true to
// also insert the rule when it's missing (Ensure).
//
// Why detection instead of one tool: Debian/Ubuntu — overwhelmingly the
// most common real-world Docker host — has pointed its system `iptables`
// command at the nftables-compat translation layer (iptables-nft) by
// default since roughly Debian 10 / Ubuntu 20.04, so that's the backend
// Docker itself used to create DOCKER-USER there. Alpine's `iptables` apk
// package, by contrast, still defaults to the older, independent
// `ip_tables` kernel-module backend (xtables-legacy) — Alpine's own
// tracker (https://gitlab.alpinelinux.org/alpine/aports/-/issues/14058)
// shows nf_tables still isn't the default as of this writing. Those two
// backends keep separate kernel-side rule tables that don't see each
// other's writes — exactly the "dind runs legacy while the host runs nft,
// so nothing the container writes ever shows up on the host" class of bug
// documented at https://github.com/docker-library/docker/issues/443 and
// https://github.com/tailscale/tailscale/issues/14900. A prior version of
// this package used only Alpine's default `iptables` (legacy) and, run
// against a real Docker daemon in CI (ubuntu-24.04, GitHub Actions), the
// insert reported success while an independent follow-up check could not
// find the rule — this exact mismatch, caught live rather than assumed.
//
// `nft` (from Alpine's separate `nftables` package) always speaks the
// kernel's nf_tables API directly — the same API iptables-nft translates
// into — so checking there first, and falling back to legacy iptables only
// when DOCKER-USER isn't visible via nft, follows whichever backend
// actually created the chain instead of guessing one. iptables-nft's
// compat layer preserves the traditional per-protocol table/chain naming,
// so DOCKER-USER shows up under nft as `chain ip filter DOCKER-USER` (IPv4
// "ip" family, not the newer dual-stack "inet" family, which the compat
// translation doesn't use). If DOCKER-USER exists in neither backend, the
// script exits 3 with a stderr message rather than silently reporting
// success — an unexpected state deserves a loud failure, not a false pass.
func detectAndScript(mutate bool) string {
	nftList := fmt.Sprintf("nft list chain ip filter %s", dockerUserChain)
	nftInsert := fmt.Sprintf("nft insert rule ip filter %s ip daddr %s drop", dockerUserChain, MetadataCIDR)
	legacyProbe := fmt.Sprintf("iptables -S %s", dockerUserChain)
	legacyCheck := fmt.Sprintf("iptables -C %s -d %s -j DROP", dockerUserChain, MetadataCIDR)
	legacyInsert := fmt.Sprintf("iptables -I %s -d %s -j DROP", dockerUserChain, MetadataCIDR)
	grepCIDR := fmt.Sprintf("grep -qF %s", MetadataCIDR)

	nftBranch := grepCIDR + " /tmp/du.nft"
	legacyBranch := legacyCheck + " >/dev/null 2>&1"
	if mutate {
		nftBranch = grepCIDR + " /tmp/du.nft && exit 0; " + nftInsert
		legacyBranch = legacyCheck + " >/dev/null 2>&1 && exit 0; " + legacyInsert
	}

	// Installing both packages is idempotent (a no-op once present); `;`
	// not `&&` so a failed install still lets detection run and surface its
	// own real error rather than masking it behind an install-step failure.
	return "apk add --no-cache iptables nftables >/dev/null 2>&1; " +
		"if " + nftList + " >/tmp/du.nft 2>/dev/null; then " + nftBranch + "; " +
		"elif " + legacyProbe + " >/dev/null 2>&1; then " + legacyBranch + "; " +
		"else echo 'egress: no DOCKER-USER chain found via nft or legacy iptables' >&2; exit 3; fi"
}

func checkScript() string {
	return detectAndScript(false)
}

func ensureScript() string {
	return detectAndScript(true)
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
//
// Check's helper container is granted --cap-add NET_ADMIN even though its
// script never inserts a rule — a real, live-CI-caught bug, not a guess:
// listing a netlink-backed ruleset (`nft list chain ...`, and `iptables -S`/
// `-C` once they resolve through the nft-compat backend, as they do on
// Debian/Ubuntu by default) opens a netlink socket, and the kernel requires
// CAP_NET_ADMIN to do that regardless of whether the caller intends to
// write anything — an unprivileged container gets "Operation not permitted
// (you must be root)" on a pure list/check just as it would on an insert.
// Two earlier fix attempts here targeted the nft-vs-legacy-iptables backend
// split (see detectAndScript's doc comment) because that's a real,
// documented class of bug in this exact "container manipulates the host's
// firewall" pattern — but a live CI run's own diagnostic dump (added to
// gather ground truth after both of those fixes failed to change the
// outcome) showed the actual failure directly: every read attempted by the
// unprivileged verification container failed with "Operation not permitted
// (you must be root)"/"netlink: Error: cache initialization failed:
// Operation not permitted", regardless of backend. The capability, not the
// backend, was the missing piece — granting it here does not weaken the
// "never mutates" guarantee below, since capability governs what the
// container is *allowed* to do, not what checkScript's own read-only
// commands *choose* to do (see TestScripts_DetectBothNftAndLegacyBackends
// and TestCheck_Linux_NeverMutates for the tests that keep that guarantee
// verified independently of this capability grant).
func Check(ctx context.Context, run Runner) Result {
	const name = "egress: cloud-metadata/link-local block"
	if runtime.GOOS != "linux" {
		return unsupportedPlatformResult("check")
	}
	args := []string{"run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", helperImage, "sh", "-c", checkScript()}
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
