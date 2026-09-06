#!/usr/bin/env bash
# P3-06: complete deterministic end-to-end round trip.
#
# CLI (nanogo -write-chat) -> Go inbound.db -> the REAL, unmodified NanoClaw
# agent-runner container -> a fake, deterministic provider (NOT the real
# Claude Agent SDK — see scripts/p3-06-mock-provider.ts for why and how) ->
# outbound.db -> CLI (nanogo -read-outbound). This is the first serious
# go/no-go test of the architecture: unlike P3-04 (which only proved the
# wire contract with a real, nondeterministic Claude reply) this proves the
# SAME round trip is exactly reproducible, end to end, driven entirely by
# the Go host's own two existing flags — no raw sqlite3 CLI reads on the
# verification side the way P3-04's harness needed.
#
# Per the task's own scope ("Wire the existing pieces into one deterministic
# end-to-end proof. Do not add routing/channels. Keep code minimal and
# surface failures clearly."): this script adds no new Go-kernel logic
# beyond -prepare-outbound (a thin CLI surface for P3-05's already-existing
# mailbox.OpenForSetup) and reuses P3-04's proven mount/argv recipe nearly
# unchanged. The only real additions are (1) a scratch container.json that
# selects the fake provider instead of the real one, and (2) one extra
# bind-mounted file (scripts/p3-06-mock-provider.ts) that registers that
# fake provider — the agent-runner image itself is never touched.
#
# Usage: IMAGE_TAG=<local agent image tag> scripts/p3-06-e2e.sh [repeats]
#   repeats defaults to 2 — the task's own done-when is "a repeated
#   integration test passes", so this runs the full round trip that many
#   times, each in a fresh session, and fails loudly on the first run whose
#   observed reply does not byte-for-byte match every other run's.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
GROUPS_DIR="$REPO_ROOT/groups"

