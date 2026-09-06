// Package restart documents and encodes P4-05's scope: NanoClaw's host
// restart durability contract — what state survives a host process restart,
// what resets, and the resulting duplicate/loss risk for a message caught in
// each state a restart can find it in.
//
// Every actual restart-tolerant DECISION already has a home in an earlier
// Phase 4 package, because P4-01 through P4-04 all took DB-durable fields as
// caller-supplied plain values rather than owning any mutable process state
// of their own — which already makes them restart-safe by construction, not
// by any new mechanism this package adds. What was still missing, and what
// this package actually contributes, is: (1) the two PIECES OF STATE that
// were never restart-safe by construction — delivery.ts's in-memory
// deliveryAttempts Map and the inflightDeliveries Set — get their
// reset-on-restart behavior stated explicitly and pinned by a test, instead
// of being true only as an implicit property of "it's a plain Go map that a
// new process starts empty"; and (2) FilterUndelivered, the one piece of
// actual DEDUP logic in delivery.ts that was read but not yet ported at
// P4-04 (that task scoped itself to classification, target resolution, and
// the adapter boundary — the pre-adapter dedup filter itself was left for
// whichever task actually needed to reason about restart, which is this
// one).
//
// # What survives a restart (persisted in SQLite, re-read fresh by the new process)
//
//   - messages_in rows — status, tries, process_after (session-db.ts's
//     insertMessage/retryWithBackoff/markMessageFailed all write these
//     durably). A message's retry count is NEVER lost to a restart, which is
//     exactly why internal/lifecycle.DecideRetry (P4-03) needs no restart-
//     specific logic of its own: it is already a pure function of DB-durable
//     inputs, so calling it after a restart with the same on-disk tries/
//     processAfter values yields the identical decision it would have
//     yielded had the process never restarted at all. See
//     DecideRetryIsRestartTransparent below for the test that pins this.
//
//   - the delivered table (session-db.ts, in inbound.db) — every message
//     this host has actually handed to a channel Adapter, success or
//     permanent failure, is recorded here durably
//     (markDelivered/markDeliveryFailed). FilterUndelivered below is
//     delivery.ts:190-193's own dedup filter (`getDueMessages(delivered)
//     .filter(id => !delivered.has(id))`), ported verbatim — it is the
//     entire mechanism that prevents a message already delivered
//     pre-restart from being delivered again post-restart, because the
//     freshly re-read `delivered` set already contains it.
//
//   - processing_ack rows in outbound.db — also durable, which is why
//     resetStuckProcessingRows (internal/lifecycle.DecideRetry) can run at
//     any point after a restart and correctly reschedule or fail messages a
//     crashed container left claimed: it reads the same persisted claim a
//     pre-restart sweep tick would have seen.
//
//   - a running container itself — driver-level (Docker), outlives the host
//     process entirely. internal/lifecycle.DecideAdoption (P4-03) is exactly
//     the restart-time decision that re-registers it instead of the host
//     losing track of it, given container-runner.ts's own adoptRunningSessions
//     doc comment: "A surviving session used to be destroyed on every host
//     restart... now the host re-registers it and delivery resumes."
//
// # What resets to zero on a restart (in-memory only, by design — not a gap)
//
//   - delivery.ts's deliveryAttempts Map — quoting its doc comment verbatim:
//     "Track delivery attempt counts. Resets on process restart (gives
//     failed messages a fresh chance)." AttemptTracker below is a direct Go
//     port of that same map. A fresh AttemptTracker per process start is the
//     CORRECT, intended behavior, not something this port should "fix" by
//     adding persistence — doing so would change accepted TypeScript
//     behavior, which this project only ever does with an explicit,
//     documented decision (see docs/parity-schema.md's normalization
//     philosophy). See AttemptTrackerResetsAcrossRestart below for the test
//     that pins this as accepted, not accidental.
//
//   - internal/delivery.InflightGuard and internal/lifecycle.Registry — both
//     are in-memory re-entry/bookkeeping guards over work happening in THIS
//     process. A restart ends every in-flight goroutine along with them, so
//     there is nothing to preserve: the next process starts both empty and
//     rediscovers real state (due messages, running containers) from the DB
//     on its own first poll/sweep tick, exactly as a fresh TS process does.
//
// # Net duplicate/loss risk, stated plainly (this task's literal "done when")
//
//   - Outbound delivery is NEVER duplicated to the end user across a
//     restart, because delivered-table dedup is durable (FilterUndelivered).
//     A message that failed 2 of its 3 attempts before a restart gets a
//     fresh 3 attempts after — strictly more generous than before, never
//     fewer — so a restart can only DELAY a give-up decision, never skip or
//     duplicate a delivery. This is the accepted baseline behavior; it is
//     not changed or improved on here.
//
//   - Inbound processing is at-least-once, not exactly-once, across a
//     restart or a container crash — unchanged from the existing TypeScript
//     host and NOT something this package (or P4-03's DecideRetry) can
//     change: a message the container had CLAIMED (processing) but not yet
//     ACKed when either side crashes is safely retried, bounded by the
//     DB-durable tries column, but whether the agent had already produced a
//     visible side effect for that claim before crashing is a container-side
//     (TypeScript/Bun) concern this package does not observe. Once tries
//     reaches MaxTries the row is durably marked 'failed' and DecideRetry
//     (and the sweep that calls it) never revisits it again, restart or not
//     — see NoReprocessingAfterPermanentFailure below.
package restart

