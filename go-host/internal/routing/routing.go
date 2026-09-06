// Package routing ports the MECHANISM half of src/router.ts's routeInbound
// pipeline — the policy-free decision and combination logic that has no
// customization hook attached to it. It deliberately does NOT own:
//
//   - the six customization hook seams routeInbound calls out to (sender
//     resolver, access gate, sender-scope gate, message interceptors,
//     channel-request gate, session-created hooks) — these are the
//     permissions/approvals modules' extension points per LAW-01/LAW-02
//     ("mechanism in Go, product policy in TypeScript, customizable pieces
//     stay flexible") and docs/host-decomposition.md classifies router.ts
//     itself as BOUNDARY leaning KEEP TYPESCRIPT specifically because of
//     them;
//   - any DB access (findSessionForAgent's mention-sticky lookup, session
//     resolution, dropped_messages / messages_in writes) — every function
//     below takes already-resolved booleans/strings instead, mirroring how
//     internal/session's own ResolveSession takes plain string IDs rather
//     than owning messaging_groups/agent_groups;
//   - channel-adapter/registry lookups (getChannelDefaults, getChannelAdapter)
//     — channel adapters are themselves a customizable, user-extensible
//     surface, so their declarations and capabilities are resolved by the
//     TypeScript caller and passed in as plain values;
//   - container wake, typing indicators, cross-session-context fan-in/backfill,
//     command-gate classification, or attachment extraction — separate
//     TS-only concerns (container lifecycle is P4-03's job; command-gate/
//     guard classification is Phase 5's).
//
// What remains, and is implemented here, is routeInbound's actual decision
// arithmetic: evaluateEngage's mode switch, the fan-out loop's
// engaged/accumulated/dropped combinatorics (including the security rule
// that a gate-refused engagement must never fall through to accumulate), the
// no-wirings branch's silent-vs-record decision, the effectiveSessionMode
// thread-override derivation, the per-agent message-id namespacing rule, and
// channel-defaults.ts's resolveThreadPolicy. Every function is a pure,
// caller-supplied-input decision — no I/O, no hooks, no side effects — so
// each one is independently unit-testable against the exact same scenarios
// src/differential/fixtures-batch2.test.ts and src/router-*.test.ts already
// pin for the TypeScript host.
package routing

