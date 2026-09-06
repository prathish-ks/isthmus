package routing

import (
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

func strp(s string) *string { return &s }
func intp(i int) *int       { return &i }

// --- EvaluateEngage ---

// TestEvaluateEngage_PatternAlwaysMatch mirrors evaluateEngage's '.' shortcut
// (router.ts:487): a nil or "." pattern always engages without ever
// compiling a regex.
func TestEvaluateEngage_PatternAlwaysMatch(t *testing.T) {
	if got := EvaluateEngage("pattern", nil, "anything at all", false, false, false); !got.Engage || got.Unknown {
		t.Fatalf("expected nil pattern to always engage, got %+v", got)
	}
	if got := EvaluateEngage("pattern", strp("."), "anything at all", false, false, false); !got.Engage {
		t.Fatalf("expected '.' pattern to always engage, got %+v", got)
	}
}

func TestEvaluateEngage_PatternMatchesText(t *testing.T) {
	if got := EvaluateEngage("pattern", strp("^hello"), "hello there", false, false, false); !got.Engage {
		t.Fatalf("expected pattern to match, got %+v", got)
	}
	if got := EvaluateEngage("pattern", strp("^hello"), "goodbye", false, false, false); got.Engage {
		t.Fatalf("expected pattern not to match, got %+v", got)
	}
}

// TestEvaluateEngage_PatternInvalidFailsOpen mirrors router.ts:488-493's
// try/catch: a pattern that fails to compile engages anyway.
func TestEvaluateEngage_PatternInvalidFailsOpen(t *testing.T) {
	got := EvaluateEngage("pattern", strp("(unclosed"), "text", false, false, false)
	if !got.Engage {
		t.Fatalf("expected an invalid pattern to fail open (engage=true), got %+v", got)
	}
}

func TestEvaluateEngage_Mention(t *testing.T) {
	if got := EvaluateEngage("mention", nil, "text", true, false, false); !got.Engage {
		t.Fatalf("expected mention mode to engage when isMention, got %+v", got)
	}
	if got := EvaluateEngage("mention", nil, "text", false, false, false); got.Engage {
		t.Fatalf("expected mention mode not to engage without a mention, got %+v", got)
	}
}

// TestEvaluateEngage_MentionStickyFollowUpEngages mirrors the
// "mention-sticky-follow-up-engages" differential fixture: a group-chat
// follow-up with no mention still engages when a per-thread session already
// exists for this wiring.
func TestEvaluateEngage_MentionStickyFollowUpEngages(t *testing.T) {
	got := EvaluateEngage("mention-sticky", nil, "no mention here", false, true, true)
	if !got.Engage {
		t.Fatalf("expected mention-sticky follow-up (existing session, isGroup=true) to engage, got %+v", got)
	}
}

func TestEvaluateEngage_MentionStickyMentionAlwaysEngages(t *testing.T) {
	got := EvaluateEngage("mention-sticky", nil, "@bot hi", true, true, false)
	if !got.Engage {
		t.Fatalf("expected an explicit mention to engage regardless of sticky state, got %+v", got)
	}
}

// TestEvaluateEngage_MentionStickyDMNeverEngages mirrors the
// "mention-sticky-dm-never-engages" differential fixture (router.ts:501):
// DMs never use mention-sticky sensibly — a DM with no mention never
// engages, even if stickyExisting is somehow true.
func TestEvaluateEngage_MentionStickyDMNeverEngages(t *testing.T) {
	got := EvaluateEngage("mention-sticky", nil, "no mention here", false, false, true)
	if got.Engage {
		t.Fatalf("expected mention-sticky on a DM (isGroup=false) never to engage without a mention, got %+v", got)
	}
}

// TestEvaluateEngage_UnknownModeFailsClosed mirrors
// router-unknown-engage-mode.test.ts: an engage_mode outside the three
// defined values fails closed and is flagged Unknown so the caller can log
// and record the drop.
func TestEvaluateEngage_UnknownModeFailsClosed(t *testing.T) {
	got := EvaluateEngage("always", nil, "hello there", true, false, false)
	if got.Engage {
		t.Fatalf("expected an unrecognized engage_mode to fail closed, got %+v", got)
	}
	if !got.Unknown {
		t.Fatalf("expected Unknown=true for an unrecognized engage_mode, got %+v", got)
	}
}

// --- DecideWiringOutcome ---

func TestDecideWiringOutcome_EngagedAndAllowed(t *testing.T) {
	got := DecideWiringOutcome(true, true, true, IgnoredMessagePolicyDrop)
	if !got.Deliver || !got.Wake {
		t.Fatalf("expected engaged+allowed to deliver with wake=true, got %+v", got)
	}
}

// TestDecideWiringOutcome_GateDenialNeverAccumulates is the security-critical
// case: an engaged wiring refused by either gate must be a silent drop, even
// when ignored_message_policy='accumulate' — it must NEVER fall through to
// accumulate (router.ts:423's guard).
func TestDecideWiringOutcome_GateDenialNeverAccumulates(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		accessAllowed, scopeAllowed bool
	}{
		{"access denied", false, true},
		{"scope denied", true, false},
		{"both denied", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideWiringOutcome(true, tc.accessAllowed, tc.scopeAllowed, IgnoredMessagePolicyAccumulate)
			if got.Deliver {
				t.Fatalf("expected a gate-refused engagement to never deliver (not even accumulate), got %+v", got)
			}
		})
	}
}

