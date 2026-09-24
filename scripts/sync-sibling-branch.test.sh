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

# --- Test 2 -----------------------------------------------------------
# End-to-end, against real git repos -- no stubbed git, only a stubbed
# `pnpm`. Exercises main() itself, not just count_errors() in isolation,
# specifically to settle a second Copilot review comment claiming the
# `trap cleanup_tmp_root RETURN` in main() could fire between the two
# count_errors() calls (once when the first, nested count_errors()
# returns), deleting $tmp_root out from under the second call's
# `git worktree add`. That claim doesn't hold: bash does not inherit
# RETURN/DEBUG traps into called functions unless the function carries
# the trace attribute or `set -o functrace` is on (neither is true here),
# so a trap set in main() fires only when main() itself returns --
# verified by hand against bash 3.2 (this machine's /bin/bash) with a
# minimal repro before writing this test. But reasoning about trap
# semantics in the abstract is exactly the kind of claim this session has
# repeatedly found worth just running instead of trusting either way, so
# this test does the real thing: two upstream commits, a real
# `git fetch`/`git worktree add`/`git push` round trip through
# SYNC_SIBLING_UPSTREAM_URL and a real `origin` remote, and asserts both
# count_errors() calls actually completed (the log line reports both
# counts) and the real push landed.
test_main_end_to_end_real_git() {
  local work upstream_repo origin_repo checkout_repo stub_bin
  work="$(mktemp -d)"
  upstream_repo="$work/upstream"
  origin_repo="$work/origin.git"
  checkout_repo="$work/checkout"
  stub_bin="$(mktemp -d)"

  git init --quiet "$upstream_repo"
  git -C "$upstream_repo" config user.email test@example.com
  git -C "$upstream_repo" config user.name test
  echo "v1" > "$upstream_repo/f.txt"
  git -C "$upstream_repo" add f.txt
  git -C "$upstream_repo" commit --quiet -m v1
  git -C "$upstream_repo" branch -m channels

  git clone --quiet --bare "$upstream_repo" "$origin_repo"

  # Advance upstream by one commit after cloning origin from it, so
  # origin is genuinely behind -- the fast-forward main() should perform.
  echo "v2" >> "$upstream_repo/f.txt"
  git -C "$upstream_repo" commit --quiet -a -m v2

  git clone --quiet "$origin_repo" "$checkout_repo"

  # A stable (not growing) typecheck baseline on both sides, so main()
  # takes the push path rather than the skip-on-regression path -- this
  # test is about the trap/worktree-sharing claim, not the health check.
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

  local before_origin_sha upstream_tip output rc=0
  before_origin_sha="$(git -C "$origin_repo" rev-parse channels)"
  upstream_tip="$(git -C "$upstream_repo" rev-parse channels)"

  output="$(cd "$checkout_repo" && PATH="$stub_bin:$PATH" SYNC_SIBLING_UPSTREAM_URL="$upstream_repo" bash "$script_path" channels 2>&1)" || rc=$?

  local after_origin_sha
  after_origin_sha="$(git -C "$origin_repo" rev-parse channels)"

  rm -rf "$work" "$stub_bin"

  if [ "$rc" -ne 0 ]; then
    echo "FAIL test_main_end_to_end_real_git: main() exited $rc on a clean fast-forward with a stable typecheck baseline. Output:"
    echo "$output"
    return 1
  fi
  if [ "$before_origin_sha" = "$after_origin_sha" ]; then
    echo "FAIL test_main_end_to_end_real_git: origin's channels branch never moved -- main() didn't push. Output:"
    echo "$output"
    return 1
  fi
  if [ "$after_origin_sha" != "$upstream_tip" ]; then
    echo "FAIL test_main_end_to_end_real_git: origin's channels moved to $after_origin_sha, expected upstream's tip $upstream_tip. Output:"
    echo "$output"
    return 1
  fi
  if ! printf '%s\n' "$output" | grep -q "before=1 after=1"; then
    echo "FAIL test_main_end_to_end_real_git: expected both count_errors() calls to report the stable baseline (before=1 after=1) -- if \$tmp_root had been removed between them (the claimed bug), the second git worktree add would have failed with an error instead. Output:"
    echo "$output"
    return 1
  fi

  echo "PASS test_main_end_to_end_real_git"
}

test_count_errors_survives_nonzero_tsc || failures=$((failures + 1))
test_main_end_to_end_real_git || failures=$((failures + 1))

if [ "$failures" -ne 0 ]; then
  echo "FAILED: $failures test(s) failed"
  exit 1
fi
echo "All sync-sibling-branch.sh tests passed"
