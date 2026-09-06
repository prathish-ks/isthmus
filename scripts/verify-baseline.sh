#!/bin/bash
#
# P2-05: one-command baseline verification for the TypeScript-host
# differential-testing harness (src/differential/).
#
# Runs the full fixture suite in CI mode (CI=true). Vitest's snapshot
# behavior changes under CI=true: it will NOT write a new snapshot for a
# fixture that doesn't have one committed yet, and it FAILS the run on any
# of — a mismatched snapshot (real behavioral drift in the TypeScript host),
# a missing snapshot (a new fixture whose baseline was never generated and
# reviewed), or an obsolete snapshot (a stale .snap entry with no matching
# test left). A bare `pnpm test src/differential/` on a machine with no
# committed .snap files would happily create them and exit 0 — this script
# exists specifically so that can never happen silently: it only ever
# VERIFIES an existing golden baseline, it never generates one.
#
# Usage:  ./scripts/verify-baseline.sh
#     or: pnpm run verify:baseline
#
# To intentionally update the baseline after a reviewed, deliberate
# behavior change: run `pnpm test src/differential/ -- -u` locally
# (outside CI mode), review the resulting .snap diff by hand, then commit
# it — never regenerate snapshots inside this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

FIXTURE_DIR="src/differential"
SNAPSHOT_DIR="$FIXTURE_DIR/__snapshots__"

log() { echo "[verify-baseline] $*"; }

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "[verify-baseline] $FIXTURE_DIR not found — run this from a checkout that has the differential-testing harness (P2-01 onward)." >&2
  exit 1
fi

SNAP_COUNT=$(find "$SNAPSHOT_DIR" -name '*.snap' 2>/dev/null | wc -l | tr -d ' ')
if [ "$SNAP_COUNT" -eq 0 ]; then
  echo "[verify-baseline] No committed .snap files found under $SNAPSHOT_DIR — nothing to verify against." >&2
  echo "[verify-baseline] This script only verifies an existing baseline; it deliberately will not generate one." >&2
  exit 1
fi

log "Verifying the TypeScript-host baseline: $SNAP_COUNT committed snapshot file(s) under $SNAPSHOT_DIR"
log "Running in CI mode (no snapshot writes; fails on mismatch, missing, or obsolete snapshots)."
echo

CI=true pnpm exec vitest run "$FIXTURE_DIR" --reporter=verbose

echo
log "Baseline verified: every differential fixture matched its committed golden snapshot, with no missing or obsolete entries."
