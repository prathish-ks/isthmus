#!/usr/bin/env bash
# EC-06 (Phase 9, post-EC-02): protocol integration + live smoke test against
# the actual kernel-mediated path — closes docs/release-gate-checklist.md's
# rows 5 ("protocol integration ... Go inbound -> real agent-runner -> Go
# outbound end to end ... not yet automatable — must be re-run manually
# before each release") and 11 ("live smoke tests ... no CI job stands up a
# real container + real provider + a real test channel ... must be run
# against the actual release candidate, with the Go kernel in the live path
# ... has not happened since EC-02 landed").
#
# What this proves that scripts/p3-06-e2e.sh does NOT: P3-06 proved the
# mailbox wire contract (CLI -> Go inbound.db -> real agent-runner -> fake
# provider -> Go outbound.db) is exact and repeatable — but it was written
# before EC-02 existed, so it still issues `docker create`/`docker start`
# itself, exactly like P3-04's harness before it. That is precisely the
# enforcement gap EC-02 closed in the real system (container-runner.ts no
# longer calls docker directly at all) — so a proof harness that still
# bypasses the kernel is no longer proving what the running system actually
# does. This script changes exactly one thing from P3-06's proven recipe:
# instead of this script calling docker itself, it starts a REAL `nanogo
# serve` process and drives container.wake/container.kill through its real
# Unix socket, using go-host/cmd/livesmoke (a throwaway NDJSON wire-protocol
# client — see that file's own doc comment for why it is not a nanogo
# subcommand). Every mount/env/entrypoint/provider-swap decision below still
# mirrors P3-04/P3-06's already-proven recipe field-for-field; the only
# thing that changed is WHO issues docker create/start/stop/rm, and under
# what name — the kernel now does both, using ContainerName(spec.Key), a
# name it derives itself and this script never computes or asserts in
# advance (see internal/kernel/naming.go) — exactly the property EC-02
# exists to guarantee, now demonstrated live rather than only in a Go test
# fixture.
#
# What this does NOT attempt: a "real test channel" in the sense of a real
# Slack/Discord/CLI channel adapter round trip (release-gate-checklist.md
# row 11's other named piece) — that is TypeScript-host routing/channel
# infrastructure this proof's scope (mirroring P3-06's own explicit
# boundary) deliberately does not touch. What it DOES prove live, for the
# first time since EC-02 landed: a real Docker daemon, a real unmodified
# agent-runner image, and a real message round trip, with container
# lifecycle fully kernel-mediated end to end.
#
# Usage: IMAGE_TAG=<local agent image tag> scripts/ec06-live-smoke.sh [repeats]
#   repeats defaults to 2, run against ONE long-lived `nanogo serve` process
#   (started once, torn down once) — proving not just one wake/kill cycle
#   but that the kernel's in-process registry correctly handles repeated
#   independent session lifecycles without needing a restart between them
#   (P9-03's restart tests already cover behavior ACROSS a kernel restart;
#   this is the complementary within-process-lifetime case).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
GROUPS_DIR="$REPO_ROOT/groups"

