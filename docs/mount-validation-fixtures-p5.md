# Mount-Validation Fixture Capture (pre-P5-02)

**Status**: committed 2026-09-02, as pre-Phase-5 prep. Captures a golden TS baseline for `validateSpec`/`mountAllowed` — the one thing every prior Go port (P4-01 through P4-06) had before writing Go code, and the one thing P5-02 currently would not, per the Opus pre-Phase-5 review's LAW-06 finding: none of the 65 existing differential fixtures exercise mount validation at all.

## Methodology

`src/drivers/types.ts` (pinned `go-host-experiment` checkout, `v2.3.0` / `54d9d9a5`) has **zero external imports** — it is pure, self-contained TypeScript with no dependency on the DB, Docker, or the mailbox stack. That means `validateSpec` can be executed directly, for real, outside the full NanoClaw repo and without Vitest, `better-sqlite3`, or a live Docker daemon — a copy of the file plus a small harness is enough to get genuine, non-simulated verdicts from the real pinned code. This is different from the composed-Go-function approach P4-06's `internal/parity` package used (which asserted against pre-existing Vitest `.snap` files). Here, no snapshot existed to assert against, so this capture *is* the first golden record, produced by running the actual TypeScript function rather than by writing a new Vitest test file. A new Vitest test file would still need the user's Mac to execute, per this project's standing "no device_bash for Mac" constraint — reserved for when this becomes a proper differential-fixture file under `src/differential/`.

24 cases were constructed, covering the six invariant categories `validateSpec` actually implements: canonical-path form, class-vs-path pinning (`classRequiredByPath`), class-specific rules (`install-surface` read-only, `identity-material` read-only-and-never-agent), cross-group scope (`group-state`'s `groupScope`/folder-label check), duplicate container paths, secret-shaped env values (plain `env` and the `contributedEnv` lane), and the spec-shape checks (exactly one `agent`-role container, `runtimeTier` within the driver's declared isolation tiers). Each case sets an `expect` column stating the **desired, hardened** verdict — not necessarily today's actual behavior — so a mismatch is flagged as a finding, not silently treated as ground truth.

Run with `tsx capture.ts` against a verbatim copy of `types.ts`. Full script attached alongside this doc (`capture.ts`) for re-running, extending, or converting into a real `src/differential/fixtures-mount-security.test.ts` once P5-02 begins.

## Results: 22 of 24 match the hardened expectation; 2 are the already-known gap

```
OK   normal-group-state-mount-allowed: expect=allow actual=allow
OK   normal-install-surface-readonly-allowed: expect=allow actual=allow
OK   path-traversal-dotdot-rejected: expect=deny actual=deny
OK   path-relative-rejected: expect=deny actual=deny
OK   path-double-slash-rejected: expect=deny actual=deny
OK   path-trailing-slash-rejected: expect=deny actual=deny
DIFF docker-socket-via-allowlisted-extra-class-label: expect=deny actual=allow
DIFF ssh-dir-via-allowlisted-extra-class-label: expect=deny actual=allow
OK   identity-material-relabeled-as-allowlisted-extra-into-agent: expect=deny actual=deny
OK   install-surface-relabeled-as-group-state-writable: expect=deny actual=deny
OK   identity-material-into-agent-role-rejected: expect=deny actual=deny
OK   identity-material-writable-rejected-even-on-non-agent-role: expect=deny actual=deny
OK   cross-group-groupscope-mismatch-rejected: expect=deny actual=deny
OK   cross-group-groupsroot-without-folder-label-rejected: expect=deny actual=deny
OK   cross-group-groupsroot-wrong-folder-label-rejected: expect=deny actual=deny
OK   duplicate-containerpath-rejected: expect=deny actual=deny
OK   secret-shaped-key-in-plain-env-rejected: expect=deny actual=deny
OK   credential-shaped-value-under-innocuous-key-rejected: expect=deny actual=deny
OK   credential-value-in-contributedEnv-rejected-even-though-key-name-exempt: expect=deny actual=deny
OK   path-value-in-contributedEnv-allowed-even-with-credential-shaped-key: expect=allow actual=allow
OK   jwt-shaped-value-rejected: expect=deny actual=deny
OK   runtime-tier-not-in-driver-isolation-tiers-rejected: expect=deny actual=deny
OK   zero-agent-containers-rejected: expect=deny actual=deny
OK   two-agent-role-containers-rejected: expect=deny actual=deny
```

