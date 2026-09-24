#!/usr/bin/env bash
# Keeps one of this project's "sibling" branches (channels, providers) in
# sync with the same-named branch on nanocoai/nanoclaw. These branches carry
# no Isthmus-specific commits of their own (see CLAUDE.md's "Channels and
# Providers" section) -- /add-<channel> and /add-opencode/add-codex skills
# copy individual files out of them, they are never merged into main -- so
# keeping this project's copy current is a pure mirror operation, safe to
# automate as long as it never does anything but fast-forward.
#
# Usage: sync-sibling-branch.sh <branch-name>
#
# Exits 0 whether or not anything was pushed -- this script reports outcomes
# via ::warning:: annotations rather than failing the job, matching this
# file's own upstream-watch/egress-image-watch jobs: a stale mirror or a
# diverged branch is a prompt for a human, not a build failure.
set -euo pipefail

branch="${1:?usage: sync-sibling-branch.sh <branch-name>}"
upstream_url="https://github.com/nanocoai/nanoclaw.git"

echo "=== ${branch} ==="

git fetch --no-tags --quiet "$upstream_url" "$branch":"refs/remotes/sibling-upstream/${branch}"
upstream_sha="$(git rev-parse "refs/remotes/sibling-upstream/${branch}")"

if git fetch --no-tags --quiet origin "$branch":"refs/remotes/sibling-origin/${branch}" 2>/dev/null; then
  origin_sha="$(git rev-parse "refs/remotes/sibling-origin/${branch}")"
else
  origin_sha=""
fi

if [ "$origin_sha" = "$upstream_sha" ]; then
  echo "${branch}: already in sync at ${upstream_sha}"
  exit 0
fi

if [ -n "$origin_sha" ] && ! git merge-base --is-ancestor "$origin_sha" "$upstream_sha"; then
  echo "::warning title=Sibling branch diverged (${branch})::This project's '${branch}' branch (${origin_sha}) is not an ancestor of nanocoai/nanoclaw's '${branch}' (${upstream_sha}) -- it carries commits upstream doesn't have. Auto-sync refuses to overwrite a non-fast-forward; reconcile by hand (compare the two refs, then either rebase this project's extra commits on top of upstream's tip or fast-forward manually if the divergence turns out to be stale)."
  exit 0
fi

echo "${branch}: fast-forward available, ${origin_sha:-<branch missing on origin>} -> ${upstream_sha}"

# Health check: does adopting upstream's tip introduce typecheck errors this
# project's copy of the branch didn't already have? These sibling branches
# are never meant to typecheck as one whole tree on their own (they carry
# every channel/provider's files at once; only the specific files a skill
# copies ever get built into main), so a bare `tsc --noEmit` always reports
# a nonzero baseline -- the meaningful signal is whether the pull grows that
# baseline, not whether it's zero.
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

count_errors() {
  local ref="$1" dir="$2"
  git worktree add --quiet --detach "$dir" "$ref" >/dev/null
  (cd "$dir" && pnpm install --frozen-lockfile --silent >/dev/null 2>&1)
  (cd "$dir" && pnpm exec tsc --noEmit 2>&1 | wc -l)
}

if [ -n "$origin_sha" ]; then
  before_errors="$(count_errors "refs/remotes/sibling-origin/${branch}" "${tmp_root}/before")"
else
  before_errors=0
fi
after_errors="$(count_errors "refs/remotes/sibling-upstream/${branch}" "${tmp_root}/after")"

git worktree remove --force "${tmp_root}/before" 2>/dev/null || true
git worktree remove --force "${tmp_root}/after" 2>/dev/null || true

echo "${branch}: typecheck error count before=${before_errors} after=${after_errors}"

if [ "$after_errors" -gt "$before_errors" ]; then
  echo "::warning title=Sibling branch pull adds typecheck errors (${branch})::Pulling nanocoai/nanoclaw's '${branch}' tip (${upstream_sha}) raises this project's whole-tree typecheck error count on that branch from ${before_errors} to ${after_errors} (both counts include the branch's normal cross-adapter baseline noise -- only the delta matters). Auto-sync skipped this push; run \`pnpm exec tsc --noEmit\` on the new tip locally to see what's new before fast-forwarding '${branch}' by hand."
  exit 0
fi

git push origin "refs/remotes/sibling-upstream/${branch}:refs/heads/${branch}"
echo "${branch}: pushed fast-forward to ${upstream_sha}"