AGENT_GROUP_ID="${AGENT_GROUP_ID:-ag-1788008257480-b2n3zv}"
GROUP_FOLDER="${GROUP_FOLDER:-ping_test}"
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG to the local agent image tag (see \`docker images\` — the one nanoclaw.sh built)}"
MESSAGE="${MESSAGE:-ec06 kernel-mediated deterministic end-to-end proof}"
REPEATS="${1:-2}"

GROUP_DIR="$GROUPS_DIR/$GROUP_FOLDER"
MOCK_PROVIDER_SRC="$REPO_ROOT/scripts/p3-06-mock-provider.ts"

# Same fixed reply p3-06-mock-provider.ts always returns — see that file's
# own header comment for exactly why it takes this shape (isError:true, zero
# <message> blocks, routed through poll-loop.ts's deliverErrorResult).
EXPECTED_CONTENT='{"text":"p3-06: deterministic reply from the fake provider"}'

echo "== EC-06: kernel-mediated protocol integration + live smoke test ($REPEATS run(s)) =="
echo "agent group : $AGENT_GROUP_ID ($GROUP_FOLDER)"
echo "image       : $IMAGE_TAG"
echo "expecting   : kind=chat content=$EXPECTED_CONTENT"
echo

if [ ! -d "$GROUP_DIR" ]; then
  echo "error: group folder not found: $GROUP_DIR" >&2
  echo "(reuses the ping_test group's scaffolding purely as harmless generic scaffolding —" >&2
  echo " override GROUP_FOLDER/AGENT_GROUP_ID if you're pointing at a different group)" >&2
  exit 1
fi
if [ ! -f "$MOCK_PROVIDER_SRC" ]; then
  echo "error: mock provider script not found: $MOCK_PROVIDER_SRC (see scripts/p3-06-mock-provider.ts)" >&2
  exit 1
fi
if ! command -v python3 > /dev/null 2>&1; then
  echo "error: python3 is required (used to safely build/parse the kernel wire-protocol JSON)" >&2
  exit 1
fi

NANOGO="$REPO_ROOT/go-host/nanogo"
LIVESMOKE="$REPO_ROOT/go-host/livesmoke"
# Always rebuild both, never reuse whatever binary happens to be lying
# around — see p3-06-e2e.sh's own comment for why this burned someone
# before (a stale nanogo silently missing a newly-added flag).
echo "building nanogo and livesmoke (always rebuilt)..."
( cd "$REPO_ROOT/go-host" && go build -o nanogo ./cmd/nanogo && go build -o livesmoke ./cmd/livesmoke )

GLOBAL_TMP="$(mktemp -d -t ncl-ec06-global-XXXX)"
SOCKET_PATH="${SOCKET_PATH:-/tmp/ncl-ec06-$$.sock}"
ALLOWLIST_JSON="$GLOBAL_TMP/mount-allowlist.json"
SERVE_CONFIG="$GLOBAL_TMP/serve-config.json"
SERVE_LOG="$GLOBAL_TMP/serve.log"

# Empty allowedRoots is deliberate and sufficient here: this proof's own
# mounts are all group-state/install-surface, never allowlisted-extra, so
# there is nothing for this file to actually list — its only job is to be
# PRESENT, so `nanogo serve` doesn't emit ADR-018's "no -allowlist
# configured" warning for a run that has nothing to do with that gap. Same
# fixture shape as go-host/cmd/nanogo/serve_test.go's own
# TestBuildServeKernel_AllowlistConfigured_NoAllowlistWarning.
printf '{"allowedRoots":[]}' > "$ALLOWLIST_JSON"

# serve's own config only needs data_dir/groups_dir — buildServeKernel never
# reads agent_group_id/session_id at all — but config.Load's schema is
# shared across every nanogo subcommand, so this still needs placeholder
# values in every field it requires.
cat > "$SERVE_CONFIG" <<EOF
{
  "data_dir": "$DATA_DIR",
  "groups_dir": "$GROUPS_DIR",
  "user_id": "u-ec06-proof",
  "agent_group_id": "$AGENT_GROUP_ID",
  "agent_folder": "$GROUP_FOLDER",
  "session_id": "ec06-serve-config-unused"
}
EOF

rm -f "$SOCKET_PATH"
echo "-- starting nanogo serve (real long-lived process, real Unix socket) --"
"$NANOGO" serve -config "$SERVE_CONFIG" -kernel-socket "$SOCKET_PATH" \
  -allowlist "$ALLOWLIST_JSON" -surface-root "$REPO_ROOT/container" \
  > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!

cleanup_all() {
  echo "-- stopping nanogo serve (pid $SERVE_PID) --"
  kill "$SERVE_PID" > /dev/null 2>&1 || true
  wait "$SERVE_PID" 2>/dev/null || true
  rm -rf "$GLOBAL_TMP"
  rm -f "$SOCKET_PATH"
}
trap cleanup_all EXIT
# Known limitation: each run-loop iteration below temporarily shadows this
# trap with its own per-run cleanup_run (re-armed as cleanup_all again once
# the loop finishes — see the matching comment right before the final exit).
# An interactive Ctrl-C DURING a run (not between runs) fires that run's
# cleanup_run instead of this one, so nanogo serve itself would be left
# running in that specific case — `pkill -f 'nanogo serve'` recovers if it
# ever happens. Not worth a signal-trap dispatcher for a one-off proof
# harness; every normal exit path (pass, fail-and-continue, or all runs
# done) already re-arms and runs this cleanup correctly.

for i in $(seq 1 50); do
  [ -S "$SOCKET_PATH" ] && break
  sleep 0.2
  if ! kill -0 "$SERVE_PID" 2>/dev/null; then
    echo "error: nanogo serve exited before its socket ever appeared — log:" >&2
    cat "$SERVE_LOG" >&2
    exit 1
  fi
done
if [ ! -S "$SOCKET_PATH" ]; then
  echo "error: nanogo serve's socket never appeared within 10s — log:" >&2
  cat "$SERVE_LOG" >&2
  exit 1
fi
echo "nanogo serve is up (pid $SERVE_PID, socket $SOCKET_PATH)"
echo

PASS_COUNT=0
FIRST_OUTPUT=""
OVERALL_STATUS=0

for RUN in $(seq 1 "$REPEATS"); do
  echo "---- run $RUN/$REPEATS ----"

  SESSION_ID="sess-ec06-$(date +%s)-$$-$RUN"
  SESSION_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/$SESSION_ID"
  CONTEXT_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.context"
  CONTEXT_PATH="$CONTEXT_DIR/$SESSION_ID.json"
  CLAUDE_SHARED="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.claude-shared"
  RUN_TMP="$(mktemp -d -t ncl-ec06-run-XXXX)"
  GO_CONFIG="$RUN_TMP/config.json"
  CONTAINER_NAME=""
  LOG_FOLLOW_PID=""

  cleanup_run() {
    [ -n "$LOG_FOLLOW_PID" ] && kill "$LOG_FOLLOW_PID" > /dev/null 2>&1 || true
    if [ -n "$CONTAINER_NAME" ]; then
      docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
    fi
    rm -rf "$RUN_TMP"
  }
  trap cleanup_run EXIT

  mkdir -p "$SESSION_DIR" "$CONTEXT_DIR"

  cat > "$GO_CONFIG" <<EOF
{
  "data_dir": "$DATA_DIR",
  "groups_dir": "$GROUPS_DIR",
  "user_id": "u-ec06-proof",
  "agent_group_id": "$AGENT_GROUP_ID",
  "agent_folder": "$GROUP_FOLDER",
  "session_id": "$SESSION_ID"
}
EOF

  echo "-- preparing outbound.db (nanogo -prepare-outbound, P3-06) --"
  "$NANOGO" -config "$GO_CONFIG" -prepare-outbound

  echo "-- writing inbound message (nanogo -write-chat, P3-03) --"
  "$NANOGO" -config "$GO_CONFIG" -write-chat "$MESSAGE"

  echo "-- writing session context (mirrors session-manager.ts's writeSessionContext) --"
  printf '{"agentGroupId":"%s","sessionId":"%s","mailbox":null}' "$AGENT_GROUP_ID" "$SESSION_ID" > "$CONTEXT_PATH"
  chmod 600 "$CONTEXT_PATH"

  # Both written INSIDE the session's own workspace dir (already legally
  # mounted at /workspace under ClassGroupState — see mount.go's
  # mountAllowed) rather than as separate top-level bind mounts the way
  # P3-06's harness placed them under a /tmp scratch dir: a /tmp path has no
  # legal mount class under this kernel's real Policy (GroupsRoot/DataRoot/
  # SurfaceRoots only), so reusing the workspace mount that's already there
  # avoids inventing a mount this session wouldn't otherwise have.
  cp "$MOCK_PROVIDER_SRC" "$SESSION_DIR/mock-provider.ts"
  printf '{"provider":"nanogo-mock"}' > "$SESSION_DIR/container.json"

  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  TZ_VALUE="${TZ:-$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)}"

  echo "-- building container.wake request (kernel wire protocol v1, capability.request) --"
  WAKE_ENVELOPE="$RUN_TMP/wake.json"
  EC06_SESSION_DIR="$SESSION_DIR" \
  EC06_CONTEXT_PATH="$CONTEXT_PATH" \
  EC06_GROUP_DIR="$GROUP_DIR" \
  EC06_CLAUDE_SHARED="$CLAUDE_SHARED" \
  EC06_REPO_ROOT="$REPO_ROOT" \
  EC06_AGENT_GROUP_ID="$AGENT_GROUP_ID" \
  EC06_SESSION_ID="$SESSION_ID" \
  EC06_GROUP_FOLDER="$GROUP_FOLDER" \
  EC06_IMAGE_TAG="$IMAGE_TAG" \
  EC06_TZ="$TZ_VALUE" \
  EC06_UID="$HOST_UID" \
  EC06_GID="$HOST_GID" \
  python3 - > "$WAKE_ENVELOPE" <<'PYEOF'
import json, os

e = os.environ
session_dir = e["EC06_SESSION_DIR"]
group_dir = e["EC06_GROUP_DIR"]

def m(host, container, mode, cls, scoped=True):
    spec = {"class": cls, "hostPath": host, "containerPath": container, "mode": mode}
    if scoped:
        spec["groupScope"] = e["EC06_AGENT_GROUP_ID"]
    return spec

mounts = [
    m(session_dir, "/workspace", "rw", "group-state"),
    m(e["EC06_CONTEXT_PATH"], "/app/.nanoclaw-session.json", "ro", "group-state"),
    m(group_dir, "/workspace/agent", "rw", "group-state"),
    # Overrides the real group's container.json to select the deterministic
    # mock provider — mirrors scripts/p3-06-e2e.sh's own scratch-file
    # override, just placed under the session workspace instead of /tmp.
    m(session_dir + "/container.json", "/workspace/agent/container.json", "ro", "group-state"),
    m(group_dir + "/plugins", "/workspace/agent/plugins", "ro", "install-surface"),
    m(group_dir + "/CLAUDE.md", "/workspace/agent/CLAUDE.md", "ro", "group-state"),
    m(group_dir + "/.claude-fragments", "/workspace/agent/.claude-fragments", "ro", "group-state"),
    m(e["EC06_CLAUDE_SHARED"], "/home/node/.claude", "rw", "group-state"),
    m(e["EC06_REPO_ROOT"] + "/container/CLAUDE.md", "/app/CLAUDE.md", "ro", "install-surface", scoped=False),
    m(e["EC06_REPO_ROOT"] + "/container/agent-runner/src", "/app/src", "ro", "install-surface", scoped=False),
    m(e["EC06_REPO_ROOT"] + "/container/skills", "/app/skills", "ro", "install-surface", scoped=False),
]

session = {
    "key": {
        "installSlug": "ec06-livesmoke",
        "agentGroupId": e["EC06_AGENT_GROUP_ID"],
        "sessionId": e["EC06_SESSION_ID"],
    },
    "labels": {"nanoclaw-group-folder": e["EC06_GROUP_FOLDER"]},
    "runtimeTier": "container",
    "containers": [{
        "role": "agent",
        "env": {"TZ": e["EC06_TZ"], "HOME": "/home/node"},
        "image": e["EC06_IMAGE_TAG"],
        # Docker splits this across --entrypoint (argv[0]) and the
        # post-image argv (see internal/kernel/exec.go's Wake) — same
        # dynamic-import-before-index.ts trick p3-06-e2e.sh uses, just
        # loading mock-provider.ts from /workspace (this session's own
        # workspace mount) instead of /workspace/agent.
        "command": ["bash", "-c",
                    "exec bun -e \"import('/workspace/mock-provider.ts').then(() => import('/app/src/index.ts'))\""],
        "mounts": mounts,
    }],
}

envelope = {
    "version": "v1",
    "op": "capability.request",
    "requestId": "ec06-wake-" + e["EC06_SESSION_ID"],
    "payload": {
        "capability": "container.wake",
        "session": session,
        "runAs": {"uid": int(e["EC06_UID"]), "gid": int(e["EC06_GID"]), "set": True},
    },
}
print(json.dumps(envelope))
PYEOF

  echo "-- container.wake (dialing the real kernel socket via livesmoke) --"
  # Assignment wrapped as the if's own condition (not `X="$(cmd)"; S=$?;
  # if [ "$S" ...]` afterwards) deliberately: under `set -e`, a bare failing
  # command substitution assignment aborts the ENTIRE script immediately,
  # before a later `if` ever gets to see the exit code — a denied wake is
  # exactly the kind of expected, per-run failure this script needs to log
  # and continue past, not treat as fatal.
  if WAKE_RESPONSE="$("$LIVESMOKE" -socket "$SOCKET_PATH" < "$WAKE_ENVELOPE")"; then
    WAKE_STATUS=0
  else
    WAKE_STATUS=$?
  fi
  echo "$WAKE_RESPONSE"
  if [ "$WAKE_STATUS" -ne 0 ]; then
    echo "== run $RUN FAILED: container.wake was denied or failed (see response above) =="
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  CONTAINER_NAME="$(echo "$WAKE_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["containerName"])')"
  echo "kernel-derived container name: $CONTAINER_NAME"
  echo "(this is the property EC-02 exists to guarantee: the kernel derived and created this name itself — ContainerName(spec.Key) — this script never asserted or computed it in advance)"

  # Started immediately after wake returns (container is already
  # created+started by this point — dockerExecutor.Wake does both
  # synchronously) to capture as much output as possible despite Wake's
  # `docker create --rm`: a container that exits/crashes fast self-removes
  # before a LATER `docker logs` call could ever see anything, unlike
  # P3-04/P3-06's own harness-issued `docker create` (deliberately without
  # --rm, for exactly this reason) — the kernel's real Wake always uses
  # --rm, matching production, so this script cannot avoid that risk and
  # instead mitigates it by following logs live from the earliest possible
  # moment.
  docker logs -f "$CONTAINER_NAME" > "$RUN_TMP/container.log" 2>&1 &
  LOG_FOLLOW_PID=$!

  echo "-- polling for a reply via nanogo -read-outbound (up to 30s) --"
  FOUND=0
  READ_OUTPUT=""
  for i in $(seq 1 15); do
    sleep 2
    if READ_OUTPUT="$("$NANOGO" -config "$GO_CONFIG" -read-outbound 2>&1)" && echo "$READ_OUTPUT" | grep -q '^seq='; then
      FOUND=1
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
      echo "container is no longer running (self-removed via --rm, or exited) — check log below"
      break
    fi
  done

  if [ "$FOUND" -ne 1 ]; then
    echo
    echo "== run $RUN FAILED: no reply appeared within 30s =="
    echo "== container log (best-effort, may be incomplete — see comment above) =="
    kill "$LOG_FOLLOW_PID" > /dev/null 2>&1 || true
    wait "$LOG_FOLLOW_PID" 2>/dev/null || true
    cat "$RUN_TMP/container.log" 2>&1 || true
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  echo "$READ_OUTPUT"
  RESULT_LINE="$(echo "$READ_OUTPUT" | grep '^seq=')"

  if ! echo "$RESULT_LINE" | grep -qF "kind=chat content=$EXPECTED_CONTENT"; then
    echo
    echo "== run $RUN FAILED: reply did not match the expected deterministic content =="
    echo "expected: kind=chat content=$EXPECTED_CONTENT"
    echo "got     : $RESULT_LINE"
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  echo "-- container.kill (dialing the real kernel socket via livesmoke) --"
  KILL_ENVELOPE="$RUN_TMP/kill.json"
  # EC06_SESSION_ID must precede the command to become an environment
  # variable for it — placed AFTER `python3 -c '...'` (as this line
  # originally had it) it becomes a positional argument to the Python
  # script instead, and os.environ never sees it (caught for real: the
  # first live run of this script hit exactly this KeyError).
  EC06_SESSION_ID="$SESSION_ID" python3 -c '