// TestDecideWiringOutcome_AccumulateStoresWithoutWaking mirrors the
// "accumulate-stores-without-waking" differential fixture: a wiring that
// simply didn't engage (not refused by a gate) still gets the message
// delivered with wake=false when its policy is accumulate.
func TestDecideWiringOutcome_AccumulateStoresWithoutWaking(t *testing.T) {
	got := DecideWiringOutcome(false, true, true, IgnoredMessagePolicyAccumulate)
	if !got.Deliver || got.Wake {
		t.Fatalf("expected a non-engaged accumulate wiring to deliver with wake=false, got %+v", got)
	}
}

func TestDecideWiringOutcome_DropPolicyIsSilent(t *testing.T) {
	got := DecideWiringOutcome(false, true, true, IgnoredMessagePolicyDrop)
	if got.Deliver {
		t.Fatalf("expected a non-engaged drop-policy wiring not to deliver at all, got %+v", got)
	}
}

// --- NoAgentEngaged ---

func TestNoAgentEngaged(t *testing.T) {
	if !NoAgentEngaged(0, 0) {
		t.Fatalf("expected zero engaged and zero accumulated to report no_agent_engaged")
	}
	if NoAgentEngaged(1, 0) {
		t.Fatalf("expected any engaged wiring to suppress no_agent_engaged")
	}
	if NoAgentEngaged(0, 1) {
		t.Fatalf("expected any accumulated wiring to suppress no_agent_engaged")
	}
}

// --- DecideUnwiredChannel ---

func TestDecideUnwiredChannel_NotMentionedIsIgnored(t *testing.T) {
	if got := DecideUnwiredChannel(false, false); got != UnwiredIgnore {
		t.Fatalf("expected non-mention traffic on an unwired channel to be ignored, got %v", got)
	}
	if got := DecideUnwiredChannel(false, true); got != UnwiredIgnore {
		t.Fatalf("expected non-mention traffic to be ignored regardless of denied_at, got %v", got)
	}
}

// TestDecideUnwiredChannel_DeniedChannelIsSilent mirrors the
// "no-agent-wired-denied-channel" differential fixture.
func TestDecideUnwiredChannel_DeniedChannelIsSilent(t *testing.T) {
	if got := DecideUnwiredChannel(true, true); got != UnwiredSilent {
		t.Fatalf("expected a denied channel to drop silently, got %v", got)
	}
}