import (
	"regexp"

	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// EngageMode mirrors messaging_group_agents.engage_mode's three defined
// values. The column has no DB CHECK constraint, so a row can carry
// anything else — see EngageResult.Unknown.
type EngageMode string

const (
	// EngageModePattern engages when text matches the wiring's regex
	// pattern (or always, for the "." always-match shorthand).
	EngageModePattern EngageMode = "pattern"
	// EngageModeMention engages only when isMention is true.
	EngageModeMention EngageMode = "mention"
	// EngageModeMentionSticky engages on a mention, or (in a group, once a
	// sticky session exists) on any message in the sticky conversation.
	EngageModeMentionSticky EngageMode = "mention-sticky"
)

// EngageResult is evaluateEngage's verdict (src/router.ts:477-515) for one
// wired agent against one inbound message.
type EngageResult struct {
	// Engage is whether this wiring should engage (attempt to wake) for the
	// message.
	Engage bool
	// Unknown marks an engage_mode value outside the three EngageMode
	// constants above — a stale row from a past CLI version, or a direct DB
	// write, since the column has no CHECK constraint. Engage is always
	// false when Unknown is true (evaluateEngage's default case fails
	// closed). Logging the warning and recording the resulting drop are the
	// TS caller's job (src/router.ts:509-513, src/router.ts:444-454) — this
	// package stays mechanism-only and produces no side effects.
	Unknown bool
}

// EvaluateEngage decides whether one wired agent should engage on this
// message, mirroring evaluateEngage (src/router.ts:477-515):
//
//   - pattern: pattern nil or "." always engages ("." is the documented
//     always-match shorthand — router.ts checks it before ever compiling a
//     regex, so it never depends on Go/JS regex compatibility). Otherwise
//     the pattern is tested against text; an invalid pattern fails OPEN
//     (engages), mirroring the try/catch at router.ts:488-493 so an admin
//     sees the agent responding and can fix the pattern rather than the
//     agent silently going dark.
//
//     Divergence (intentional, documented — not silently assumed away): the
//     TS host evaluates patterns with JS RegExp; this evaluates them with
//     Go's regexp (RE2). RE2 has no backreferences or lookaround, so a
//     pattern that is valid JS but invalid or differently-matching RE2 can
//     behave differently between the two hosts. A pattern RE2 rejects
//     outright still fails open here, which happens to match the TS
//     fail-open outcome for a truly malformed pattern, but a pattern that
//     compiles under both engines with different match semantics (e.g. one
//     using backreferences) will NOT behave identically. Any operator-facing
//     documentation of engage_mode='pattern' for the Go host must call this
//     out rather than claim byte-for-byte regex parity.
//
//   - mention: engages iff isMention.
//
//   - mention-sticky: engages if isMention; DMs (isGroup=false) never engage
//     without a mention (router.ts:501, "DMs never use mention-sticky
//     sensibly"); otherwise defers to stickyExisting, which the caller
//     resolves via findSessionForAgent — a DB lookup this package does not
//     own (mirrors internal/session.ResolveSession's own DB-free API shape).
//
//   - anything else: Unknown=true, Engage=false — fails closed.
func EvaluateEngage(mode string, pattern *string, text string, isMention, isGroup, stickyExisting bool) EngageResult {
	switch EngageMode(mode) {
	case EngageModePattern:
		pat := "."
		if pattern != nil {
			pat = *pattern
		}
		if pat == "." {
			return EngageResult{Engage: true}
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return EngageResult{Engage: true} // fail open, mirrors router.ts:490-493
		}
		return EngageResult{Engage: re.MatchString(text)}
	case EngageModeMention:
		return EngageResult{Engage: isMention}
	case EngageModeMentionSticky:
		if isMention {
			return EngageResult{Engage: true}
		}
		if !isGroup {
			return EngageResult{Engage: false}
		}
		return EngageResult{Engage: stickyExisting}
	default:
		return EngageResult{Engage: false, Unknown: true}
	}
}

// IgnoredMessagePolicy mirrors messaging_group_agents.ignored_message_policy.
type IgnoredMessagePolicy string

const (
	// IgnoredMessagePolicyDrop discards a message from an unengaged wiring
	// instead of accumulating it for later delivery.
	IgnoredMessagePolicyDrop IgnoredMessagePolicy = "drop"
	// IgnoredMessagePolicyAccumulate accumulates a message from an
	// unengaged wiring instead of dropping it.
	IgnoredMessagePolicyAccumulate IgnoredMessagePolicy = "accumulate"
)

// WiringOutcome is DecideWiringOutcome's verdict for one wired agent: whether
// deliverToAgent should be called at all, and with which wake value.
type WiringOutcome struct {
	// Deliver is whether this wiring should receive the message at all
	// (i.e. deliverToAgent is called).
	Deliver bool
	// Wake is deliverToAgent's own `wake` parameter — true for the engaged
	// branch (container wake, typing indicator, cross-session fan-in all
	// fire), false for the silent accumulate branch. Only meaningful when
	// Deliver is true.
	Wake bool
}

// DecideWiringOutcome reproduces the fan-out loop's per-wiring branch
// (src/router.ts:398-441) exactly: engaged-and-both-gates-allowed delivers
// with wake=true; otherwise, when the wiring wasn't refused by a gate it
// actually engaged against, an accumulate policy delivers with wake=false;
// everything else is a silent drop.
//
// accessAllowed and scopeAllowed are the two gates' results ALREADY resolved
// to "allowed" when no gate is registered at all — mirroring router.ts:395-396's
// `!accessGate || (await accessGate(...)).allowed` and the equivalent for
// senderScopeGate. The gates themselves (the permissions module's hooks) are
// LAW-01/LAW-02 customization seams this package does not own; only their
// booleans cross this boundary.
//
// SECURITY-CRITICAL: when engaged is true and either gate refused
// (deniedByGate below), the outcome is always {Deliver: false} — it must
// NEVER fall through to the accumulate branch even when
// ignoredPolicy=='accumulate'. An untrusted sender who fails the access or
// scope gate must not have their message silently accumulated into agent
// context (which also stages their attachments to disk via
// writeSessionMessage) for a later, legitimate engagement to read. This
// mirrors the `!(engages && (!accessOk || !scopeOk))` guard at
// router.ts:423.
func DecideWiringOutcome(engaged, accessAllowed, scopeAllowed bool, ignoredPolicy IgnoredMessagePolicy) WiringOutcome {
	if engaged && accessAllowed && scopeAllowed {
		return WiringOutcome{Deliver: true, Wake: true}
	}
	deniedByGate := engaged && (!accessAllowed || !scopeAllowed)
	if !deniedByGate && ignoredPolicy == IgnoredMessagePolicyAccumulate {
		return WiringOutcome{Deliver: true, Wake: false}
	}
	return WiringOutcome{Deliver: false, Wake: false}
}

// NoAgentEngaged reproduces routeInbound's post-fan-out check
// (src/router.ts:444): after every wired agent has been evaluated, did
// NOTHING engage or accumulate? If so the message is recorded with
// reason='no_agent_engaged'. engagedCount/accumulatedCount are the fan-out
// loop's own running tallies of WiringOutcome{Deliver:true} results (Wake
// true and false respectively) — this function doesn't re-derive them from a
// stored outcome list because the TS original doesn't either; it just counts
// as it goes.
func NoAgentEngaged(engagedCount, accumulatedCount int) bool {
	return engagedCount+accumulatedCount == 0
}

// UnwiredChannelAction is DecideUnwiredChannel's verdict for a messaging
// group with zero wirings (src/router.ts:299-336).
type UnwiredChannelAction int

const (
	// UnwiredIgnore means not a mention/DM at all — router.ts returns
	// immediately at line 300 with no DB write of any kind, not even
	// auto-creating the messaging_groups row (that decision happens
	// earlier, at line 253, for the same reason: plain chatter in a
	// channel the bot merely sits in must never touch the DB).
	UnwiredIgnore UnwiredChannelAction = iota
	// UnwiredSilent means the message warranted attention, but the
	// channel's owner already denied it (mg.denied_at is set) —
	// router.ts:301-307 drops with only a debug log, no dropped_messages
	// row.
	UnwiredSilent
	// UnwiredRecord means the message warranted attention and the
	// channel isn't denied — router.ts:309-318 always records a
	// dropped_messages row with
	// reason='no_agent_wired' here, regardless of whether a
	// channel-request gate is registered. Whether a registered gate is then
	// asked to escalate (router.ts:320-334) is an orthogonal TS-side
	// decision layered on top of this verdict, not part of it — a
	// registered gate changes ONLY whether escalation is attempted, never
	// whether the drop is recorded.
	UnwiredRecord
)

// DecideUnwiredChannel reproduces routeInbound's no-wirings branch
// (src/router.ts:299-336).
func DecideUnwiredChannel(isMention, denied bool) UnwiredChannelAction {
	if !isMention {
		return UnwiredIgnore
	}
	if denied {
		return UnwiredSilent
	}
	return UnwiredRecord
}

// EffectiveSessionMode reproduces deliverToAgent's effectiveSessionMode
// derivation (src/router.ts:533-536): a thread-enabled wiring in a group
// chat is forced to per-thread regardless of its configured session_mode,
// because a shared mode in a threaded group chat would otherwise collapse
// every thread into one session. agent-shared is exempt — it already
// ignores messaging group AND thread scoping entirely by definition, so
// forcing it to per-thread here would contradict what agent-shared means.
func EffectiveSessionMode(configured session.Mode, threadsEnabled, isGroup bool) session.Mode {
	if threadsEnabled && configured != session.ModeAgentShared && isGroup {
		return session.ModePerThread
	}
	return configured
}

// MessageIDForAgent reproduces messageIdForAgent's per-agent namespacing
// (src/router.ts:674-677): the same inbound message fans out to multiple
// per-agent session DBs, and messages_in.id is PRIMARY KEY, so the raw id is
// namespaced by agent_group_id to stay unique per session. Generating a
// fallback id when the inbound event carries none at all (TS's
// generateId(), router.ts:40-42) is the caller's job — this function only
// namespaces whatever non-empty id it's given.
func MessageIDForAgent(id, agentGroupID string) string {
	return id + ":" + agentGroupID
}

// ResolveThreadPolicy reproduces channel-defaults.ts's resolveThreadPolicy: a
// pure combination of the wiring's threads override (nil = inherit the
// channel's declared default), the channel's declared threads default for
// this context (group vs DM — itself resolved from the channel-adapter
// registry, a customizable, user-extensible surface that stays TypeScript
// per LAW-01, so the resolved boolean crosses this boundary rather than the
// declaration struct or a lookup key), and the live adapter's raw
// thread-support capability. A wiring can opt OUT of threads on a threaded
// platform but can never opt IN on a non-threaded one — supportsThreads is
// hard-ANDed in, never overridden.
func ResolveThreadPolicy(wiringThreads *int, declaredDefault, supportsThreads bool) bool {
	wanted := declaredDefault
	if wiringThreads != nil {
		wanted = *wiringThreads != 0
	}
	return wanted && supportsThreads
}