import json, os
e = os.environ
print(json.dumps({
    "version": "v1", "op": "capability.request",
    "requestId": "ec06-kill-" + e["EC06_SESSION_ID"],
    "payload": {"capability": "container.kill", "sessionId": e["EC06_SESSION_ID"], "reason": "ec06-live-smoke cleanup"},
}))
' > "$KILL_ENVELOPE"
  # Same set -e trap as container.wake above — see that comment.
  if KILL_RESPONSE="$("$LIVESMOKE" -socket "$SOCKET_PATH" < "$KILL_ENVELOPE")"; then
    KILL_STATUS=0
  else
    KILL_STATUS=$?
  fi
  echo "$KILL_RESPONSE"
  if [ "$KILL_STATUS" -ne 0 ]; then
    echo "== run $RUN FAILED: container.kill was denied or failed =="
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  sleep 1
  if docker inspect "$CONTAINER_NAME" > /dev/null 2>&1; then
    echo "== run $RUN FAILED: container $CONTAINER_NAME still exists after container.kill (expected it gone — kill does stop+rm) =="
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi
  echo "confirmed: $CONTAINER_NAME no longer exists after container.kill"
  CONTAINER_NAME="" # already gone; cleanup_run's docker rm -f would be a harmless no-op either way

  NORMALIZED="$(echo "$RESULT_LINE" | sed -E 's/^seq=[0-9]+ id=[^ ]+ //')"
  if [ -z "$FIRST_OUTPUT" ]; then
    FIRST_OUTPUT="$NORMALIZED"
  elif [ "$NORMALIZED" != "$FIRST_OUTPUT" ]; then
    echo
    echo "== run $RUN FAILED: kind/content differs from run 1's reply =="
    echo "run 1  : $FIRST_OUTPUT"
    echo "run $RUN  : $NORMALIZED"
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  echo "== run $RUN passed (kernel-mediated wake -> real reply -> kernel-mediated kill) =="
  PASS_COUNT=$((PASS_COUNT + 1))
  trap - EXIT
  cleanup_run
  echo
done

# Re-arm the outer trap: each loop iteration above set (and, on its own
# success/failure path, explicitly cleared via `trap - EXIT`) a per-run
# cleanup_run trap that SHADOWS this one — `trap - EXIT` clears the slot
# entirely rather than restoring whatever trap was active before it, so
# without this line the final loop iteration would leave NO trap armed at
# all, and cleanup_all (which stops the still-running `nanogo serve`
# process and removes the global scratch dir/socket) would never fire on a
# normal, all-runs-passed exit.
trap cleanup_all EXIT

echo "== summary: $PASS_COUNT/$REPEATS run(s) passed, fully kernel-mediated, byte-identical kind/content =="
exit $OVERALL_STATUS
