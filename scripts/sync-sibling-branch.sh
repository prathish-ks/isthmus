#!/usr/bin/env bash
# Keeps one of this project's "sibling" branches (channels, providers) in
# sync with the same-named branch on nanocoai/nanoclaw. These branches carry
# no Isthmus-specific commits of their own (see CLAUDE.md's "Channels and
# Providers" section) -- /add-<channel> and /add-opencode/add-codex skills
# copy individual files out of them, they are never merged into main -- so
# keeping this project's copy current is a pure mirror operation, safe to
# automate as long as it never does anything but fast-forward.
#
# Split into two subcommands, run from two separate CI jobs with different
# GitHub token permissions -- not a stylistic choice. A GitHub Copilot PR
# review correctly flagged the original single-job design: it fetched
# upstream's current tree and ran `pnpm install`/`pnpm exec tsc` inside it
# (to run the health check below) in the SAME job that held a
# `contents: write` token for the eventual push. `pnpm install` can execute
# arbitrary lifecycle scripts from fetched package metadata; a compromised
# upstream branch or a compromised transitive dependency could have used
# that to push unauthorized refs or exfiltrate the token, regardless of how
# much this project trusts nanocoai/nanoclaw's maintainers specifically --
# their own dependencies are a much larger, less-vetted trust boundary.
#
#   check <branch>   -- read-only: fetch, verify fast-forward, run the
#                        typecheck health check. Never pushes. Meant to run
#                        under `permissions: contents: read` with checkout
#                        credentials NOT persisted (untrusted code -- the
#                        fetched branch's own package installs and
#                        typechecks -- executes here, so this job should
#                        hold nothing worth stealing). Emits should_push and
#                        target_sha via emit_output (to $GITHUB_OUTPUT when
#                        set, else stdout, for local/test use).
#   push <branch> <expected-sha>
#                     -- write: re-fetches the branch fresh and REFUSES to
#                        push unless its tip still matches <expected-sha>
#                        exactly (fails closed with a ::warning:: if
#                        upstream moved between check and push, rather than
#                        pushing a commit nothing ever typechecked). Runs no
#                        installed/fetched code at all -- only `git fetch`/
#                        `git push` against ref names and SHAs. Meant to run
#                        under `permissions: contents: write`, needing
#                        nothing else.
#
# Exits 0 in every outcome except a git command itself failing -- this
# script reports outcomes via ::warning:: annotations rather than failing
# the job, matching this file's own upstream-watch/egress-image-watch jobs:
# a stale mirror or a diverged branch is a prompt for a human, not a build
# failure.
#
# Sourceable: only runs main when executed directly, not when sourced (same
# reason check-wiring-registry.ts guards its own main() behind
# `process.env.VITEST !== 'true'`) -- sync-sibling-branch.test.sh sources
# this file to exercise count_errors()/check_branch()/push_branch()
# directly, without a real CI invocation.
set -euo pipefail

upstream_url_for() {
  # Overridable so sync-sibling-branch.test.sh can point at a local
  # throwaway repo instead of the real network.
  echo "${SYNC_SIBLING_UPSTREAM_URL:-https://github.com/nanocoai/nanoclaw.git}"
}

emit_output() {
  local key="$1" value="$2"
  echo "${key}=${value}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${key}=${value}" >> "$GITHUB_OUTPUT"
  fi
}

