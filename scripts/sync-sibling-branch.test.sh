#!/usr/bin/env bash
# Regression test for sync-sibling-branch.sh's count_errors() helper.
#
# A GitHub Copilot PR review caught a real bug here: `pnpm exec tsc --noEmit
# | wc -l` with no `|| true`, under this script's own `set -euo pipefail`,
# meant `count_errors` aborted the whole script on tsc's ordinary non-zero
# exit -- which happens on every real run against the channels/providers
# branches (they always carry at least their normal cross-adapter baseline
# of errors; see that function's own comment). The warn-and-skip path this
# script exists to reach could never be exercised in practice. This test
# reproduces exactly that condition with a stub `tsc` that always exits
# non-zero, and asserts count_errors both survives it and reports the
# right count.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stub_bin="$(mktemp -d)"
worktree_dir="$(mktemp -u)"
cleanup() {
  git worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  rm -rf "$stub_bin"
}
trap cleanup EXIT

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

# shellcheck source=./sync-sibling-branch.sh
source "$script_dir/sync-sibling-branch.sh"

result="$(PATH="$stub_bin:$PATH" count_errors "HEAD" "$worktree_dir")"

if [ "$result" != "3" ]; then
  echo "FAIL: expected count_errors to report 3 (the stub tsc's error line count) despite tsc exiting non-zero, got '$result'"
  exit 1
fi

echo "PASS: count_errors survived tsc's non-zero exit under set -euo pipefail and counted correctly"
