import fs from 'fs';
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { sessionMailboxDir, sessionMailboxPath } from './paths.js';
export { inboundDbPath, outboundDbPath, sessionMailboxDir, sessionMailboxPath } from './paths.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  ensureSchema,
  getContainerState,
  getDeliveredIds,
  getDueOutboundMessages,
  getInboundSourceSessionId,
  getMessageForRetry,
  getMostRecentPeerSourceSessionId,
  getProcessingClaims,
  insertMessage,
  markDelivered,
  markDeliveryFailed,
  markMessageFailed,
  migrateDeliveredTable,
  migrateMessagesInTable,
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  replaceDestinations,
  retryWithBackoff,
  upsertSessionRouting,
} from './session-db.js';
import {
  createDirectOutboundRecord,
  outboundDelivery,
  parseContainerRecord,
  parseDestinationRecord,
  parseOutboundRecord,
  parseProcessingAckRecord,
  parseSessionRoutingRecord,
  parseTaskRecord,
} from '../model.js';
import {
  cancelAllTasks,
  cancelTask,
  clearRecurrence,
  deleteTask,
  getCompletedRecurring,
  insertTaskRow,
  pauseTask,
  resumeTask,
  trailingFailedRuns,
  updateTask,
} from './tasks.js';
import type {
  AgentMailbox,
  InboundMailbox,
  MailboxHistoryMessage,
  MailboxSession,
  MailboxSessionKey,
  MailboxTimelineMessage,
  OutboundMailbox,
  ProcessingAck,
  TaskRecord,
  TaskStats,
} from '../types.js';

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function applyProcessingAcks(db: Database.Database, acks: ProcessingAck[]): void {
  if (acks.length === 0) return;
  const complete = db.prepare(
    "UPDATE messages_in SET status = 'completed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
  );
  const fail = db.prepare(
    "UPDATE messages_in SET status = 'failed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
  );
  db.transaction(() => {
    for (const ack of acks) (ack.status === 'script-skip:error' ? fail : complete).run(ack.messageId);
  })();
}

type TaskSqlRow = {
  row_id: string;
  series_id: string | null;
  status: TaskRecord['status'];
  process_after: string | null;
  recurrence: string | null;
  content: string;
  timestamp: string;
  tries: number;
  seq: number;
};

function taskRecord(row: TaskSqlRow): TaskRecord {
  return parseTaskRecord({
    id: row.row_id,
    seriesId: row.series_id,
    status: row.status,
    processAfter: row.process_after === null ? null : sqliteTimestamp(row.process_after),
    recurrence: row.recurrence,
    content: row.content,
    timestamp: sqliteTimestamp(row.timestamp),
    tries: row.tries,
    sequence: row.seq,
  });
}

function listLiveTasks(db: Database.Database, status?: 'pending' | 'paused'): TaskRecord[] {
  const statusSql = status ? 'status = ?' : "status IN ('pending', 'paused')";
  const rows = db
    .prepare(
      `SELECT row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq
         FROM (
           SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq,
                  ROW_NUMBER() OVER (
                    PARTITION BY series_id
                    ORDER BY CASE
                               WHEN status = 'paused' OR datetime(process_after) > datetime('now') THEN 0
                               ELSE 1
                             END,
                             seq ASC
                  ) AS rank
             FROM messages_in
            WHERE kind = 'task' AND ${statusSql}
         )
        WHERE rank = 1
        ORDER BY datetime(process_after) ASC, seq ASC`,
    )
    .all(...(status ? [status] : [])) as TaskSqlRow[];
  return rows.map(taskRecord);
}

function getTask(db: Database.Database, id: string): TaskRecord | undefined {
  const row = db
    .prepare(
      `SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq
         FROM messages_in
        WHERE kind = 'task' AND (id = ? OR series_id = ?)
        ORDER BY CASE
                   WHEN status = 'paused' OR (status = 'pending' AND datetime(process_after) > datetime('now')) THEN 0
                   WHEN status = 'pending' THEN 1
                   ELSE 2
                 END,
                 CASE WHEN status IN ('pending', 'paused') THEN seq END ASC,
                 seq DESC
        LIMIT 1`,
    )
    .get(id, id) as TaskSqlRow | undefined;
  return row && taskRecord(row);
}

