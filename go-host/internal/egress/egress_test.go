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

func TestCheck_Linux_NeverMutates(t *testing.T) {
	skipUnlessLinux(t)
	run := &fakeRunner{}
	Check(context.Background(), run)
	if len(run.calls) != 1 {
		t.Fatalf("Check: expected exactly one docker call, got %d", len(run.calls))
	}
	joined := strings.Join(run.calls[0].args, " ")
	if strings.Contains(joined, "-I ") || strings.Contains(joined, "--cap-add") {
		t.Fatalf("Check: must never mutate (no -I insert, no NET_ADMIN) — got argv %q", joined)
	}
	if !strings.Contains(joined, "-C ") {
		t.Fatalf("Check: expected a read-only -C (check) invocation, got argv %q", joined)
	}
}