count_errors() {
  local ref="$1" dir="$2"
  git worktree add --quiet --detach "$dir" "$ref" >/dev/null
  # --ignore-scripts: this install exists only to make `tsc` resolvable
  # for the read-only typecheck health check below -- it never needs to
  # actually build/run anything, so there is no reason to let a fetched
  # package's lifecycle scripts execute at all. Confirmed by hand this
  # produces byte-identical `tsc --noEmit` output to a scripts-enabled
  # install (TypeScript needs .d.ts files, not a built native binding).
  (cd "$dir" && pnpm install --frozen-lockfile --ignore-scripts --silent >/dev/null 2>&1)
  # tsc --noEmit exits non-zero whenever it reports anything -- which, per
  # this function's own caller comment, is every single run on these
  # branches (there's always at least the baseline cross-adapter noise).
  # Under this script's `set -euo pipefail`, an unguarded `... | wc -l`
  # here would make the pipeline's exit status tsc's non-zero one, and
  # since this function's result feeds a plain (non-`local`) assignment at
  # the call site, that failure propagates and aborts the whole script --
  # the exact "warn and skip" path this function exists to reach would
  # then never run. `|| true` neutralizes tsc's exit status at the source,
  # before it ever reaches the pipe, so only the line count carries
  # forward. Regression test: sync-sibling-branch.test.sh.
  #
  # `| tr -d '[:space:]'` guards against BSD wc (macOS, used when this
  # script is run locally rather than on the ubuntu-latest CI runner)
  # right-padding its count -- e.g. "       3" -- which GNU wc does not do
  # for piped input but this script shouldn't assume either way.
  (cd "$dir" && { pnpm exec tsc --noEmit 2>&1 || true; } | wc -l | tr -d '[:space:]')
}

check_branch() {
  local branch="${1:?usage: sync-sibling-branch.sh check <branch-name>}"
  local upstream_url
  upstream_url="$(upstream_url_for)"

  echo "=== ${branch} (check) ==="

  git fetch --no-tags --quiet "$upstream_url" "$branch":"refs/remotes/sibling-upstream/${branch}"
  local upstream_sha
  upstream_sha="$(git rev-parse "refs/remotes/sibling-upstream/${branch}")"

  local origin_sha=""
  if git fetch --no-tags --quiet origin "$branch":"refs/remotes/sibling-origin/${branch}" 2>/dev/null; then
    origin_sha="$(git rev-parse "refs/remotes/sibling-origin/${branch}")"
  fi

  if [ "$origin_sha" = "$upstream_sha" ]; then
    echo "${branch}: already in sync at ${upstream_sha}"
    emit_output "should_push" "false"
    return 0
  fi

  if [ -n "$origin_sha" ] && ! git merge-base --is-ancestor "$origin_sha" "$upstream_sha"; then
    echo "::warning title=Sibling branch diverged (${branch})::This project's '${branch}' branch (${origin_sha}) is not an ancestor of nanocoai/nanoclaw's '${branch}' (${upstream_sha}) -- it carries commits upstream doesn't have. Auto-sync refuses to overwrite a non-fast-forward; reconcile by hand (compare the two refs, then either rebase this project's extra commits on top of upstream's tip or fast-forward manually if the divergence turns out to be stale)."
    emit_output "should_push" "false"
    return 0
  fi

  echo "${branch}: fast-forward available, ${origin_sha:-<branch missing on origin>} -> ${upstream_sha}"

  # Health check: does adopting upstream's tip introduce typecheck errors
  # this project's copy of the branch didn't already have? These sibling
  # branches are never meant to typecheck as one whole tree on their own
  # (they carry every channel/provider's files at once; only the specific
  # files a skill copies ever get built into main), so a bare
  # `tsc --noEmit` always reports a nonzero baseline -- the meaningful
  # signal is whether the pull grows that baseline, not whether it's zero.
  local tmp_root
  tmp_root="$(mktemp -d)"

  local before_errors=0
  if [ -n "$origin_sha" ]; then
    before_errors="$(count_errors "refs/remotes/sibling-origin/${branch}" "${tmp_root}/before")"
  fi
  local after_errors
  after_errors="$(count_errors "refs/remotes/sibling-upstream/${branch}" "${tmp_root}/after")"

  # Deliberately not a `trap ... RETURN` here (an earlier version of this
  # function used one, on a reviewer's suggestion): a RETURN trap is not
  # scoped to the function that sets it, it stays armed, process-wide,
  # until something clears it -- and clearing it from inside the trap
  # handler itself turned out not to be enough, either. Once this
  # function gained a caller of its own (main()'s check/push dispatcher),
  # the trap fired a SECOND time when main() itself returned right after
  # check_branch() did, by which point $tmp_root (check_branch()'s own
  # local) no longer existed -- "unbound variable" under set -u. Found by
  # hand running this exact script under `bash -x` after the dispatcher
  # was added, confirmed with a minimal repro, and not fixable by
  # `trap - RETURN` as the trap handler's own first or last line (tried
  # both; the second firing happened regardless). Calling cleanup
  # unconditionally, once, right here -- after both count_errors() calls
  # have used $tmp_root and before anything below decides which return
  # path to take -- sidesteps the whole question of trap timing across
  # function-call layers. Both worktrees are removed explicitly (not just
  # `rm -rf`ing the directory) so this repo's own .git/worktrees/
  # metadata doesn't dangle. Regression-tested end-to-end in
  # sync-sibling-branch.test.sh.
  git worktree remove --force "${tmp_root}/before" 2>/dev/null || true
  git worktree remove --force "${tmp_root}/after" 2>/dev/null || true
  rm -rf "$tmp_root"

  echo "${branch}: typecheck error count before=${before_errors} after=${after_errors}"

  if [ "$after_errors" -gt "$before_errors" ]; then
    echo "::warning title=Sibling branch pull adds typecheck errors (${branch})::Pulling nanocoai/nanoclaw's '${branch}' tip (${upstream_sha}) raises this project's whole-tree typecheck error count on that branch from ${before_errors} to ${after_errors} (both counts include the branch's normal cross-adapter baseline noise -- only the delta matters). Auto-sync skipped this push; run \`pnpm exec tsc --noEmit\` on the new tip locally to see what's new before fast-forwarding '${branch}' by hand."
    emit_output "should_push" "false"
    return 0
  fi

  emit_output "should_push" "true"
  emit_output "target_sha" "$upstream_sha"
}

