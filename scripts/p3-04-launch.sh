#!/usr/bin/env bash
# P3-04 proof harness: launches the REAL, unmodified NanoClaw agent-runner
# container against a session the Go host (P3-01–P3-03) creates and writes,
# instead of one the TypeScript host would have created.
#
# This is deliberately NOT a Go reimplementation of container-runner.ts's
# wakeContainer/composeSessionSpec — that is real Go-kernel work for a much
# later, more careful phase (see docs/design-laws.md's LAW-07/OBJ-04
# annotation). This script is a one-off proof harness: it hand-mirrors
# docker-driver.ts's mount list and `docker create` argv for ONE fixed
# session, reusing an already-initialized, already-authenticated real agent
# group (ping_test / ag-1788008257480-b2n3zv, from the P0-08 test run) so the
# only thing that's different from a normal NanoClaw session is WHO wrote
# inbound.db and the session context file.
#
# What this proves: the real agent-runner container, completely unmodified,
# can read a Go-written inbound.db and Go-written session context file, run
# a real Claude Agent SDK turn, and write a real reply into outbound.db —
# i.e. the wire contract P3-03 implemented is not just internally consistent,
# it interoperates with the genuine consumer.
#
# Usage: scripts/p3-04-launch.sh "your chat message here"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
GROUPS_DIR="$REPO_ROOT/groups"

AGENT_GROUP_ID="${AGENT_GROUP_ID:-ag-1788008257480-b2n3zv}"
GROUP_FOLDER="${GROUP_FOLDER:-ping_test}"
IMAGE_TAG="${IMAGE_TAG:?Set IMAGE_TAG to the local agent image tag (see \`docker images\` — the one nanoclaw.sh built)}"
MESSAGE="${1:-hello from the Go host, P3-04}"

SESSION_ID="sess-p304-$(date +%s)-$$"
SESSION_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/$SESSION_ID"
CONTEXT_DIR="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.context"
CONTEXT_PATH="$CONTEXT_DIR/$SESSION_ID.json"
CLAUDE_SHARED="$DATA_DIR/v2-sessions/$AGENT_GROUP_ID/.claude-shared"
GROUP_DIR="$GROUPS_DIR/$GROUP_FOLDER"
CONTAINER_NAME="nanoclaw-p304-$SESSION_ID"

echo "== P3-04: launching real agent-runner against Go-written session =="
echo "agent group : $AGENT_GROUP_ID ($GROUP_FOLDER)"
echo "session id  : $SESSION_ID"
echo "session dir : $SESSION_DIR"
echo "image       : $IMAGE_TAG"
echo

if [ ! -d "$GROUP_DIR" ]; then
  echo "error: group folder not found: $GROUP_DIR" >&2
  echo "(this script assumes the ping_test group from the P0-08 nanoclaw.sh run still exists —" >&2
  echo " override GROUP_FOLDER/AGENT_GROUP_ID if you're pointing at a different group)" >&2
  exit 1
fi
if [ ! -d "$CLAUDE_SHARED" ]; then
  echo "error: .claude-shared not found for this agent group: $CLAUDE_SHARED" >&2
  echo "(no authenticated Claude Code state to reuse — the container would have to log in fresh)" >&2
  exit 1
fi

NANOGO="$REPO_ROOT/go-host/nanogo"
if [ ! -x "$NANOGO" ]; then
  echo "building nanogo..."
  ( cd "$REPO_ROOT/go-host" && go build -o nanogo ./cmd/nanogo )
fi

# --- Step 1: Go host writes the session (P3-03's mailbox package) ---------
GO_CONFIG="$(mktemp -t nanogo-config-XXXX.json)"
trap 'rm -f "$GO_CONFIG"' EXIT
cat > "$GO_CONFIG" <<EOF
{
  "data_dir": "$DATA_DIR",
  "groups_dir": "$GROUPS_DIR",
  "user_id": "u-p3-04-proof",
  "agent_group_id": "$AGENT_GROUP_ID",
  "agent_folder": "$GROUP_FOLDER",
  "session_id": "$SESSION_ID"
}
EOF

echo "-- writing inbound message via nanogo (P3-03) --"
"$NANOGO" -config "$GO_CONFIG" -write-chat "$MESSAGE"

