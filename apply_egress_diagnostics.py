#!/usr/bin/env python3
"""
Applies the egress live-Docker diagnostics addition directly by content
anchor, not by line-numbered patch -- this is deliberately NOT a git-apply
patch, because the last two patch rounds drifted from the real pushed
state on this repo and failed to apply. This script finds known, unique
text already in your files and inserts new text next to it, so it works
regardless of surrounding line-number drift. It is safe to run twice: it
detects its own prior work and skips re-inserting.

Run from the repo root (isthmus/):

    python3 apply_egress_diagnostics.py
"""
import sys

CI_PATH = ".github/workflows/ci.yml"
TEST_PATH = "go-host/internal/egress/live_docker_test.go"

CI_ANCHOR = "      - name: egress live-Docker test (ADR-013 Decision 3)\n"
CI_BLOCK = """      # Diagnostic-only (never fails the job on its own — every command is
      # best-effort, `|| true`): two live-Docker fix attempts based on
      # externally-documented iptables-nft/legacy split theories both
      # failed to resolve this job's real failure, which means the theory
      # is missing something specific to this runner. Rather than guess a
      # third time, this step prints ground truth directly from the host
      # (not from inside any helper container, so it can't share whatever
      # bug the container-side mechanism has) — which iptables/nft variant
      # the host resolves by default, whether DOCKER-USER exists under
      # either backend already, and Docker's own reported security/network
      # configuration. Read this output first when this job fails again.
      - name: Diagnose host firewall backend (ground truth, not a guess)
        run: |
          echo "--- iptables --version (host) ---"
          iptables --version || true
          echo "--- ip6tables --version (host) ---"
          ip6tables --version || true
          echo "--- nft --version (host) ---"
          nft --version || true
          echo "--- update-alternatives --display iptables (host) ---"
          update-alternatives --display iptables || true
          echo "--- host: iptables -S DOCKER-USER ---"
          sudo iptables -S DOCKER-USER || true
          echo "--- host: nft list chain ip filter DOCKER-USER ---"
          sudo nft list chain ip filter DOCKER-USER || true
          echo "--- host: nft list ruleset (ip filter table only) ---"
          sudo nft list table ip filter || true
          echo "--- docker info (security/network relevant fields) ---"
          docker info --format 'SecurityOptions: {{.SecurityOptions}} | CgroupDriver: {{.CgroupDriver}}' || true
          echo "--- docker version (server) ---"
          docker version --format '{{.Server.Version}}' || true
          echo "--- kernel ---"
          uname -a || true
        continue-on-error: true
"""

FUNC_ANCHOR = "// TestLive_Ensure_InstallsRealDockerUserRule is this file\'s headline test:"
FUNC_BLOCK = """// dumpContainerDiagnostics runs a single, best-effort diagnostic pass
// inside a --network host helper container — the exact context Ensure and
// Check themselves run in — and logs the full, unsuppressed output via
// t.Logf so it shows up in `go test -v` regardless of whether the calling
// test then passes or fails.
//
// Why this exists: two prior fix attempts for this test's failure were
// each based on a plausible, externally-documented theory (first: Alpine's
// legacy iptables vs Ubuntu's nft-compat default; then: detecting and
// following whichever backend owns DOCKER-USER) and neither actually
// resolved the failure on the real CI runner. Two theory-based fixes
// failing in a row means the theory is missing something specific to this
// environment — the responsible next step is ground truth from the actual
// failing environment, not a third guess. This dumps exactly what
// iptables/nft resolve to and what they can see, from inside the same
// container context Ensure/Check use, so a real failure here carries the
// evidence needed to diagnose it instead of just the bare assertion.
func dumpContainerDiagnostics(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	script := "apk add --no-cache iptables nftables >/dev/null 2>&1; " +
		"echo '== iptables --version =='; iptables --version 2>&1; " +
		"echo '== nft --version =='; nft --version 2>&1; " +
		"echo '== nft list chain ip filter " + dockerUserChain + " =='; nft list chain ip filter " + dockerUserChain + " 2>&1; " +
		"echo '== iptables -S " + dockerUserChain + " =='; iptables -S " + dockerUserChain + " 2>&1; " +
		"echo '== iptables -S (first 20 lines) =='; iptables -S 2>&1 | head -20; " +
		"echo '== nft list ruleset (first 40 lines) =='; nft list ruleset 2>&1 | head -40; " +
		"true"
	// #nosec G204 -- every arg is a fixed literal or this file's own
	// unexported package constants; nothing external/attacker-controlled
	// reaches this argv.
	out, err := exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "host", helperImage, "sh", "-c", script).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	if err != nil {
		t.Logf("dumpContainerDiagnostics: the diagnostic container itself errored (%v) — output so far:\\n%s", err, string(out))
		return
	}
	t.Logf("container-side diagnostics (same --network host context as Ensure/Check):\\n%s", string(out))
}

"""

FATAL1_OLD = '\t\tt.Fatal("FINDING NOT REPRODUCED (good, but re-check this test): after Ensure, an independent `iptables -C` check still does not see the DOCKER-USER DROP rule for " + MetadataCIDR)'
FATAL1_NEW = "\t\tdumpContainerDiagnostics(t)\n" + FATAL1_OLD

FATAL2_OLD = '\t\tt.Fatal("expected the DOCKER-USER rule to still be active after two Ensure calls")'
FATAL2_NEW = "\t\tdumpContainerDiagnostics(t)\n" + FATAL2_OLD


def patch_ci():
    with open(CI_PATH, encoding="utf-8") as f:
        text = f.read()
    if "Diagnose host firewall backend" in text:
        print(f"[skip] {CI_PATH}: diagnostic step already present")
        return
    if CI_ANCHOR not in text:
        sys.exit(f"[FAIL] {CI_PATH}: could not find the expected anchor line. "
                  f"Nothing was changed. Paste this error back so the patch can be adjusted.")
    text = text.replace(CI_ANCHOR, CI_BLOCK + CI_ANCHOR, 1)
    with open(CI_PATH, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"[ok]   {CI_PATH}: inserted diagnostic step")


def patch_test():
    with open(TEST_PATH, encoding="utf-8") as f:
        text = f.read()

    changed = False

    if "func dumpContainerDiagnostics" in text:
        print(f"[skip] {TEST_PATH}: dumpContainerDiagnostics already present")
    else:
        if FUNC_ANCHOR not in text:
            sys.exit(f"[FAIL] {TEST_PATH}: could not find the function-insertion anchor. "
                      f"Nothing was changed. Paste this error back so the patch can be adjusted.")
        text = text.replace(FUNC_ANCHOR, FUNC_BLOCK + FUNC_ANCHOR, 1)
        changed = True

    if FATAL1_NEW in text:
        pass
    elif FATAL1_OLD in text:
        text = text.replace(FATAL1_OLD, FATAL1_NEW, 1)
        changed = True

    if FATAL2_NEW in text:
        pass
    elif FATAL2_OLD in text:
        text = text.replace(FATAL2_OLD, FATAL2_NEW, 1)
        changed = True

    if changed:
        with open(TEST_PATH, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[ok]   {TEST_PATH}: inserted dumpContainerDiagnostics + wired both call sites")
    else:
        print(f"[skip] {TEST_PATH}: both call sites already wired (or already had no matching anchor -- check git diff)")


if __name__ == "__main__":
    patch_ci()
    patch_test()
    print("Done. Now run: git diff --stat")