AGENT_GROUP_ID="${AGENT_GROUP_ID:-ag-1788008257480-b2n3zv}"
GROUP_FOLDER="${GROUP_FOLDER:-ping_test}"
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG to the local agent image tag (see \`docker images\` — the one nanoclaw.sh built)}"
MESSAGE="${MESSAGE:-p3-06 deterministic end-to-end proof}"
REPEATS="${1:-2}"

GROUP_DIR="$GROUPS_DIR/$GROUP_FOLDER"
MOCK_PROVIDER_SRC="$REPO_ROOT/scripts/p3-06-mock-provider.ts"

# Content deliverErrorResult (poll-loop.ts) writes: JSON.stringify({ text })
# with no space after the colon — NOT Python's json.dumps default spacing,
# which this proof's own sandbox verification hit and is worth recording
# here so a future reader doesn't "fix" this pattern to match a JSON
# formatter's habitual spacing instead of the real JS output.
EXPECTED_CONTENT='{"text":"p3-06: deterministic reply from the fake provider"}'

echo "== P3-06: deterministic end-to-end round trip ($REPEATS run(s)) =="
echo "agent group : $AGENT_GROUP_ID ($GROUP_FOLDER)"
echo "image       : $IMAGE_TAG"
echo "expecting   : kind=chat content=$EXPECTED_CONTENT"
echo

if [ ! -d "$GROUP_DIR" ]; then
  echo "error: group folder not found: $GROUP_DIR" >&2
  echo "(this script reuses the ping_test group's CLAUDE.md/plugins/.claude-fragments/.claude-shared" >&2
  echo " purely as harmless generic scaffolding — the fake provider never touches Claude auth —" >&2
  echo " override GROUP_FOLDER/AGENT_GROUP_ID if you're pointing at a different group)" >&2
  exit 1
fi
if [ ! -f "$MOCK_PROVIDER_SRC" ]; then
  echo "error: mock provider script not found: $MOCK_PROVIDER_SRC" >&2
  exit 1
fi

NANOGO="$REPO_ROOT/go-host/nanogo"
# Always rebuild, never reuse whatever binary happens to be lying around.
# P3-04's original harness only built nanogo if the file was missing —
# harmless as long as nanogo never changed underneath it, but P3-05 and
# this very task both added flags after that binary was first built, and a
# stale nanogo silently answering "flag provided but not defined:
# -prepare-outbound" is a confusing way to discover that. A `go build` here
# costs a couple of seconds; go-host/nanogo itself is a build artifact, not
# a tracked deliverable (worth a .gitignore entry — see the task closeout).
echo "building nanogo (always rebuilt — see comment above)..."
( cd "$REPO_ROOT/go-host" && go build -o nanogo ./cmd/nanogo )

PASS_COUNT=0
FIRST_OUTPUT=""
OVERALL_STATUS=0

for RUN in $(seq 1 "$REPEATS"); do
  echo "---- run $RUN/$REPEATS ----"

  SESSION_ID="sess-p306-$(date +%s)-$$-$RUN"
  SESSION_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/$SESSION_ID"
  CONTEXT_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.context"
  CONTEXT_PATH="$CONTEXT_DIR/$SESSION_ID.json"
  CLAUDE_SHARED="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.claude-shared"
  CONTAINER_NAME="nanoclaw-p306-$SESSION_ID"
  RUN_TMP="$(mktemp -d -t nanogo-p306-XXXX)"
  GO_CONFIG="$RUN_TMP/config.json"
  MOCK_CONTAINER_JSON="$RUN_TMP/container.json"

  cleanup_run() {
    docker stop -t 5 "$CONTAINER_NAME" > /dev/null 2>&1 || true
    docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
    rm -rf "$RUN_TMP"
  }
  trap cleanup_run EXIT

  cat > "$GO_CONFIG" <<EOF
{
  "data_dir": "$DATA_DIR",
  "groups_dir": "$GROUPS_DIR",
  "user_id": "u-p3-06-proof",
  "agent_group_id": "$AGENT_GROUP_ID",
  "agent_folder": "$GROUP_FOLDER",
  "session_id": "$SESSION_ID"
}
EOF

  # Selects the fake provider registered by p3-06-mock-provider.ts — every
  # other RunnerConfig field falls back to config.ts's own defaults.
  printf '{"provider":"nanogo-mock"}' > "$MOCK_CONTAINER_JSON"

  echo "-- preparing outbound.db (nanogo -prepare-outbound, P3-06) --"
  "$NANOGO" -config "$GO_CONFIG" -prepare-outbound

  echo "-- writing inbound message (nanogo -write-chat, P3-03) --"
  "$NANOGO" -config "$GO_CONFIG" -write-chat "$MESSAGE"

  echo "-- writing session context (mirrors session-manager.ts's writeSessionContext) --"
  mkdir -p "$CONTEXT_DIR"
  printf '{"agentGroupId":"%s","sessionId":"%s","mailbox":null}' "$AGENT_GROUP_ID" "$SESSION_ID" > "$CONTEXT_PATH"
  chmod 600 "$CONTEXT_PATH"

  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  TZ_VALUE="${TZ:-$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)}"

  echo "-- docker create (P3-04's mount recipe, plus the fake-provider overrides) --"
  docker create --name "$CONTAINER_NAME" \
    --label nanoclaw-install=p3-06-proof \
    --label nanoclaw-group="$AGENT_GROUP_ID" \
    --label nanoclaw-session="$SESSION_ID" \
    --label nanoclaw-role=agent \
    --cap-drop=ALL --security-opt no-new-privileges --init \
    --user "$HOST_UID:$HOST_GID" \
    -e TZ="$TZ_VALUE" \
    -e HOME=/home/node \
    -v "$SESSION_DIR:/workspace" \
    -v "$CONTEXT_PATH:/app/.nanoclaw-session.json:ro" \
    -v "$GROUP_DIR:/workspace/agent" \
    -v "$MOCK_CONTAINER_JSON:/workspace/agent/container.json:ro" \
    -v "$GROUP_DIR/plugins:/workspace/agent/plugins:ro" \
    -v "$GROUP_DIR/CLAUDE.md:/workspace/agent/CLAUDE.md:ro" \
    -v "$GROUP_DIR/.claude-fragments:/workspace/agent/.claude-fragments:ro" \
    -v "$MOCK_PROVIDER_SRC:/workspace/agent/mock-provider.ts:ro" \
    -v "$REPO_ROOT/container/CLAUDE.md:/app/CLAUDE.md:ro" \
    -v "$CLAUDE_SHARED:/home/node/.claude" \
    -v "$REPO_ROOT/container/agent-runner/src:/app/src:ro" \
    -v "$REPO_ROOT/container/skills:/app/skills:ro" \
    --entrypoint bash \
    "$IMAGE_TAG" -c "exec bun -e \"import('/workspace/agent/mock-provider.ts').then(() => import('/app/src/index.ts'))\"" > /dev/null

  echo "-- docker start --"
  docker start "$CONTAINER_NAME" > /dev/null

  echo "-- polling for a reply via nanogo -read-outbound (up to 30s — no real LLM call this time) --"
  FOUND=0
  READ_OUTPUT=""
  for i in $(seq 1 15); do
    sleep 2
    if READ_OUTPUT="$("$NANOGO" -config "$GO_CONFIG" -read-outbound 2>&1)" && echo "$READ_OUTPUT" | grep -q '^seq='; then
      FOUND=1
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
      EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo '?')"
      echo "container exited early (exit code: $EXIT_CODE) — check logs below"
      break
    fi
  done

  if [ "$FOUND" -ne 1 ]; then
    echo
    echo "== run $RUN FAILED: no reply appeared within 30s =="
    echo "== container logs (last 80 lines) =="
    docker logs --tail 80 "$CONTAINER_NAME" 2>&1 || true
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  echo "$READ_OUTPUT"

  # Isolate just the result line (nanogo also prints a "config valid: ..."
  # line first, which embeds this run's own unique session id — comparing
  # the whole multi-line output across runs would always "differ" for that
  # reason alone, even when the actual reply is byte-identical).
  RESULT_LINE="$(echo "$READ_OUTPUT" | grep '^seq=')"

  if ! echo "$RESULT_LINE" | grep -qF "kind=chat content=$EXPECTED_CONTENT"; then
    echo
    echo "== run $RUN FAILED: reply did not match the expected deterministic content =="
    echo "expected: kind=chat content=$EXPECTED_CONTENT"
    echo "got     : $RESULT_LINE"
    echo "== container logs (last 80 lines) =="
    docker logs --tail 80 "$CONTAINER_NAME" 2>&1 || true
    OVERALL_STATUS=1
    trap - EXIT
    cleanup_run
    continue
  fi

  # seq/id are expected to vary run to run (fresh session each time, random
  # id per poll-loop.ts's generateId()) — only kind/content must be
  # byte-identical across every run for this to count as "deterministic".
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

  echo "== run $RUN passed =="
  PASS_COUNT=$((PASS_COUNT + 1))
  trap - EXIT
  cleanup_run
  echo
done

echo "== summary: $PASS_COUNT/$REPEATS run(s) passed with byte-identical kind/content =="
exit $OVERALL_STATUS