# --- Step 2: Go host writes the session context file ----------------------
# Mirrors session-manager.ts's writeSessionContext(): the SqliteAgentMailbox
# (the only mailbox implementation NanoClaw ships) always contributes
# runnerContext() = null, so this is the complete, real shape — not a
# simplification. 0600 like the TypeScript host writes it.
echo "-- writing session context (mirrors session-manager.ts's writeSessionContext) --"
mkdir -p "$CONTEXT_DIR"
printf '{"agentGroupId":"%s","sessionId":"%s","mailbox":null}' "$AGENT_GROUP_ID" "$SESSION_ID" > "$CONTEXT_PATH"
chmod 600 "$CONTEXT_PATH"

# --- Step 2.5: pre-create outbound.db with the host-owned schema ----------
# On the real host, session-db.ts's ensureSchema('outbound') does this at
# SESSION-CREATION time, before the container ever starts — the container's
# own connection.ts (getOutboundDb) only patches in session_state/
# container_state for forward-compat with pre-those-tables files; it assumes
# messages_out/processing_ack already exist. P3-03 deliberately only writes
# inbound.db (that was its scope), so this proof harness has to do the
# outbound side itself, exactly as schema.ts's OUTBOUND_SCHEMA defines it.
echo "-- pre-creating outbound.db (mirrors session-db.ts's ensureSchema('outbound')) --"
OUTBOUND_DB="$SESSION_DIR/outbound.db"
sqlite3 "$OUTBOUND_DB" <<'SQL'
PRAGMA journal_mode = DELETE;
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
SQL

# --- Step 3: docker create, mirroring docker-driver.ts's mount/argv build --
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
TZ_VALUE="${TZ:-$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)}"

# Deliberately NOT --rm: the real driver uses --rm (see docker-driver.ts),
# but this harness needs the container to still exist after a crash so we
# can pull its logs and exit code — a --rm container that dies fast is
# gone before `docker logs` can even run. Cleaned up explicitly at the end.
echo "-- docker create (mirrors composeSessionSpec + docker-driver.ts mountArgs/hardeningArgs) --"
docker create --name "$CONTAINER_NAME" \
  --label nanoclaw-install=p3-04-proof \
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
  -v "$GROUP_DIR/container.json:/workspace/agent/container.json:ro" \
  -v "$GROUP_DIR/plugins:/workspace/agent/plugins:ro" \
  -v "$GROUP_DIR/CLAUDE.md:/workspace/agent/CLAUDE.md:ro" \
  -v "$GROUP_DIR/.claude-fragments:/workspace/agent/.claude-fragments:ro" \
  -v "$REPO_ROOT/container/CLAUDE.md:/app/CLAUDE.md:ro" \
  -v "$CLAUDE_SHARED:/home/node/.claude" \
  -v "$REPO_ROOT/container/agent-runner/src:/app/src:ro" \
  -v "$REPO_ROOT/container/skills:/app/skills:ro" \
  --entrypoint bash \
  "$IMAGE_TAG" -c "exec bun run /app/src/index.ts" > /dev/null

echo "-- docker start (detached — the agent-runner poll loop does not self-exit) --"
docker start "$CONTAINER_NAME" > /dev/null

# --- Step 4: poll outbound.db for a real reply -----------------------------
echo "-- waiting up to 90s for a reply in outbound.db --"
FOUND=0
for i in $(seq 1 45); do
  sleep 2
  if [ -f "$OUTBOUND_DB" ] && [ "$(sqlite3 "$OUTBOUND_DB" 'SELECT COUNT(*) FROM messages_out;' 2>/dev/null || echo 0)" -gt 0 ]; then
    FOUND=1
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
    EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo '?')"
    echo "container exited early (exit code: $EXIT_CODE) — check logs below"
    break
  fi
done

echo
echo "== container logs (last 60 lines) =="
docker logs --tail 60 "$CONTAINER_NAME" 2>&1 || true

echo
if [ "$FOUND" -eq 1 ]; then
  echo "== reply found in outbound.db =="
  sqlite3 -header -column "$OUTBOUND_DB" "SELECT id, seq, kind, content FROM messages_out ORDER BY seq;"
else
  echo "== no reply appeared within 90s — inspect $OUTBOUND_DB and the logs above =="
fi

echo
echo "-- cleaning up container (session dir left in place for inspection: $SESSION_DIR) --"
docker stop -t 5 "$CONTAINER_NAME" > /dev/null 2>&1 || true
docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true

exit $([ "$FOUND" -eq 1 ] && echo 0 || echo 1)