function getTaskStats(db: Database.Database, seriesId: string): TaskStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS runs,
         MAX(process_after) FILTER (WHERE status = 'completed') AS last_run,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_runs
       FROM messages_in
      WHERE kind = 'task' AND (id = ? OR series_id = ?)`,
    )
    .get(seriesId, seriesId) as { runs: number; last_run: string | null; failed_runs: number };
  return {
    runs: row.runs,
    lastRun: row.last_run === null ? null : sqliteTimestamp(row.last_run),
    failedRuns: row.failed_runs,
  };
}

export function wrapSqliteInbound(db: Database.Database, nextSequence = () => nextEvenAcross(db)): InboundMailbox {
  return {
    setRouting: (routing) => {
      const record = parseSessionRoutingRecord(routing);
      upsertSessionRouting(db, {
        channel_type: record.channelType,
        platform_id: record.platformId,
        thread_id: record.threadId,
      });
    },
    replaceDestinations: (entries) =>
      replaceDestinations(
        db,
        entries.map((entry) => {
          const record = parseDestinationRecord(entry);
          return {
            name: record.name,
            display_name: record.displayName,
            type: record.type,
            channel_type: record.channelType,
            platform_id: record.platformId,
            agent_group_id: record.agentGroupId,
          };
        }),
      ),
    insertMessage: async (message) => insertMessage(db, message, nextSequence()),
    countDueMessages: () => countDueMessages(db),
    markMessageFailed: (messageId) => markMessageFailed(db, messageId),
    retryWithBackoff: (messageId, backoffSec) => retryWithBackoff(db, messageId, backoffSec),
    getMessageForRetry: (messageId, status) => {
      const row = getMessageForRetry(db, messageId, status);
      return (
        row && {
          ...row,
          processAfter: row.processAfter === null ? null : sqliteTimestamp(row.processAfter),
        }
      );
    },
    applyProcessingAcks: (acks) => applyProcessingAcks(db, acks),
    getDeliveredIds: () => getDeliveredIds(db),
    markDelivered: (messageOutId, platformMessageId) => markDelivered(db, messageOutId, platformMessageId),
    markDeliveryFailed: (messageOutId) => markDeliveryFailed(db, messageOutId),
    getInboundSourceSessionId: (messageId) => getInboundSourceSessionId(db, messageId),
    getMostRecentPeerSourceSessionId: (peerAgentGroupId) => getMostRecentPeerSourceSessionId(db, peerAgentGroupId),
    insertTask: async (task) => insertTaskRow(db, task, nextSequence()),
    cancelTask: (taskId) => (taskId === undefined ? cancelAllTasks(db) : cancelTask(db, taskId)),
    pauseTask: (taskId) => pauseTask(db, taskId),
    resumeTask: (taskId) => resumeTask(db, taskId),
    deleteTask: (taskId) => deleteTask(db, taskId),
    updateTask: (taskId, update) => updateTask(db, taskId, update),
    listLiveTasks: (status) => listLiveTasks(db, status),
    getTask: (taskId) => getTask(db, taskId),
    getTaskStats: (seriesId) => getTaskStats(db, seriesId),
    getCompletedRecurring: () =>
      getCompletedRecurring(db).map((row) => ({
        id: row.id,
        content: row.content,
        recurrence: row.recurrence,
        seriesId: row.series_id,
      })),
    trailingFailedRuns: (seriesId) => trailingFailedRuns(db, seriesId),
    clearRecurrence: (messageId) => clearRecurrence(db, messageId),
    countLiveTasks: () =>
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { count: number }
      ).count,
    prunePendingMessages: (channelType, before, keep) => {
      const expired = db
        .prepare(
          `DELETE FROM messages_in
            WHERE channel_type = ? AND status = 'pending'
              AND datetime(timestamp) < datetime(?)`,
        )
        .run(channelType, before).changes;
      const overflow = db
        .prepare(
          `DELETE FROM messages_in
            WHERE channel_type = ? AND status = 'pending'
              AND seq NOT IN (
                SELECT seq FROM messages_in
                 WHERE channel_type = ? AND status = 'pending'
                 ORDER BY seq DESC LIMIT ?
              )`,
        )
        .run(channelType, channelType, keep).changes;
      return expired + overflow;
    },
    getInboundHistory: (limit) =>
      (
        db
          .prepare('SELECT timestamp, kind, content FROM messages_in ORDER BY seq DESC LIMIT ?')
          .all(limit) as MailboxHistoryMessage[]
      ).map((row) => ({ ...row, timestamp: sqliteTimestamp(row.timestamp) })),
    getConversationRoot: () => {
      const row = db
        .prepare(
          "SELECT timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') " +
            "AND trigger = 1 AND (channel_type IS NULL OR channel_type NOT IN ('session-echo', 'agent')) " +
            'ORDER BY seq ASC LIMIT 1',
        )
        .get() as MailboxTimelineMessage | undefined;
      return row && { ...row, timestamp: sqliteTimestamp(row.timestamp) };
    },
    findTaskBySeriesSlug: (slug) => {
      const pattern = `${slug}-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]`;
      const row = db
        .prepare(
          `SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq
             FROM messages_in
            WHERE kind = 'task' AND series_id GLOB ?
            ORDER BY CASE WHEN status IN ('pending', 'paused') THEN 0 ELSE 1 END, seq DESC
            LIMIT 1`,
        )
        .get(pattern) as TaskSqlRow | undefined;
      return row && taskRecord(row);
    },
  };
}

export function wrapSqliteOutbound(
  source: Database.Database | (() => Database.Database),
  writable: () => Database.Database = () => (typeof source === 'function' ? source() : source),
  options: {
    // Host-owned inbound.db handle, when the caller already has one open
    // (see the `session()` call site below) — reading it to cross-check
    // messages_in before allocating a direct-write seq costs nothing (same
    // process, same file, no cross-mount read) and closes a real collision
    // mode. Optional: callers with no inbound handle on hand (e.g. tests
    // exercising the outbound wrapper in isolation) fall back to the
    // outbound-only behavior this function always had.
    inbound?: Database.Database;
    nextSequence?: () => number;
  } = {},
): OutboundMailbox {
  const { inbound, nextSequence = () => nextEvenAcross(inbound, writable()) } = options;
  const readable = () => (typeof source === 'function' ? source() : source);
  return {
    getTerminalProcessingAcks: () =>
      (
        readable()
          .prepare(
            "SELECT message_id, status, status_changed FROM processing_ack WHERE status IN ('completed', 'failed', 'script-skip:error')",
          )
          .all() as Array<{ message_id: string; status: ProcessingAck['status']; status_changed: string }>
      ).map((row) =>
        parseProcessingAckRecord({
          messageId: row.message_id,
          status: row.status,
          statusChanged: sqliteTimestamp(row.status_changed),
        }),
      ),
    getProcessingClaims: () =>
      getProcessingClaims(readable()).map((row) => {
        const record = parseProcessingAckRecord({
          messageId: row.message_id,
          status: 'processing',
          statusChanged: sqliteTimestamp(row.status_changed),
        });
        return { messageId: record.messageId, statusChanged: record.statusChanged };
      }),
    deleteOrphanProcessingClaims: () => deleteOrphanProcessingClaims(writable()),
    getContainerState: () => {
      const row = getContainerState(readable());
      if (!row) return null;
      const record = parseContainerRecord({
        currentTool: row.current_tool,
        toolDeclaredTimeoutMs: row.tool_declared_timeout_ms,
        toolStartedAt: row.tool_started_at === null ? null : sqliteTimestamp(row.tool_started_at),
        updatedAt: sqliteTimestamp(row.updated_at),
      });
      return {
        currentTool: record.currentTool,
        toolDeclaredTimeoutMs: record.toolDeclaredTimeoutMs,
        toolStartedAt: record.toolStartedAt,
      };
    },
    getDueMessages: (excludeIds) =>
      getDueOutboundMessages(readable())
        .filter((row) => !excludeIds?.has(String(row.id)))
        .map((row) => {
          try {
            return outboundDelivery(
              parseOutboundRecord({
                id: row.id,
                sequence: row.seq,
                inReplyTo: row.in_reply_to,
                timestamp: sqliteTimestamp(row.timestamp),
                deliverAfter: row.deliver_after === null ? null : sqliteTimestamp(row.deliver_after),
                recurrence: row.recurrence,
                kind: row.kind,
                platformId: row.platform_id,
                channelType: row.channel_type,
                threadId: row.thread_id,
                content: row.content,
              }),
            );
          } catch (err) {
            // One malformed row must not block the whole delivery queue: fall
            // back to a best-effort read so the row goes through the normal
            // per-message retry → mark-failed containment instead of throwing
            // out of the entire drain on every poll.
            log.warn('Malformed outbound row — delivering best-effort', { id: String(row.id), err });
            const text = (value: unknown): string =>
              typeof value === 'string' ? value : value == null ? '' : String(value);
            const nullableText = (value: unknown): string | null => (value == null ? null : String(value));
            return {
              id: text(row.id),
              kind: text(row.kind),
              platformId: nullableText(row.platform_id),
              channelType: nullableText(row.channel_type),
              threadId: nullableText(row.thread_id),
              content: text(row.content),
              inReplyTo: nullableText(row.in_reply_to),
            };
          }
        }),
    writeDirect: async (message) => {
      const writer = writable();
      const sequence = nextSequence();
      const record = createDirectOutboundRecord(message, sequence, new Date().toISOString());
      writer
        .prepare(
          `INSERT OR IGNORE INTO messages_out
             (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
           VALUES
             (@id, @sequence, @inReplyTo, @timestamp, @deliverAfter, @recurrence, @kind, @platformId, @channelType, @threadId, @content)`,
        )
        .run(record);
    },
    getOutboundHistory: (limit) =>
      (
        readable()
          .prepare('SELECT timestamp, kind, content FROM messages_out ORDER BY seq DESC LIMIT ?')
          .all(limit) as MailboxHistoryMessage[]
      ).map((row) => ({ ...row, timestamp: sqliteTimestamp(row.timestamp) })),
    getTopLevelOutbound: (limit) =>
      (
        readable()
          .prepare(
            "SELECT timestamp, content FROM messages_out WHERE kind NOT IN ('system','task_log') " +
              "AND (channel_type IS NULL OR channel_type != 'agent') " +
              "AND (thread_id IS NULL OR thread_id = '' OR thread_id LIKE '%:') " +
              'ORDER BY seq DESC LIMIT ?',
          )
          .all(limit) as MailboxTimelineMessage[]
      ).map((row) => ({ ...row, timestamp: sqliteTimestamp(row.timestamp) })),
  };
}

export class SqliteAgentMailbox implements AgentMailbox {
  /** Inbound DB paths whose legacy-shape migrations already ran this process. */
  private readonly migrated = new Set<string>();

  async exists(key: MailboxSessionKey): Promise<boolean> {
    return fs.existsSync(sessionMailboxPath(key, 'inbound')) && fs.existsSync(sessionMailboxPath(key, 'outbound'));
  }

  prepare(key: MailboxSessionKey): void {
    fs.mkdirSync(sessionMailboxDir(key), { recursive: true });
    const inbound = sessionMailboxPath(key, 'inbound');
    const outbound = sessionMailboxPath(key, 'outbound');
    if (!fs.existsSync(inbound)) ensureSchema(inbound, 'inbound');
    if (!fs.existsSync(outbound)) ensureSchema(outbound, 'outbound');
  }

  async destroy(key: MailboxSessionKey): Promise<void> {
    const inbound = sessionMailboxPath(key, 'inbound');
    this.migrated.delete(inbound);
    for (const side of ['inbound', 'outbound'] as const) {
      const db = sessionMailboxPath(key, side);
      for (const suffix of ['', '-journal', '-shm', '-wal']) fs.rmSync(`${db}${suffix}`, { force: true });
    }
  }

  async runnerContext(_key: MailboxSessionKey): Promise<null> {
    return null;
  }

  async runnerEnvironment(_key: MailboxSessionKey): Promise<Record<string, string>> {
    return {};
  }

  async session<T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> {
    const inboundPath = sessionMailboxPath(key, 'inbound');
    if (!(await this.exists(key))) throw new Error(`Mailbox is not prepared: ${key.agentGroupId}/${key.sessionId}`);
    const inbound = openInboundDb(inboundPath);
    let outbound: Database.Database | undefined;
    let outboundWriter: Database.Database | undefined;
    const readableOutbound = () => (outbound ??= openOutboundDb(sessionMailboxPath(key, 'outbound')));
    const writableOutbound = () => (outboundWriter ??= openOutboundDbRw(sessionMailboxPath(key, 'outbound')));
    try {
      if (!this.migrated.has(inboundPath)) {
        migrateMessagesInTable(inbound);
        const deliveredColumns = inbound.prepare("PRAGMA table_info('delivered')").all();
        if (deliveredColumns.length > 0) migrateDeliveredTable(inbound);
        this.migrated.add(inboundPath);
      }
      // Both host-side even-seq allocators (messages_in inserts AND direct
      // outbound writes — writeDirect, host-generated system replies like a
      // command-gate deny) now share ONE persisted counter instead of each
      // independently computing "next even" from its own table's MAX(seq)
      // (code review finding: two independent per-table allocators could
      // claim the same even value — one KNOWN GAP direction was closed by an
      // earlier partial fix; this closes both directions for real). The
      // counter lives in inbound.db (host-owned — already this same open
      // `inbound` handle, so reading/writing it costs nothing and never
      // touches the container-owned outbound.db on the hot insertMessage
      // path). See makeHostSeqAllocator below for the one-time seed + atomic
      // claim.
      const nextHostSeq = makeHostSeqAllocator(inbound, readableOutbound);
      return await action({
        ...wrapSqliteInbound(inbound, nextHostSeq),
        ...wrapSqliteOutbound(readableOutbound, writableOutbound, { inbound, nextSequence: nextHostSeq }),
      });
    } finally {
      // `mailbox` (and the `nextHostSeq`/wrapSqliteInbound/wrapSqliteOutbound
      // closures inside it) must not be retained and called after `action`
      // resolves — every mailbox method above closes over `inbound`, and it
      // is closed right here. No current caller does this (every call site
      // awaits `action` fully before this method returns), but a future
      // fire-and-forget caller that stashes the mailbox and calls a method
      // on it later would hit a closed handle. (Code review finding.)
      inbound.close();
      outbound?.close();
      outboundWriter?.close();
    }
  }
}

function nextEvenAcross(inbound?: Database.Database, outbound?: Database.Database): number {
  const maximum = (db: Database.Database, table: 'messages_in' | 'messages_out') =>
    (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS value FROM ${table}`).get() as { value: number }).value;
  const max = Math.max(inbound ? maximum(inbound, 'messages_in') : 0, outbound ? maximum(outbound, 'messages_out') : 0);
  return max < 2 ? 2 : max + 2 - (max % 2);
}

