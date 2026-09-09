package egress

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
)

// fakeRunner records every invocation and returns a scripted result per
// call, keyed by call index — mirroring the fake-runner pattern already
// used across this project's other packages (doctor, kernel) rather than
// inventing a new mocking convention.
type fakeRunner struct {
	calls []struct {
		name string
		args []string
	}
	results []struct {
		out string
		err error
	}
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	f.calls = append(f.calls, struct {
		name string
		args []string
	}{name, args})
	i := len(f.calls) - 1
	if i < len(f.results) {
		return f.results[i].out, f.results[i].err
	}
	return "", nil
}

func skipUnlessLinux(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("this test exercises the Linux-only code path directly; see TestEnsure_NonLinux_NoOp for the other-platform behavior")
	}
}

func TestEnsure_NonLinux_NoOp(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this test exercises the non-Linux no-op path; covered on Linux by TestEnsure_Linux_RunsHelperContainer")
	}
	run := &fakeRunner{}
	if err := Ensure(context.Background(), run); err != nil {
		t.Fatalf("Ensure on %s: expected nil error (disclosed gap, not a failure), got %v", runtime.GOOS, err)
	}
	if len(run.calls) != 0 {
		t.Fatalf("Ensure on %s: expected zero docker calls, got %d", runtime.GOOS, len(run.calls))
	}
}

func TestCheck_NonLinux_ReportsDisclosedGapNotFailure(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this test exercises the non-Linux path; covered on Linux by TestCheck_Linux_*")
	}
	run := &fakeRunner{}
	res := Check(context.Background(), run)
	if res.Level != LevelWarn {
		t.Fatalf("Check on %s: expected LevelWarn (disclosed gap), got %v", runtime.GOOS, res.Level)
	}
	if len(run.calls) != 0 {
		t.Fatalf("Check on %s: expected zero docker calls, got %d", runtime.GOOS, len(run.calls))
	}
	if !strings.Contains(res.Detail, runtime.GOOS) {
		t.Fatalf("Check on %s: expected Detail to name the platform, got %q", runtime.GOOS, res.Detail)
	}
}

func TestEnsure_Linux_RunsHelperContainer(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	if err := Ensure(context.Background(), run); err != nil {
		t.Fatalf("Ensure: unexpected error: %v", err)
	}
	if len(run.calls) != 1 {
		t.Fatalf("Ensure: expected exactly one docker call, got %d", len(run.calls))
	}
	call := run.calls[0]
	if call.name != "docker" {
		t.Fatalf("Ensure: expected to invoke \"docker\", got %q", call.name)
	}
	joined := strings.Join(call.args, " ")
	for _, want := range []string{"--network", "host", "--cap-add", "NET_ADMIN", helperImage, dockerUserChain, MetadataCIDR, "DROP"} {
		if !strings.Contains(joined, want) {
			t.Errorf("Ensure: expected argv to contain %q, got %q", want, joined)
		}
	}
}

func TestEnsure_Linux_PropagatesRealFailure(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	run.results = append(run.results, struct {
		out string
		err error
	}{"", errors.New("exit status 127: docker: command not found")})
	err := Ensure(context.Background(), run)
	if err == nil {
		t.Fatal("Ensure: expected an error when the helper container invocation fails, got nil")
	}
	if !strings.Contains(err.Error(), "cloud-metadata/link-local block") {
		t.Fatalf("Ensure: expected error to name what failed, got %q", err.Error())
	}
}

func TestCheck_Linux_ActiveReportsPass(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	res := Check(context.Background(), run)
	if res.Level != LevelPass {
		t.Fatalf("Check: expected LevelPass when the runner reports success, got %v (%s)", res.Level, res.Detail)
	}
	if !strings.Contains(res.Detail, MetadataCIDR) {
		t.Fatalf("Check: expected Detail to name %s, got %q", MetadataCIDR, res.Detail)
	}
}

func TestCheck_Linux_AbsentReportsWarnNotFail(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	run.results = append(run.results, struct {
		out string
		err error
	}{"", errors.New("exit status 1")}) // iptables -C's own "rule not found" exit code
	res := Check(context.Background(), run)
	// Deliberately Warn, not Fail: this function cannot yet distinguish
	// "rule genuinely absent" from "helper container itself failed to run"
	// by exit code alone (see the package's Check doc comment) — Warn is
	// the honest signal until that's refined, matching this project's
	// established fail-open-with-a-loud-warning pattern for this class of
	// optional hardening (see ADR-018's EC-05 follow-up on the missing
	// -allowlist warning).
	if res.Level != LevelWarn {
		t.Fatalf("Check: expected LevelWarn when the block can't be confirmed, got %v", res.Level)
	}
}

