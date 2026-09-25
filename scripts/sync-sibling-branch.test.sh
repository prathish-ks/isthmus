#!/usr/bin/env bash
# Regression tests for scripts/sync-sibling-branch.sh.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="$script_dir/sync-sibling-branch.sh"
failures=0

# shellcheck source=./sync-sibling-branch.sh
source "$script_path"

# --- Test 1 -----------------------------------------------------------
# A GitHub Copilot PR review caught a real bug here: `pnpm exec tsc
# --noEmit | wc -l` with no `|| true`, under this script's own
# `set -euo pipefail`, meant count_errors() aborted the whole script on
# tsc's ordinary non-zero exit -- which happens on every real run against
# the channels/providers branches (they always carry at least their
# normal cross-adapter baseline of errors; see that function's own
# comment). The warn-and-skip path this script exists to reach could
# never be exercised in practice. This reproduces exactly that condition
# with a stub `tsc` that always exits non-zero, and asserts count_errors
# both survives it and reports the right count.
test_count_errors_survives_nonzero_tsc() {
  local stub_bin worktree_dir result
  stub_bin="$(mktemp -d)"
  worktree_dir="$(mktemp -u)"

  cat > "$stub_bin/pnpm" << 'STUB'
#!/usr/bin/env bash
if [ "$1" = "install" ]; then
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "tsc" ]; then
  echo "src/fake/one.ts(1,1): error TS0000: fake typecheck error"
  echo "src/fake/two.ts(2,2): error TS0000: fake typecheck error"
  echo "src/fake/three.ts(3,3): error TS0000: fake typecheck error"
  exit 1
fi
echo "unexpected stub pnpm invocation: $*" >&2
exit 1
STUB
  chmod +x "$stub_bin/pnpm"

  result="$(PATH="$stub_bin:$PATH" count_errors "HEAD" "$worktree_dir")"

  git worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  rm -rf "$stub_bin"

  if [ "$result" != "3" ]; then
    echo "FAIL test_count_errors_survives_nonzero_tsc: expected 3, got '$result'"
    return 1
  fi
  echo "PASS test_count_errors_survives_nonzero_tsc"
}

# --- Fixture shared by tests 2 and 3 -----------------------------------
# A real local "upstream" repo, a real bare "origin" repo one commit
# behind it, and a real clone of origin with `origin` configured as its
# remote -- so check_branch()/push_branch() exercise real git fetch/push,
# not stubs. Only `pnpm` is stubbed (no real install/typecheck needed to
# prove these code paths).
make_fixture() {
  local work="$1"
  local upstream_repo="$work/upstream" origin_repo="$work/origin.git" checkout_repo="$work/checkout"

  git init --quiet "$upstream_repo"
  git -C "$upstream_repo" config user.email test@example.com
  git -C "$upstream_repo" config user.name test
  echo "v1" > "$upstream_repo/f.txt"
  git -C "$upstream_repo" add f.txt
  git -C "$upstream_repo" commit --quiet -m v1
  git -C "$upstream_repo" branch -m channels

  git clone --quiet --bare "$upstream_repo" "$origin_repo"

  # Advance upstream by one commit after cloning origin from it, so
  # origin is genuinely behind -- the fast-forward these functions should
  # detect and act on.
  echo "v2" >> "$upstream_repo/f.txt"
  git -C "$upstream_repo" commit --quiet -a -m v2

  git clone --quiet "$origin_repo" "$checkout_repo"
}

make_stub_pnpm() {
  local stub_bin="$1"
  # A stable (not growing) typecheck baseline on both sides, so
  # check_branch() reports should_push=true rather than skipping on a
  # (nonexistent) regression -- these tests are about the job-split and
  # trap/worktree-sharing behavior, not the health-check math (that's
  # test_count_errors_survives_nonzero_tsc's job, above).
  cat > "$stub_bin/pnpm" << 'STUB'
#!/usr/bin/env bash
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "exec" ] && [ "$2" = "tsc" ]; then
  echo "same/baseline.ts(1,1): error TS0000: baseline"
  exit 1
fi
echo "unexpected stub pnpm invocation: $*" >&2
exit 1
STUB
  chmod +x "$stub_bin/pnpm"
}

