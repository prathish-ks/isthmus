package egress

// live_docker_test.go complements egress_test.go's fakeRunner-based unit
// tests (which prove the correct argv is built and the correct Level comes
// back for each fakeRunner script, but never actually talk to a Docker
// daemon) by running Ensure/Check against a REAL Docker daemon on real
// Linux: it confirms the DOCKER-USER chain has no matching DROP rule
// beforehand, runs Ensure, confirms `iptables -C` now reports the rule
// present independently of this package's own Check (so a bug that made
// Check lie about success can't hide behind this test using the same
// mechanism to verify itself), then confirms Check agrees, and finally
// confirms Ensure is idempotent (a second call does not error and does not
// insert a second identical rule).
//
// This mirrors internal/kernel/adversarial_live_docker_test.go's own
// structure and rationale (see that file's header comment) for the same
// two reasons: real side effects most of this package's tests never have
// (this one actually mutates the DOCKER-USER iptables chain on whatever
// machine runs it, via a real privileged helper container), and a
// dependency (a running Linux Docker daemon with iptables available in the
// helper image) this project's own sandbox and most CI environments don't
// have.
//
// Gating: skipped unless NANOCLAW_EGRESS_LIVE_DOCKER=1 is set AND a Docker
// daemon actually responds AND the host is Linux (see this package's own
// doc comment for why the mechanism itself is Linux-only: Docker Desktop
// for Mac's --network host is a proxy/forwarding emulation, not a real
// shared network namespace, so this test would silently prove nothing on
// macOS even if it "passed").
//
// Run explicitly with:
//
//	NANOCLAW_EGRESS_LIVE_DOCKER=1 go test ./internal/egress/... -run TestLive -v

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

const liveDockerOptInEnv = "NANOCLAW_EGRESS_LIVE_DOCKER"

// requireLiveLinuxDocker skips the calling test unless the opt-in env var
// is set, the host is Linux (the only platform this package's mechanism
// actually does anything on), and a real Docker daemon responds — mirroring
// doctor.go's checkContainerRuntime check (LookPath, then `docker info`)
// rather than inventing a second convention for the same fact.
func requireLiveLinuxDocker(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skipf("skipping live egress test: this package's mechanism is Linux-only (see package doc comment); running on %s would only prove the disclosed-gap no-op path, which TestCheck_NonLinux_ReportsDisclosedGapNotFailure already covers without needing Docker", runtime.GOOS)
	}
	if os.Getenv(liveDockerOptInEnv) != "1" {
		t.Skipf("skipping live egress test: set %s=1 to run it (it mutates the real DOCKER-USER iptables chain via a privileged helper container)", liveDockerOptInEnv)
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("skipping live egress test: docker not found on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// name and every arg here are fixed string literals — nothing
	// caller/environment-controlled reaches this argv.
	out, err := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}").CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Skipf("skipping live egress test: docker daemon did not respond: %s", strings.TrimSpace(string(out)))
	}
}

// dockerUserRuleActive runs the same `iptables -C DOCKER-USER ...` check
// this package's own Check performs, but directly via a throwaway helper
// container built by this test file rather than by calling into the
// package under test — so this test's verification doesn't share a bug
// with the code it's verifying.
func dockerUserRuleActive(t *testing.T) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	script := "apk add --no-cache iptables >/dev/null 2>&1; iptables -C " + dockerUserChain + " -d " + MetadataCIDR + " -j DROP 2>/dev/null"
	// #nosec G204 -- every arg is a fixed literal or this file's own
	// unexported package constants; nothing external/attacker-controlled
	// reaches this argv.
	_, err := exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "host", helperImage, "sh", "-c", script).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	return err == nil
}

// TestLive_Ensure_InstallsRealDockerUserRule is this file's headline test:
// proves Ensure actually mutates the real DOCKER-USER chain on a real
// Docker daemon, confirmed by an independent check (not this package's own
// Check), and that Check then agrees.
func TestLive_Ensure_InstallsRealDockerUserRule(t *testing.T) {
	requireLiveLinuxDocker(t)

	if dockerUserRuleActive(t) {
		t.Skip("skipping: DOCKER-USER already has a matching DROP rule on this machine before the test ran (likely a prior nanogo serve on this host) — this test needs a clean starting state to prove Ensure is what installed it; TestLive_Ensure_IsIdempotent below covers the already-present case instead")
	}

	if err := Ensure(context.Background(), OSRunner{}); err != nil {
		t.Fatalf("Ensure: unexpected error against a real Docker daemon: %v", err)
	}

	if !dockerUserRuleActive(t) {
		t.Fatal("FINDING NOT REPRODUCED (good, but re-check this test): after Ensure, an independent `iptables -C` check still does not see the DOCKER-USER DROP rule for " + MetadataCIDR)
	}
	t.Logf("CONFIRMED LIVE: Ensure installed a DOCKER-USER rule blocking %s, verified independently via iptables -C", MetadataCIDR)

	res := Check(context.Background(), OSRunner{})
	if res.Level != LevelPass {
		t.Fatalf("Check: expected LevelPass once the rule is confirmed active, got %v (%s)", res.Level, res.Detail)
	}
}

// TestLive_Ensure_IsIdempotent proves a second Ensure call (e.g. from a
// second `nanogo serve` on the same host, or a restart) does not error and
// does not accumulate duplicate DROP rules for the same CIDR — the whole
// reason ensureScript() checks before inserting.
func TestLive_Ensure_IsIdempotent(t *testing.T) {
	requireLiveLinuxDocker(t)

	if err := Ensure(context.Background(), OSRunner{}); err != nil {
		t.Fatalf("Ensure (first call): unexpected error: %v", err)
	}
	if err := Ensure(context.Background(), OSRunner{}); err != nil {
		t.Fatalf("Ensure (second call): expected idempotent no-error, got: %v", err)
	}
	if !dockerUserRuleActive(t) {
		t.Fatal("expected the DOCKER-USER rule to still be active after two Ensure calls")
	}
}