import (
	"github.com/prathish-ks/isthmus/go-host/internal/delivery"
)

// AttemptTracker is a direct, deliberately non-durable port of delivery.ts's
// module-level deliveryAttempts Map (delivery.ts:36-37,251-252,262). A fresh
// AttemptTracker is constructed once per host process (NewAttemptTracker);
// nothing about its state is ever written to disk, so a process restart
// always starts every message's attempt count at zero — see the package doc
// comment's "What resets to zero" section for why that is intended, not a
// gap.
type AttemptTracker struct {
	attempts map[string]int
}

// NewAttemptTracker returns an empty tracker — what every host process
// (first start or restart) begins with.
func NewAttemptTracker() *AttemptTracker {
	return &AttemptTracker{attempts: make(map[string]int)}
}

// RecordFailure mirrors drainSession's per-failure bookkeeping
// (delivery.ts:250-262): bump the message's attempt count via
// internal/delivery.NextAttempt (P4-04) and, on give-up, forget it entirely
// — mirroring `deliveryAttempts.delete(msg.id)` right after
// markDeliveryFailed (delivery.ts:262), so a message id that is later reused
// (unlikely, but the TS map has no other cleanup path) does not inherit a
// stale exhausted count.
func (t *AttemptTracker) RecordFailure(messageID string) (attempts int, giveUp bool) {
	attempts, giveUp = delivery.NextAttempt(t.attempts[messageID])
	if giveUp {
		delete(t.attempts, messageID)
	} else {
		t.attempts[messageID] = attempts
	}
	return attempts, giveUp
}

// Forget mirrors `deliveryAttempts.delete(msg.id)` on a successful delivery
// (delivery.ts:226) — the message no longer needs a remembered attempt
// count.
func (t *AttemptTracker) Forget(messageID string) {
	delete(t.attempts, messageID)
}

// Count returns the current recorded attempt count for messageID (0 if
// never failed, or already forgotten/given-up). Exposed for tests and for a
// caller that wants to log the current count without mutating it.
func (t *AttemptTracker) Count(messageID string) int {
	return t.attempts[messageID]
}

// FilterUndelivered is delivery.ts:190-193's own dedup filter, ported
// verbatim:
//
//	const delivered = mailbox.getDeliveredIds();
//	pending: mailbox.getDueMessages(delivered).filter(id => !delivered.has(id))
//
// dueIDs is the full due-outbound queue for one session (already read fresh
// from messages_out); delivered is the caller-supplied result of
// getDeliveredIds() against the durable `delivered` table (session-db.ts).
// This one filter is the entire mechanism that makes outbound delivery
// restart-safe: `delivered` survives a restart (it is a SQLite table, not an
// in-memory set), so re-running this filter against a freshly re-read
// due-queue after a restart naturally excludes everything the pre-restart
// process already delivered — no separate restart-detection logic is needed
// anywhere in this package or in internal/delivery.
func FilterUndelivered(dueIDs []string, delivered map[string]bool) []string {
	pending := make([]string, 0, len(dueIDs))
	for _, id := range dueIDs {
		if !delivered[id] {
			pending = append(pending, id)
		}
	}
	return pending
}