# --- Test 2 -----------------------------------------------------------
# check_branch() end-to-end against real git repos. Exercises the same
# code a second Copilot review's RETURN-trap claim was about (that
# `trap cleanup_tmp_root RETURN` could fire between the two count_errors()
# calls, deleting $tmp_root before the second call's `git worktree add`
# runs) -- that claim doesn't hold, verified separately by hand (bash
# does not inherit RETURN/DEBUG traps into called functions without
# `set -o functrace`, and even forcing that on this script directly and
# rerunning this suite still passed, because `git worktree add`
# auto-creates a missing parent directory regardless). This test is the
# stronger, structural version of that proof: it doesn't reason about
# trap semantics at all, it just asserts check_branch() actually reaches
# should_push=true with the right target_sha, which requires both
# count_errors() calls to have completed.
#
# Also verifies check_branch() never pushes anything itself (the whole
# point of the job split a third Copilot review asked for) -- origin's
# ref must be untouched after this call.
test_check_branch_end_to_end_real_git() {
  local work stub_bin
  work="$(mktemp -d)"
  stub_bin="$(mktemp -d)"
  make_fixture "$work"
  make_stub_pnpm "$stub_bin"

  local origin_repo="$work/origin.git" checkout_repo="$work/checkout" upstream_repo="$work/upstream"
  local before_origin_sha upstream_tip output rc=0
  before_origin_sha="$(git -C "$origin_repo" rev-parse channels)"
  upstream_tip="$(git -C "$upstream_repo" rev-parse channels)"

  output="$(cd "$checkout_repo" && PATH="$stub_bin:$PATH" SYNC_SIBLING_UPSTREAM_URL="$upstream_repo" bash "$script_path" check channels 2>&1)" || rc=$?

  local after_origin_sha
  after_origin_sha="$(git -C "$origin_repo" rev-parse channels)"

  rm -rf "$work" "$stub_bin"

  if [ "$rc" -ne 0 ]; then
    echo "FAIL test_check_branch_end_to_end_real_git: exited $rc. Output:"
    echo "$output"
    return 1
  fi
  if [ "$before_origin_sha" != "$after_origin_sha" ]; then
    echo "FAIL test_check_branch_end_to_end_real_git: origin's channels branch moved -- check_branch() must never push. Output:"
    echo "$output"
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -q "before=1 after=1"; then
    echo "FAIL test_check_branch_end_to_end_real_git: expected both count_errors() calls to report the stable baseline (before=1 after=1) -- if \$tmp_root had been removed between them, the second git worktree add would have failed with an error instead. Output:"
    echo "$output"
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -q "^should_push=true$"; then
    echo "FAIL test_check_branch_end_to_end_real_git: expected should_push=true. Output:"
    echo "$output"
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -q "^target_sha=${upstream_tip}$"; then
    echo "FAIL test_check_branch_end_to_end_real_git: expected target_sha=${upstream_tip}. Output:"
    echo "$output"
    return 1
  fi
  echo "PASS test_check_branch_end_to_end_real_git"
}

# --- Test 3 -----------------------------------------------------------
# push_branch() end-to-end: confirms it actually pushes when the expected
# SHA matches, and -- the fail-closed behavior the job split depends on
# for correctness, not just for security -- refuses to push (with a
# warning, not an error) when the expected SHA doesn't match upstream's
# current tip, simulating upstream having moved between a check job and a
# push job. Runs no `pnpm`/`tsc` at all: push_branch() only ever calls
# git, which is the entire point of splitting it into its own job that
# never executes fetched code.
test_push_branch_end_to_end_real_git() {
  local work
  work="$(mktemp -d)"
  make_fixture "$work"
  local origin_repo="$work/origin.git" checkout_repo="$work/checkout" upstream_repo="$work/upstream"
  local upstream_tip
  upstream_tip="$(git -C "$upstream_repo" rev-parse channels)"

  # 3a: correct expected SHA -> pushes.
  local output rc=0
  output="$(cd "$checkout_repo" && SYNC_SIBLING_UPSTREAM_URL="$upstream_repo" bash "$script_path" push channels "$upstream_tip" 2>&1)" || rc=$?
  local origin_after_good_push
  origin_after_good_push="$(git -C "$origin_repo" rev-parse channels)"

  if [ "$rc" -ne 0 ] || [ "$origin_after_good_push" != "$upstream_tip" ]; then
    echo "FAIL test_push_branch_end_to_end_real_git: push with the correct expected SHA did not land (rc=$rc, origin now at $origin_after_good_push, expected $upstream_tip). Output:"
    echo "$output"
    rm -rf "$work"
    return 1
  fi

  # 3b: stale expected SHA (simulating upstream having moved since a
  # separate check job ran) -> must refuse to push, not error out.
  echo "v3" >> "$upstream_repo/f.txt"
  git -C "$upstream_repo" commit --quiet -a -m v3
  local new_upstream_tip
  new_upstream_tip="$(git -C "$upstream_repo" rev-parse channels)"

  local output2 rc2=0
  output2="$(cd "$checkout_repo" && SYNC_SIBLING_UPSTREAM_URL="$upstream_repo" bash "$script_path" push channels "$upstream_tip" 2>&1)" || rc2=$?
  local origin_after_stale_push
  origin_after_stale_push="$(git -C "$origin_repo" rev-parse channels)"

  rm -rf "$work"

  if [ "$rc2" -ne 0 ]; then
    echo "FAIL test_push_branch_end_to_end_real_git: a stale expected-sha push should exit 0 (skip with a warning, not error). Output:"
    echo "$output2"
    return 1
  fi
  if [ "$origin_after_stale_push" != "$upstream_tip" ]; then
    echo "FAIL test_push_branch_end_to_end_real_git: origin moved past the last verified SHA on a stale push attempt -- expected it to stay at $upstream_tip (the last thing actually checked), got $origin_after_stale_push. Output:"
    echo "$output2"
    return 1
  fi
  if ! printf '%s\n' "$output2" | grep -q "::warning"; then
    echo "FAIL test_push_branch_end_to_end_real_git: expected a ::warning:: annotation when refusing a stale push. Output:"
    echo "$output2"
    return 1
  fi

  echo "PASS test_push_branch_end_to_end_real_git"
}

test_count_errors_survives_nonzero_tsc || failures=$((failures + 1))
test_check_branch_end_to_end_real_git || failures=$((failures + 1))
test_push_branch_end_to_end_real_git || failures=$((failures + 1))

if [ "$failures" -ne 0 ]; then
  echo "FAILED: $failures test(s) failed"
  exit 1
fi
echo "All sync-sibling-branch.sh tests passed"
