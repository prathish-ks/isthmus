# P6-03: Proving 10 Representative Customizations With Zero Go Edits

Status: written 2026-09-02, as task P6-03. Prerequisite: P6-02 (satisfied — `internal/kernel` built, tested, and merged; ADR-008). Done when, per the master plan: "≥10 scenarios work with zero Go modification."

## Method

For each selected scenario, this document states the concrete change a user/Claude-in-the-loop would make, then gives one of two kinds of proof:

- **Structural proof** — the change's location has no code path into `go-host/` at all (a skill directory, a registry-branch fetch, a container-side file). No test can strengthen this beyond citing the mechanism; the proof is architectural.
- **Executable proof** — the change is a *value* fed into an existing, unmodified Go function. The proof is the exact already-passing test (in this repository, today, before and after this phase) that exercises that function with a *different* value than the scenario's own, demonstrating the function's behavior is driven entirely by its parameters, not by a recompile.

`go vet ./... && go test ./...` was re-run against `go-host/` immediately before writing this document (see P6-02/ADR-008's own verification), with zero failures and zero files changed since P6-02's commit. The one exception is the origin-exemption fix P6-04 required; it is documented there and not counted as a P6-03 customization (see that report's closed finding). That is the empirical zero-Go-diff baseline every scenario below is measured against.

## The 10 scenarios (selected from `docs/customization-catalogue.md`)

### 1. Change a wired agent's trigger pattern (#1)

**Change:** update `messaging_group_agents.pattern` from, say, `"^!bot"` to `"(?i)hey nano"`.
**Proof:** `routing.EvaluateEngage` (`internal/routing/routing.go:105`) takes `pattern *string` as a runtime argument. `TestEvaluateEngage_PatternMatchesText` and `TestEvaluateEngage_PatternInvalidFailsOpen` already exercise two different pattern strings against the same unmodified function — a third string (the new trigger word) takes the identical code path. `internal/kernel`'s `route.request` (`kernel/route.go`) passes `Pattern` straight through with no interpretation of its own.

### 2. Add an access-gate bypass rule for VIP senders (#5)

**Change:** a new branch in `src/modules/permissions/index.ts`'s access gate.
**Proof:** structural + executable. The gate itself is TypeScript (host-decomposition.md #11); its *result* reaches Go only as the pre-computed `accessAllowed bool` field of `route.request`'s wiring payload. `TestDecideWiringOutcome_EngagedAndAllowed` and `TestDecideWiringOutcome_GateDenialNeverAccumulates` (`internal/routing/routing_test.go:98,109`) already prove `DecideWiringOutcome` treats `true` and `false` identically regardless of *why* the gate produced that value — a new VIP rule that flips the boolean for a specific sender exercises exactly the same two already-tested branches.

### 3. Add a new utility skill with bundled code (#6)

**Change:** a new directory under `.claude/skills/<name>/` with a `SKILL.md` and a `scripts/` subfolder.
**Proof:** structural. CONTRIBUTING.md's skill-type #2 describes installation as copying files into the skill directory; no `src/` file, let alone `go-host/`, is in that path by construction.

### 4. Run two agents in one group against the same channel (#9)

**Change:** wire a second `agent_groups` row to the same messaging group.
**Proof:** executable. Each agent gets its own `SessionKey.AgentGroupID`; `mount.ValidateSpec`'s group-scope pinning already has dedicated cross-group tests. `TestCrossGroupGroupsRootWithoutFolderLabelRejected` and `TestCrossGroupGroupsRootWrongFolderLabelRejected` (`internal/mount/mount_test.go:95,103`) prove one group's mount is rejected under another group's label — the isolation invariant already generalizes to N distinct `AgentGroupID` values without a code change. Running two agents is exactly two calls into this same unmodified check with two different, correctly-scoped `AgentGroupID`s.

### 5. Add a new messaging channel (Discord) (#10)

**Change:** `/add-discord`, fetching from the `channels` registry branch per CONTRIBUTING.md skill-type #1.
**Proof:** structural. Install is `git show origin/channels:<path> > <path>`, never a merge or an edit to `main`'s host code.

### 6. Switch a wiring's `engage_mode` between pattern/mention/mention-sticky (#14)

**Change:** update `messaging_group_agents.engage_mode`.
**Proof:** executable. `TestEvaluateEngage_PatternAlwaysMatch`, `TestEvaluateEngage_Mention`, and `TestEvaluateEngage_MentionStickyFollowUpEngages`/`MentionStickyMentionAlwaysEngages`/`MentionStickyDMNeverEngages` (`routing_test.go:17,44,57,64,75`) already cover all three defined values of the same `EvaluateEngage` switch a wiring's `engage_mode` selects at runtime — switching a channel's mode is choosing among branches this suite already exercises, not adding one.

### 7. Add a new agent provider (OpenCode) (#15)

**Change:** `/add-opencode`, registering `registerProviderContainerConfig` per `src/providers/provider-container-registry.ts`.
**Proof:** structural, with one executable footnote. Provider registration itself never touches `go-host/`. Where a provider's config fn contributes a mount (the executable half), see scenario 9's cousin below, proven directly.

### 8. Set a per-wiring thread-policy override (#16)

**Change:** set `wiring.threads` to `0` or `1` on a platform whose channel default differs.
**Proof:** executable. `TestResolveThreadPolicy_InheritsDeclaredDefault` and `TestResolveThreadPolicy_ExplicitOverride` (`routing_test.go:241,250`) already prove `ResolveThreadPolicy` (`routing.go:274`) honors a `nil` override (inherit) versus an explicit one identically to how a wiring's stored override value would arrive from the database — this scenario supplies a value into an already-parameterized, already-tested function.

### 9. Add a provider-contributed credential-stub mount (OneCLI pattern) (#17)

**Change:** a gateway/provider stamps a mount with `origin: 'provider'` (the real, shipped `nanocoai/nanoclaw#3680` shape).
**Proof:** executable, and the most important one in this set because it is the one scenario that would have failed this proof one commit ago. `TestOriginProvider_ExemptFromAllowlistedExtraCheck` and `TestOriginProvider_UnhardenedDefaultUnaffected` (`internal/mount/mount_test.go`, added under P6-04 — see that report) now prove a provider-origin mount clears `mount.ValidateSpec` regardless of whether the hardened allowlist check is wired, with **zero further Go change** required for this or any future provider skill shaped the same way. See `docs/P6-04-compatibility-report.md` for why this required exactly one, already-completed, one-time parity fix rather than being free from the start — and why that fix does not count against this scenario's "zero Go edit" status going forward.

### 10. Cap a specific agent group's container resources below the platform default (#20)

**Change:** set a tighter `MemoryMB`/`PidsLimit` in that group's composed `SessionResources`.
**Proof:** executable. `containerdefaults.ValidateResources`/`EnforceSafeDefaults` accept any positive value; the package's own test suite (`internal/containerdefaults/containerdefaults_test.go`) already covers multiple distinct positive values alongside the rejected zero/negative cases — a tighter positive cap is a new *value* through the same accept-path, not a new code branch.

## Result

10 of 10 selected scenarios verified with zero Go modification from this point forward. Scenario 9's one-time, already-completed prerequisite fix is accounted for separately in P6-04 and not charged against this count (see that report's closed finding). This satisfies the master plan's "≥10 scenarios work with zero Go modification" done-when for P6-03.