/**
 * Shared, host-owned "next even seq" counter for a session — the single
 * source of truth both wrapSqliteInbound's default insertMessage/insertTask
 * path and wrapSqliteOutbound's writeDirect path claim from, so the two can
 * never independently allocate the same value (code review finding).
 *
 * Persisted as a single row in inbound.db (host-owned; `host_seq_state` in
 * schema.ts). `CREATE TABLE IF NOT EXISTS` runs here unconditionally — cheap
 * and idempotent — because `ensureSchema` only fires for brand-new session
 * files (SqliteAgentMailbox.prepare gates it on `!fs.existsSync`), so an
 * already-existing session's inbound.db would otherwise never pick up a
 * schema addition like this one.
 *
 * Seeded exactly ONCE per session, the first time this allocator is called
 * after the table is created, from both tables' historical MAX(seq) — this
 * is the only time it reads outbound.db, and it's a one-time cold-start cost
 * per session, not a recurring hot-path read. Every call after that reads
 * and writes inbound.db only.
 *
 * The claim itself (read-or-seed, then increment) is built from plain
 * synchronous better-sqlite3 calls with no `await` between them, and the
 * host runs as a single Node process (CLAUDE.md) — so two "concurrent"
 * callers can never interleave mid-claim; whichever call starts first always
 * completes its claim before JS yields control back to the event loop. This
 * also removes the prior MAX(seq)-based writeDirect race (code review
 * finding): the claim is a single atomic step, not a separate read-then-
 * later-insert.
 */
export function makeHostSeqAllocator(inbound: Database.Database, outbound: () => Database.Database): () => number {
  inbound.exec(
    'CREATE TABLE IF NOT EXISTS host_seq_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_even_seq INTEGER NOT NULL)',
  );
  return () => {
    const existing = inbound.prepare('SELECT next_even_seq FROM host_seq_state WHERE id = 1').get() as
      | { next_even_seq: number }
      | undefined;
    if (existing) {
      inbound.prepare('UPDATE host_seq_state SET next_even_seq = next_even_seq + 2 WHERE id = 1').run();
      return existing.next_even_seq;
    }
    const seed = nextEvenAcross(inbound, outbound());
    inbound.prepare('INSERT INTO host_seq_state (id, next_even_seq) VALUES (1, ?)').run(seed + 2);
    return seed;
  };
}