(Each `OK` line's exact denial message — e.g. `denied-by-policy: mount ... must be classed identity-material, not allowlisted-extra` — is captured in the script's own console output; omitted above for brevity, reproducible by re-running `capture.ts`.)

### What the two `DIFF` rows mean, precisely

`docker-socket-via-allowlisted-extra-class-label` and `ssh-dir-via-allowlisted-extra-class-label` are the **same already-known, already-fixed-upstream gap** (`mount-security-hardening.patch` / [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680)), now demonstrated by direct execution against this project's own pinned baseline rather than only described in prose. `mountAllowed`'s `case 'allowlisted-extra': return true` trusts the class label unconditionally, with no independent path re-check — so a `SessionSpec` that reaches `validateSpec` with `/var/run/docker.sock` or `/root/.ssh` labeled `allowlisted-extra` is **allowed**, not denied, on the pinned `v2.3.0` code today. It is the first *executable, reproducible* confirmation of it, and it is now the natural first regression fixture for whichever task ports (or replaces) `mountAllowed`'s `allowlisted-extra` handling. The fixture should flip from `DIFF` to `OK` the moment that port includes the fix; staying `DIFF` after the port would mean the fix wasn't actually carried over.

### What the 22 `OK` rows establish

These are not merely "no bugs found" — they are a positive, executable LAW-08 baseline: this project can now state, with direct evidence rather than inference from prose, that on the pinned `v2.3.0` baseline, `validateSpec` already correctly enforces path canonicalization, class-vs-path pinning (a `.ssh`-adjacent identity-material path cannot be relabeled into a more permissive class), the identity-material ro-only/never-agent invariant, cross-group mount scoping (including two distinct forgery attempts against the shared `groupsRoot`), duplicate-target rejection, and secret-shaped value detection in both the plain and provider-contributed env lanes. Any future Go port that fails one of these 22 cases has regressed relative to the documented TS baseline — exactly the kind of concrete, falsifiable claim LAW-06/LAW-08 exist to make possible.

## What this capture does not do

It is not a Vitest-integrated differential fixture (no `.snap` file, not added to `src/differential/`, not run via `pnpm test`) — that conversion is real work for P5-01/P5-02 itself, since it requires deciding the exact `ParityResult`-equivalent shape for mount decisions (see `docs/parity-schema.md`'s own axis list, which already reserves space for this under a "mount"/"runtime" axis). It does not exercise `mount-security/index.ts`'s `validateMount`/`loadMountAllowlist` (the allowlist-file-based layer, one level upstream of `validateSpec`) — that module has real DB-free but filesystem-dependent logic (reads `~/.config/nanoclaw/mount-allowlist.json`) that would need a temp-directory harness, not the zero-dependency approach this capture used. That is a reasonable P5-01/P5-02 follow-up, not done here. It does not read or exercise `docker-driver.ts`'s `prepare()` itself (see the drivers addendum's note that this file wasn't read in full this pass).

## References

- `src/drivers/types.ts` (pinned `v2.3.0` / `54d9d9a5`) — `validateSpec`, `mountAllowed`, `classRequiredByPath`, `isSecretShaped`, `looksLikeCredential`.
- `docs/threat-model-addendum-p5.md` §1 (Docker socket) and §4 (secret exposure) — where these findings are folded into the threat model proper.
- `docs/host-decomposition-addendum-drivers.md` — the classification entry this capture's methodology and findings support.
- `docs/parity-schema.md` — the six-axis comparison design this capture's eventual Vitest conversion should follow.
- `mount-security-hardening.patch` / [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) — the fix for the two `DIFF` rows, not yet in this project's pinned baseline (see ADR-003).
