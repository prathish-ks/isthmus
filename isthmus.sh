#!/usr/bin/env bash
#
# Isthmus — single entry point for both a fresh install and migrating an
# existing NanoClaw (or an older Isthmus) checkout in place.
#
# Why this exists rather than running go-host/scripts/install.sh and
# nanoclaw.sh separately: as of the enforcement-wiring work (EC-02),
# container-runner.ts's three privileged operations (create, stop/remove,
# build image) call the Go kernel exclusively — there is no remaining
# native-TypeScript fallback. If the nanogo binary is missing, Isthmus
# cannot spawn or build containers at all (see docs/rollback-runbook.md).
# So the two scripts were never independently useful to an end user, only
# to release engineering — this wrapper reflects that reality instead of
# implying they're separately optional steps.
#
# What this script does, in order:
#   1. --help/-h/--uninstall: hand off straight to nanoclaw.sh, unchanged.
#      Neither needs the kernel installed first.
#   2. Detect an in-place migration: data/upgrade-state.json already
#      existing means this checkout was previously set up (stock NanoClaw
#      or an older Isthmus install), not a brand-new clone.
#   3. Install the nanogo kernel binary FIRST (go-host/scripts/install.sh,
#      unmodified) — before setup runs, not after, so there is no window
#      where setup could finish but the very first host start still finds
#      no kernel binary. (Verified safe to reorder this way: the
#      setup-time agent image build is a plain `docker build`/pull, not
#      kernel-mediated at all — see setup/container.ts. The kernel only
#      matters once the host actually starts spawning session containers,
#      step 4 either way.)
#   4. Hand off to the existing nanoclaw.sh / setup:auto flow, unchanged.
#   5. If this was an in-place migration (step 2), stamp the upgrade
#      marker so the startup tripwire (docs/upgrade-recovery.md) doesn't
#      fire on next start. This mirrors exactly what /setup,
#      /update-nanoclaw, and /migrate-nanoclaw already do at the end of a
#      supported upgrade — see that doc's "If you have your own upgrade
#      flow" section, which asks precisely this of any installer that
#      isn't one of those three built-in paths. Skipping this step is
#      the documented gap that used to leave a migrating tester to hit
#      "update did not go through the supported path" cold.
#
# Usage: bash isthmus.sh [nanoclaw.sh options]
#   All flags are passed through to nanoclaw.sh unchanged (--template-path,
#   --uninstall, --help). go-host/scripts/install.sh is always run with no
#   flags (default: build from a local Go toolchain if present, otherwise
#   download and checksum-verify the latest isthmus-v* release binary); if
#   you need --force-download or --tag for the kernel install specifically,
#   run go-host/scripts/install.sh directly instead of through this wrapper.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# --help/-h/--uninstall: neither needs the kernel installed, and running
# the kernel installer first would be actively wrong for --uninstall (it
# would install something we're about to tear down) and pointless for
# --help. Hand off directly, matching nanoclaw.sh's own early exit for
# these same flags.
for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ] || [ "$arg" = "--uninstall" ]; then
    echo "isthmus.sh: installs the nanogo security kernel, then runs the"
    echo "normal NanoClaw installer. For --help/--uninstall specifically,"
    echo "handing off directly to nanoclaw.sh (no kernel install needed):"
    echo
    exec bash "$PROJECT_ROOT/nanoclaw.sh" "$@"
  fi
done

MIGRATING=0
if [ -f "$PROJECT_ROOT/data/upgrade-state.json" ]; then
  MIGRATING=1
  echo "Existing NanoClaw/Isthmus install detected (data/upgrade-state.json"
  echo "present) — migrating this checkout in place rather than a fresh"
  echo "install. Your existing data directory, sessions, and config are"
  echo "untouched by anything below; see docs/rollback-runbook.md if you"
  echo "want to verify or revert this afterward."
  echo
fi

echo "=== Installing the nanogo security kernel ==="
bash "$PROJECT_ROOT/go-host/scripts/install.sh"

echo
echo "=== Running the NanoClaw installer ==="
bash "$PROJECT_ROOT/nanoclaw.sh" "$@"

if [ "$MIGRATING" -eq 1 ]; then
  echo
  echo "=== Migration complete — stamping the upgrade marker ==="
  echo "Without this, the next host start would refuse to run with"
  echo "\"update did not go through the supported path\" — see"
  echo "docs/upgrade-recovery.md. This is the same stamp /setup,"
  echo "/update-nanoclaw, and /migrate-nanoclaw already do for their own"
  echo "supported paths."
  pnpm exec tsx "$PROJECT_ROOT/scripts/upgrade-state.ts" set
fi