push_branch() {
  local branch="${1:?usage: sync-sibling-branch.sh push <branch-name> <expected-sha>}"
  local expected_sha="${2:?usage: sync-sibling-branch.sh push <branch-name> <expected-sha>}"
  local upstream_url
  upstream_url="$(upstream_url_for)"

  echo "=== ${branch} (push) ==="

  # Re-fetch rather than trust a SHA carried over from a separate check
  # job: upstream could have moved in between (a new commit landing, or in
  # the worst case a force-push), and this must never push a commit that
  # check_branch()'s health check didn't actually run against. Failing
  # closed here -- skip with a warning, let the next scheduled run
  # re-verify the new tip -- costs nothing this job is in a hurry for.
  git fetch --no-tags --quiet "$upstream_url" "$branch":"refs/remotes/sibling-upstream/${branch}"
  local actual_sha
  actual_sha="$(git rev-parse "refs/remotes/sibling-upstream/${branch}")"

  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "::warning title=Sibling branch moved before push (${branch})::nanocoai/nanoclaw's '${branch}' tip changed from ${expected_sha} (what this run's health check verified) to ${actual_sha} between the check and push steps. Skipping this push rather than pushing an unverified commit -- the next scheduled run will check and push the new tip."
    return 0
  fi

  # Defensive re-check, cheap and read-only: origin could have gained a
  # commit of its own (e.g. a manual push) in the same window.
  local origin_sha=""
  if git fetch --no-tags --quiet origin "$branch":"refs/remotes/sibling-origin/${branch}" 2>/dev/null; then
    origin_sha="$(git rev-parse "refs/remotes/sibling-origin/${branch}")"
  fi
  if [ -n "$origin_sha" ] && ! git merge-base --is-ancestor "$origin_sha" "$actual_sha"; then
    echo "::warning title=Sibling branch diverged before push (${branch})::This project's '${branch}' branch (${origin_sha}) gained commits since the check step and is no longer an ancestor of nanocoai/nanoclaw's '${branch}' (${actual_sha}). Skipping this push; reconcile by hand."
    return 0
  fi

  git push origin "refs/remotes/sibling-upstream/${branch}:refs/heads/${branch}"
  echo "${branch}: pushed fast-forward to ${actual_sha}"
}

main() {
  local subcommand="${1:?usage: sync-sibling-branch.sh <check|push> <branch-name> [expected-sha]}"
  shift
  case "$subcommand" in
    check) check_branch "$@" ;;
    push) push_branch "$@" ;;
    *)
      echo "unknown subcommand: ${subcommand} (expected check or push)" >&2
      return 1
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
