#!/usr/bin/env bash
# EC-08: egress lockdown's real network isolation, live — wrapper.
#
# The proof itself is scripts/ec08-egress-lockdown-live-smoke.ts (read its
# header first). This wrapper does the things that have to happen around it
# and must be undone afterwards — the same three ec07-live-host-smoke.sh
# does (build nanogo, install the deterministic provider, clean up on every
# exit path), plus one more this proof specifically needs:
#
#   4. creates a minimal stand-in OneCLI gateway container — a real, running
#      container named ONECLI_GATEWAY_CONTAINER (default "onecli"), which is
#      all ensureEgressNetwork()'s gatewayAttached()/connect calls actually
#      need to exist. The real onecli gateway needs a live vault, which no
#      CI runner has; this proof is about network topology, not credential
#      flow, so a `sleep infinity` container under the expected name is a
#      faithful enough stand-in — removed on every exit path, same as the
#      barrel import and the scratch install.
#
# Usage: scripts/ec08-egress-lockdown-live-smoke.sh
#
# Preconditions the harness checks and names for you: a reachable Docker
# daemon, this checkout's agent image already built (./container/build.sh),
# and no existing data/v2.db (this seeds its own central DB and refuses to
# share a real install's).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BARREL="container/agent-runner/src/providers/index.ts"
BARREL_BACKUP=""
IMPORT_LINE="import './livesmoke.js';"
GATEWAY_NAME="${ONECLI_GATEWAY_CONTAINER:-onecli}"
EGRESS_NET="${NANOCLAW_EGRESS_NETWORK:-nanoclaw-egress}"
GATEWAY_CREATED=0

# Everything this run creates, removed on exit. Listed explicitly rather than
# wiping data/ and groups/ wholesale — see ec07-live-host-smoke.sh's own
# comment on the identical SCRATCH array for why.
SCRATCH=(
  "data/v2.db"
  "data/v2.db-shm"
  "data/v2.db-wal"
  "data/cli.sock"
  "data/ncl.sock"
  "data/nanogo-kernel.sock"
  "data/nanogo-serve-config.json"
  "data/nanogo-kernel-trace.json"
  "data/v2-sessions/ag-ec08-egress-lockdown"
  "groups/ec08-egress-lockdown"
)

cleanup() {
  local status=$?
  if [ -n "$BARREL_BACKUP" ] && [ -f "$BARREL_BACKUP" ]; then
    mv "$BARREL_BACKUP" "$BARREL"
    echo "-- provider barrel restored --"
  fi
  if [ "$GATEWAY_CREATED" = "1" ]; then
    docker rm -f "$GATEWAY_NAME" >/dev/null 2>&1 || true
    echo "-- stand-in gateway container ($GATEWAY_NAME) removed --"
  fi
  # The egress network itself is left in place, same as a real install:
  # ensureEgressNetwork() is idempotent and self-healing by design (it
  # inspects-before-create on every call), so a leftover network from this
  # run is harmless and removing it here would race a concurrent run on a
  # shared runner. `docker network rm` also refuses while anything is still
  # attached, so a failed cleanup here could mask the real failure above.
  for p in "${SCRATCH[@]}"; do
    rm -rf "$REPO_ROOT/$p"
  done
  exit $status
}
trap cleanup EXIT

echo "== EC-08 wrapper: building nanogo, installing the deterministic provider =="

mkdir -p go-host/bin
( cd go-host && go build -mod=vendor -o bin/nanogo ./cmd/nanogo )
echo "nanogo built at go-host/bin/nanogo"

if grep -qF "$IMPORT_LINE" "$BARREL"; then
  echo "error: $BARREL already imports the live-smoke provider." >&2
  echo "That line is installed for the duration of a run and removed afterwards —" >&2
  echo "a leftover one means a previous run died without its trap. Remove it and re-run." >&2
  exit 1
fi
BARREL_BACKUP="$(mktemp -t ec08-barrel-XXXX)"
cp "$BARREL" "$BARREL_BACKUP"
printf '%s\n' "$IMPORT_LINE" >> "$BARREL"
echo "provider installed: $BARREL now imports ./livesmoke.js"

if docker inspect "$GATEWAY_NAME" --format '{{.State.Running}}' >/dev/null 2>&1; then
  echo "error: a container named \"$GATEWAY_NAME\" already exists." >&2
  echo "This wrapper creates and removes its own stand-in gateway container —" >&2
  echo "a leftover one means a previous run died without its trap, or this is a real install's" >&2
  echo "actual OneCLI gateway, which this harness must not touch. Resolve that and re-run." >&2
  exit 1
fi
docker run -d --name "$GATEWAY_NAME" --label nanoclaw-ec08-stub=1 alpine:3 sleep infinity >/dev/null
GATEWAY_CREATED=1
echo "stand-in gateway container started: $GATEWAY_NAME (alpine, sleep infinity)"
echo

export NANOCLAW_EGRESS_LOCKDOWN=true
export NANOCLAW_GATEWAY_PROVIDER="${NANOCLAW_GATEWAY_PROVIDER:-none}"

pnpm exec tsx scripts/ec08-egress-lockdown-live-smoke.ts