// TestCheck_Linux_NeverMutates locks in the "never mutates" guarantee at
// the level that actually matters: the shell script Check's helper
// container runs contains no insert command under either backend. It
// deliberately does NOT assert anything about --cap-add NET_ADMIN being
// absent from the container's argv — a real live-CI run proved that
// capability grant is required for a pure read too (listing a
// netlink-backed ruleset needs CAP_NET_ADMIN regardless of intent to write;
// see Check's doc comment for the full story), so Check legitimately
// carries the same capability as Ensure. "Never mutates" is a property of
// what checkScript's commands *do*, not of what capabilities the container
// *has* — conflating the two is exactly what let a real bug (Check unable
// to read the ruleset at all) hide behind this test for two fix rounds.
func TestCheck_Linux_NeverMutates(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	Check(context.Background(), run)
	if len(run.calls) != 1 {
		t.Fatalf("Check: expected exactly one docker call, got %d", len(run.calls))
	}
	joined := strings.Join(run.calls[0].args, " ")
	if strings.Contains(joined, "-I ") || strings.Contains(joined, "nft insert") {
		t.Fatalf("Check: must never mutate (no -I insert, no nft insert) — got argv %q", joined)
	}
	if !strings.Contains(joined, "--cap-add") || !strings.Contains(joined, "NET_ADMIN") {
		t.Fatalf("Check: expected --cap-add NET_ADMIN — reading a netlink-backed ruleset requires it even for a pure list/check (see Check's doc comment) — got argv %q", joined)
	}
	if !strings.Contains(joined, "-C ") {
		t.Fatalf("Check: expected a read-only legacy -C (check) invocation, got argv %q", joined)
	}
	if !strings.Contains(joined, "nft list chain") {
		t.Fatalf("Check: expected a read-only nft list (check) invocation too — see TestScripts_DetectBothNftAndLegacyBackends, got argv %q", joined)
	}
}

// TestScripts_DetectBothNftAndLegacyBackends locks in the fix for a real,
// live-Docker-caught bug: an earlier version of this package's scripts used
// only Alpine's default `iptables` (the legacy ip_tables backend), and
// against a real Docker daemon on ubuntu-24.04 (GitHub Actions CI), an
// Ensure() that reported success left a follow-up independent check unable
// to find the rule — because Ubuntu's system `iptables` (and therefore the
// DOCKER-USER chain Docker itself created) points at the nftables-compat
// backend by default, a completely separate kernel-side ruleset from
// Alpine's legacy `ip_tables`. See detectAndScript's own doc comment for
// the full explanation and links. This test can't exercise the live
// mismatch itself (that needs a real daemon — see live_docker_test.go's
// NANOCLAW_EGRESS_LIVE_DOCKER=1-gated tests) but it does assert both
// backends are actually referenced in both scripts, so a future edit can't
// silently drop the fallback and reintroduce the exact bug that was caught.
func TestScripts_DetectBothNftAndLegacyBackends(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script string
	}{
		{"checkScript", checkScript()},
		{"ensureScript", ensureScript()},
	} {
		for _, want := range []string{"nft list chain ip filter " + dockerUserChain, "iptables -S " + dockerUserChain, "apk add --no-cache iptables nftables"} {
			if !strings.Contains(tc.script, want) {
				t.Errorf("%s: expected script to contain %q, got %q", tc.name, want, tc.script)
			}
		}
	}
	if !strings.Contains(ensureScript(), "nft insert rule ip filter "+dockerUserChain) {
		t.Errorf("ensureScript: expected an nft insert fallback alongside the legacy -I insert, got %q", ensureScript())
	}
	if !strings.Contains(ensureScript(), "iptables -I "+dockerUserChain) {
		t.Errorf("ensureScript: expected a legacy -I insert fallback alongside the nft insert, got %q", ensureScript())
	}
	if strings.Contains(checkScript(), "nft insert rule") || strings.Contains(checkScript(), "iptables -I ") {
		t.Errorf("checkScript: must never mutate under either backend, got %q", checkScript())
	}
}
