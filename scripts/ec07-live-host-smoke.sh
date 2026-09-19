#!/usr/bin/env bash
# EC-07: the live-Docker leg with the TypeScript host in front — wrapper.
#
# The proof itself is scripts/ec07-live-host-smoke.ts (read its header first;
# it explains what is real, what is substituted, and why it is not a vitest
# test). This wrapper does the three things that have to happen around it and
# must be undone afterwards:
#
#   1. builds `nanogo` where the kernel supervisor looks for it, so the host
#      spawns a kernel of THIS checkout rather than whatever binary is on the
#      PATH (the stale-binary trap p3-06-e2e.sh's own comment records);
#   2. installs the deterministic provider by appending one import line to
#      the agent-runner's provider barrel — the same mechanism /add-opencode
#      uses, and the only way a provider can reach a container whose command
#      the host composes (see livesmoke.ts's header). No image rebuild is
#      needed for this: the Dockerfile bakes /app/node_modules but never
#      /app/src, which container-runner.ts bind-mounts read-only from
#      container/agent-runner/src at spawn — so the container reads the
#      barrel this line was just appended to;
#   3. removes that line again, and the scratch install the harness seeded,
#      on every exit path including a failure or a Ctrl-C.
#
# Usage: scripts/ec07-live-host-smoke.sh [repeats]
#   repeats defaults to 2, against ONE long-lived host process — the same
#   within-process-lifetime property EC-06 checks, now including the host's
#   own session registry and delivery poll, not only the kernel's.
#
# Preconditions the harness checks and names for you: a reachable Docker
# daemon, this checkout's agent image already built (./container/build.sh),
# and no existing data/v2.db (this seeds its own central DB and refuses to
# share a real install's).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

REPEATS="${1:-2}"
BARREL="container/agent-runner/src/providers/index.ts"
BARREL_BACKUP=""
IMPORT_LINE="import './livesmoke.js';"

# Everything this run creates, removed on exit. Listed explicitly rather than
# wiping data/ and groups/ wholesale: this harness refuses to run against an
# existing data/v2.db, but a checkout can still have session state from an
# earlier ec06 run, and that is not ours to delete.
SCRATCH=(
  "data/v2.db"
  "data/v2.db-shm"
  "data/v2.db-wal"
  "data/cli.sock"
  "data/ncl.sock"
  "data/nanogo-kernel.sock"
  "data/nanogo-serve-config.json"
  "data/nanogo-kernel-trace.json"
  "data/v2-sessions/ag-ec07-livesmoke"
  "groups/ec07-livesmoke"
)

cleanup() {
  local status=$?
  if [ -n "$BARREL_BACKUP" ] && [ -f "$BARREL_BACKUP" ]; then
    mv "$BARREL_BACKUP" "$BARREL"
    echo "-- provider barrel restored --"
  fi
  for p in "${SCRATCH[@]}"; do
    rm -rf "$REPO_ROOT/$p"
  done
  exit $status
}
trap cleanup EXIT

echo "== EC-07 wrapper: building nanogo, installing the deterministic provider =="

# Always rebuilt, never reused: a stale nanogo silently missing a newly-added
# flag has burned this project before (see p3-06-e2e.sh's own note). bin/ is
# the first path locateNanogoBinary() checks, so this is also what a real
# install's go-host/scripts/install.sh produces.
mkdir -p go-host/bin
( cd go-host && go build -mod=vendor -o bin/nanogo ./cmd/nanogo )
echo "nanogo built at go-host/bin/nanogo"

if grep -qF "$IMPORT_LINE" "$BARREL"; then
  echo "error: $BARREL already imports the live-smoke provider." >&2
  echo "That line is installed for the duration of a run and removed afterwards —" >&2
  echo "a leftover one means a previous run died without its trap. Remove it and re-run." >&2
  exit 1
fi
BARREL_BACKUP="$(mktemp -t ec07-barrel-XXXX)"
cp "$BARREL" "$BARREL_BACKUP"
printf '%s\n' "$IMPORT_LINE" >> "$BARREL"
echo "provider installed: $BARREL now imports ./livesmoke.js"
echo

pnpm exec tsx scripts/ec07-live-host-smoke.ts "$REPEATS"
