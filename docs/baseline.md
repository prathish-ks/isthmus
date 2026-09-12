# NanoClaw Go Host — Project Baseline

Recorded: 2026-08-29 (workspace pinned this date)

## Stable Baseline (pin for reproducible development)

- **NanoClaw version**: v2.3.0
- **Commit SHA**: `54d9d9a50c0e572fa3969d63ab87a4dd3d75cc6f`
- **Tag object**: `6077de45f0200723694c52227a3b578d1da82e77` (annotated tag; dereferences to the commit above)
- **Release date**: 24 Aug 2026 (per NanoClaw's release notes / this workbook)
- **Working branch**: `go-host-experiment`, branched directly from the `v2.3.0` tag (not from `main`), so all early Go-host work sits on top of a fixed, known-good revision.

## Repository / remotes

- Original upstream is public and popular (~30.6k stars, ~12.8k forks, 2,674 commits as of 29 Aug 2026) — a fork would inherit that public visibility, and GitHub does not support a private fork of a public repo. Instead:
- **`origin`**: originally `git@github.com:prathish-ks/nanoclaw-go-lab.git` — a brand-new **private** repo, populated via `git clone --mirror` + `git push --mirror` from upstream. Full branch/tag history was preserved; GitHub's reserved `refs/pull/*` refs were rejected on push, which is expected and unrelated to real branches/tags. This public repo, `prathish-ks/isthmus`, is a later export of that private workspace's `go-host-experiment` branch as a single fresh commit — it's an export, not a separate mirror clone. See the top-level README for why: it avoids carrying in-progress dev history and one minor path leak into the public record.
- **`upstream`**: `https://github.com/nanocoai/nanoclaw.git` — official repo, fetch-only in practice (no write access), used to track future releases without merging them into the stable branch.
- Auth: SSH key (`~/.ssh/id_ed25519`) registered on the GitHub account for `origin` push access.
- Note: this checkout's folder is named `nanoclaw-go-lab`, not the `nanoclaw`/`nanoclaw-v2` name the official Quick Start's `git clone` produces. This was suspected as the cause of 4 of the 15 baseline test failures (see P0-09 below). It was **ruled out on 2026-08-30** by re-running the same tests from a `git worktree` checked out at `~/dev/nanoclaw` (folder name matching the Quick Start exactly): same 2 files, same 15 failures. These are therefore genuine baseline failures independent of folder naming.

## Upstream watch (informational, not merged)

- `upstream/main` at commit `f6cf8dcf80b31d9c50b3d141581481fa166e7475`, captured 2026-08-29 10:57:40 UTC.
- This is materially ahead of the pinned v2.3.0 baseline (main has moved on) — expected, and exactly why the workbook separates a "stable baseline" track from an "upstream watch" track. No Go/compatibility work should assume anything from `upstream/main` until it's evaluated and, if relevant, promoted to a new pinned baseline via the upstream-compatibility process (see Upstream Strategy sheet).
- **Founder-confirmed architecture signal (2026-08-20, NanoClaw's official Discord, `#build-in-public`)**: a community member (ZappoMan) released MIT-licensed npm packages letting NanoClaw agents launch on external/cloud hosts (e.g. wake-on-use fly.io machines) instead of an always-on Docker-in-Docker setup (blog: `artificerinnovations.com/blog/launching-nanoclaw-agents-on-external-hosts`). That blog post wasn't independently fetched this session: the URL reached this session only as a screenshot image, so it fell outside the web-fetch tool's fetchable-URL provenance. Founder **Gavriel Cohen replied directly in the thread**: NanoClaw core has been building the same thing for weeks and is actively "in the process (yesterday and today) of merging the registries into NanoClaw core," calling the two approaches "identical from 30k feet." This is a first-party primary source (the actual founder, in the project's own official Discord) — materially stronger than the earlier ChatGPT-relayed "upstream monitoring" claims above, which failed verification on all four points. **Could not be independently corroborated against the live repo this session**: PR/commit search through the available web-fetch tooling returns a static, unfiltered default listing rather than executing GitHub's real search backend, so "no matching PR found" here is a tooling limitation, not evidence the work doesn't exist.
  - **Why this matters for this project**: a generalized "registry"/external-host abstraction for launching agent containers sits directly adjacent to — and possibly wraps or supersedes — the exact `container-runner.ts` / `drivers/types.ts` (`SessionDriver`, `SessionSpec`, `mountAllowed`) surface this project's threat model, compatibility contract, and shipped hardening PR (#3680) are all built against. **Decision: no change to current Phase 3 work** — the pinned `v2.3.0` baseline is deliberately decoupled from active upstream churn for exactly this reason (LAW-09, Upstream Strategy sheet). Flagged specifically for the next upstream-compatibility review (OBJ-08/OBJ-11): once this "registries" work lands in a tagged release, re-check that `SessionDriver.prepare(spec)` is still the real chokepoint before assuming the Go kernel's target interface is unchanged.
  - Also noted, lower relevance: Dial (`getdial.ai`) announced as an official NanoClaw vendor (2026-08-29, `#general`) — gives agents a phone number for voice/SMS/iMessage. A new channel/vendor integration, not an architecture change; no action needed for this project.

## Machine / OS

- Darwin 21.6.0 (macOS 12 Monterey), x86_64, Intel Mac (`Prathishs-Air`).
- Note: macOS 12 is past Apple's active support window; Homebrew warned about this. Claude Code's stated minimum is macOS 13.0+, yet it installed and ran fine here (v2.1.251) — a documented-minimum mismatch that didn't turn into an actual blocker. Worth re-testing if this machine is ever replaced.

## Toolchain — as found (before this session's fixes)

- Node: v10.15.3 — an unmanaged, standalone install at `/usr/local/bin/node` (not via Homebrew or a version manager). Incompatible: this repo's `package.json` requires **Node >=22** and `.nvmrc` pins `22` exactly. Nothing in the repo would run under this.
- pnpm: not installed.
- Go: 1.24.5 darwin/amd64 — already present and current; no action needed.
- Docker: 27.3.1 (build ce12230) — already present and current.

## Toolchain — current (after this session's fixes)

- Installed `nvm` v0.40.5 (official installer). Had to manually create `~/.zshrc` (it didn't exist) with nvm's standard init block, since the installer had no profile file to append to.
- `nvm install` / `nvm use` inside the repo picked up `.nvmrc` and installed **Node v22.23.2** (npm v10.9.8) — now the active `node` in new shells via nvm's shim, without needing to remove the old standalone install.
- Enabled Corepack and activated **pnpm 10.34.5** — matches the exact version pinned in `package.json`'s `"packageManager"` field.
- Go 1.24.5 and Docker 27.3.1 unchanged, already suitable.
- Installed Claude Code CLI (`npm install -g @anthropic-ai/claude-code`) — v2.1.251, required by `nanoclaw.sh` for guided setup/error-recovery and by NanoClaw's `/customize`, `/debug`, `/add-<channel>` skills. Logged in successfully.
- `better-sqlite3`'s native build script required explicit approval (`pnpm approve-builds`) — pnpm blocks postinstall scripts by default; without approving it, the SQLite native binding would not compile for this Node version.

## P0-08 — run original NanoClaw unchanged

**Result: succeeded.** Ran `bash nanoclaw.sh` (Standard setup, fresh default agent, **build agent image locally** — the default, no-account path per the README, rather than fetching the prebuilt image from the private ECR registry referenced in `versions.json`). Confirmed:

- Full pipeline round-trip works: host → container → agent (Claude, via OneCLI vault) → sandbox → response. Setup's built-in ping/pong test passed twice across two runs.
- `SERVICE: running`, `CONTAINER_RUNTIME: docker`, `CREDENTIALS: configured`, `IMAGE_SOURCE: local`, `IMAGE_SOURCE_ACTUAL: local`, image digest `sha256:e860c5794bc07bb865e030b9b269b185d0bc6f0745e61891e127df6d0e51991b`.
- Timezone auto-detected correctly as Australia/Melbourne.
- No messaging channel configured (deliberately skipped) — verification reports `STATUS: failed` / `REGISTERED_GROUPS: 0` purely because of that.

Two known rough edges, neither blocking:
- **Cosmetic**: cleanup of the setup's own CLI test agent failed (`logs/setup-steps/08-cleanup-cli-agent.log`) — it may linger in the agent list.
- **Real bug, not ours**: WhatsApp channel pairing failed on a first attempt — "Resolve your DM channel (3/3) failed", "Still needs: number_mode, unresolved `{{platform_id}}`" — an unresolved template placeholder in the WhatsApp adapter's setup flow. Claude Code's automatic debug hand-off applied a fix, but the retry wasn't taken (setup was re-run instead, skipping the phone-channel step entirely, which succeeded cleanly). Worth revisiting if/when we actually need WhatsApp — possibly connected to the 5 real ESLint errors in `src/channels/whatsapp.ts` around promise handling (see P0-09 below), though that link is speculative.

## P0-09 — baseline build/test/typecheck (this exact v2.3.0 checkout, unmodified)

| Command | Result |
|---|---|
| `pnpm typecheck` (`tsc --noEmit`) | **Clean pass** — no output (tsc prints diagnostics only on error; empty output is its normal success signal). Exit code not explicitly captured on either attempt, but the empty-output signal is unambiguous. |
| `pnpm build` (`tsc`) | **Clean pass** — same signal, no output. |
| `pnpm lint` (`eslint src/`) | **183 problems: 5 errors, 178 warnings.** 178 of the warnings are a single repeated custom rule, `no-catch-all/no-catch-all` ("catch block should rethrow unexpected errors"), spread across dozens of files — reads as an intentional house-style rule, not real bugs. A handful of `@typescript-eslint/no-explicit-any` warnings too. The 5 real **errors** are all in `src/channels/whatsapp.ts` (lines 689-958), all `@typescript-eslint/no-misused-promises` / `no-floating-promises` — mishandled promises in the WhatsApp adapter. |
| `pnpm test` (`vitest run`) | **1991 passed, 15 failed**, out of 2006 tests across 161 test files (159 files fully green, 2 files with failures) — 99.25% pass rate. |

Test failures, not investigated further for root cause (per "record baseline, don't fix yet"), but **confirmed NOT folder-name-related** (see below):
- `scripts/add-dial-tool-scope.test.ts` (11 failures) — every failure is `expect(status).toBe(0)` receiving `1`: a subprocess the test shells out to is exiting non-zero in this environment.
- `scripts/update/transaction.e2e.test.ts` (4 failures) — all "Update state contains mismatched or unsafe paths" from a `hasSafeStatePaths` check in `scripts/update/transaction.ts`.

**Folder-name hypothesis tested and ruled out (2026-08-30).** Per the second-opinion review recorded in the project doc, re-ran only these two test files from a disposable `git worktree` at `~/dev/nanoclaw` (branch `nanoclaw-check`, off `go-host-experiment` — same commit content, folder name matching the official Quick Start exactly):

```
Test Files  2 failed | 158 passed (160)
     Tests  15 failed | 1990 passed (2005)
```

Identical 2 files, identical 15 failures. The folder name is therefore **not** the cause — these are genuine environment- or upstream-sensitive baseline failures (root cause still unidentified; not investigated further per plan). Worth noting: total collected tests was 2005 here vs. 2006 in the original run (1990 vs. 1991 passed, same 15 failed) — a one-test difference, most likely a flaky/non-deterministic test being collected differently between runs. Not chased further. Worktree removed after the check (`git worktree remove ../nanoclaw`, `git branch -D nanoclaw-check`) — it was throwaway, not part of the permanent repo structure.

**This is now the recorded baseline against which future Go-host work should be compared** — any new failure beyond these 15 (or beyond the 5 pre-existing lint errors) is a real regression to investigate, not baseline noise.

## User background (context for pacing, not upstream-relevant)

- 19 years in technology; strong API/SDLC background; prior professional Go experience. TypeScript is new — the learning curve here is reading NanoClaw's existing TypeScript, not the language fundamentals alongside Go.