// TestDecideUnwiredChannel_NoGateStillRecords mirrors the
// "no-agent-wired-no-gate" differential fixture: recording happens whenever
// the channel isn't denied, regardless of whether a channel-request gate is
// registered — the gate only changes whether escalation is attempted.
func TestDecideUnwiredChannel_NoGateStillRecords(t *testing.T) {
	if got := DecideUnwiredChannel(true, false); got != UnwiredRecord {
		t.Fatalf("expected a mentioned, non-denied, unwired channel to record the drop, got %v", got)
	}
}

// --- EffectiveSessionMode ---

// TestEffectiveSessionMode_ThreadedGroupForcesPerThread mirrors the
// router-session-created.test.ts case "receives the resolved session mode
// when the thread policy overrides the wiring": a shared-mode wiring in a
// thread-enabled group chat resolves to per-thread at fanout.
func TestEffectiveSessionMode_ThreadedGroupForcesPerThread(t *testing.T) {
	got := EffectiveSessionMode(session.ModeShared, true, true)
	if got != session.ModePerThread {
		t.Fatalf("expected shared+threaded+group to resolve to per-thread, got %v", got)
	}
}

func TestEffectiveSessionMode_AgentSharedIsExempt(t *testing.T) {
	got := EffectiveSessionMode(session.ModeAgentShared, true, true)
	if got != session.ModeAgentShared {
		t.Fatalf("expected agent-shared to stay agent-shared even when threaded+group, got %v", got)
	}
}

func TestEffectiveSessionMode_DMNeverForced(t *testing.T) {
	got := EffectiveSessionMode(session.ModeShared, true, false)
	if got != session.ModeShared {
		t.Fatalf("expected a DM (isGroup=false) to keep its configured mode, got %v", got)
	}
}

func TestEffectiveSessionMode_ThreadsDisabledKeepsConfigured(t *testing.T) {
	got := EffectiveSessionMode(session.ModePerThread, false, true)
	if got != session.ModePerThread {
		t.Fatalf("expected threads-disabled to leave the configured mode untouched, got %v", got)
	}
}

// --- MessageIDForAgent ---

func TestMessageIDForAgent(t *testing.T) {
	got := MessageIDForAgent("m1", "ag-1")
	if got != "m1:ag-1" {
		t.Fatalf("expected 'm1:ag-1', got %q", got)
	}
}

func TestMessageIDForAgent_DistinctPerAgentGroup(t *testing.T) {
	a := MessageIDForAgent("m1", "ag-a")
	b := MessageIDForAgent("m1", "ag-b")
	if a == b {
		t.Fatalf("expected the same base message id fanned to two agent groups to namespace distinctly, got %q for both", a)
	}
}

// --- ResolveThreadPolicy ---

func TestResolveThreadPolicy_InheritsDeclaredDefault(t *testing.T) {
	if !ResolveThreadPolicy(nil, true, true) {
		t.Fatalf("expected nil wiring override to inherit the declared default (true) ANDed with capability")
	}
	if ResolveThreadPolicy(nil, false, true) {
		t.Fatalf("expected nil wiring override to inherit the declared default (false)")
	}
}

func TestResolveThreadPolicy_ExplicitOverride(t *testing.T) {
	if ResolveThreadPolicy(intp(0), true, true) {
		t.Fatalf("expected an explicit threads=0 override to disable threads even when declared default is true")
	}
	if !ResolveThreadPolicy(intp(1), false, true) {
		t.Fatalf("expected an explicit threads=1 override to enable threads even when declared default is false")
	}
}

// TestResolveThreadPolicy_CapabilityHardCaps: a wiring can never opt IN to
// threads on a platform that doesn't support them.
func TestResolveThreadPolicy_CapabilityHardCaps(t *testing.T) {
	if ResolveThreadPolicy(intp(1), true, false) {
		t.Fatalf("expected supportsThreads=false to hard-cap threads off regardless of the wiring override")
	}
}
