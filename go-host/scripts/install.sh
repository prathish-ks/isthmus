#!/usr/bin/env bash
#
# go-host/scripts/install.sh — minimum-trust installer for the `nanogo`
# security-kernel binary (Phase 11, P10-01; design rationale in
# go-host/docs/ADR-020-p10-01-minimum-trust-install.md).
#
# What this script does, in order:
#   1. Detects OS/arch.
#   2. Checks for Docker (installed AND reachable) — never installs it.
#      NanoClaw's own installer (nanoclaw.sh) already treats Docker as an
#      explicit, user-provided prerequisite; this script does the same.
#   3. Places a working `nanogo` binary at go-host/bin/nanogo:
#        a. If a local Go toolchain is present, builds from source
#           (go build -mod=vendor), and this is preferred — it needs no
#           network fetch and no checksum trust decision at all.
#        b. Otherwise, downloads the release binary matching this
#           OS/arch from the pinned GitHub release tag, verifies its
#           SHA256 against that release's published SHA256SUMS file, and
#           only then installs it.
#   4. On macOS, a downloaded (not locally built) binary carries the
#      com.apple.quarantine flag Gatekeeper attaches to anything fetched
#      over the network. Since step 3b already verified the file's
#      checksum against the project's own published release, this script
#      clears that flag itself (xattr -d, no sudo, ordinary user
#      permissions on a file it just placed) rather than leaving a
#      "cannot be opened because it is from an unidentified developer"
#      dialog as the user's problem to solve blind.
#
# What this script never does: it never uses sudo, never installs Docker,
# Go, or any other privileged software on the caller's behalf, and never
# writes outside go-host/bin (a build) or ~/.local/bin (a download) — see
# ADR-020's "prerequisite detection, not silent installation" design point.
#
# Usage: bash go-host/scripts/install.sh [--force-download] [--tag <tag>]
#   --force-download   skip the local Go toolchain even if one is found,
#                       and use the downloaded-release path instead (useful
#                       for testing the release artifacts themselves).
#   --tag <tag>         install a specific release tag instead of latest
#                       (e.g. nanogo-v0.1.0). Defaults to the latest
#                       nanogo-v* release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO_HOST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="prathish-ks/isthmus" # override with NANOCLAW_RELEASE_REPO for a fork
REPO="${NANOCLAW_RELEASE_REPO:-$REPO}"

FORCE_DOWNLOAD=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force-download) FORCE_DOWNLOAD=1 ;;
    --tag)
      shift
      TAG="${1:-}"
      ;;
    -h|--help)
      sed -n '2,33p' "$0"
      exit 0
      ;;
    *)
      echo "install.sh: unrecognized argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

info()  { echo "install.sh: $*"; }
warn()  { echo "install.sh: WARNING: $*" >&2; }
fail()  { echo "install.sh: ERROR: $*" >&2; exit 1; }

# ─── 1. OS/arch detection ───────────────────────────────────────────────
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "$UNAME_S" in
  Darwin) GOOS="darwin" ;;
  Linux)  GOOS="linux" ;;
  *) fail "unsupported OS: $UNAME_S (this project publishes darwin/linux binaries only)" ;;
esac
case "$UNAME_M" in
  x86_64|amd64) GOARCH="amd64" ;;
  arm64|aarch64) GOARCH="arm64" ;;
  *) fail "unsupported architecture: $UNAME_M (this project publishes amd64/arm64 binaries only)" ;;
esac
info "detected platform: ${GOOS}/${GOARCH}"

# ─── 2. Docker: detect, never install ───────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  warn "docker was not found on PATH. nanogo itself will build/run fine without it, but"
  warn "container.wake will fail until Docker is installed and running. Install Docker"
  warn "yourself (https://docs.docker.com/get-docker/) — this script will not do it for you."
elif ! docker info >/dev/null 2>&1; then
  warn "docker is installed but not reachable (is the daemon/Docker Desktop running?)."
  warn "container.wake will fail until it is. This script will not start it for you."
else
  info "docker is installed and reachable."
fi

# ─── 3. Place a working nanogo binary ───────────────────────────────────
mkdir -p "$GO_HOST_DIR/bin"
DEST="$GO_HOST_DIR/bin/nanogo"

build_from_source() {
  if ! command -v go >/dev/null 2>&1; then
    return 1
  fi
  info "found a local Go toolchain ($(go version)); building nanogo from source..."
  # Explicit if/then on the subshell's own exit status, deliberately not
  # relying on `set -e` to propagate a failure here: this function is
  # called as `... && build_from_source` in an `if` condition below, and
  # bash suspends errexit for an ENTIRE command tested by if/while/&&/|| —
  # including inside functions and subshells it calls into. A go-build
  # failure inside that context was silently swallowed in an earlier draft
  # of this script (it printed "built $DEST" and returned 0 with no binary
  # ever produced) — found by actually running this script against a real
  # broken build, not just shellcheck, before delivery. See
  # go-host/docs/ADR-020 for the general point this is an instance of.
  if (cd "$GO_HOST_DIR" && CGO_ENABLED=0 go build -mod=vendor -trimpath -o "$DEST" ./cmd/nanogo); then
    info "built $DEST"
    return 0
  fi
  warn "building nanogo from source failed (see the error above) — falling back to a downloaded release binary"
  return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    # macOS has no sha256sum by default; shasum -a 256 is the equivalent.
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_release() {
  command -v curl >/dev/null 2>&1 || fail "curl is required to download a release binary (or install a Go toolchain and re-run so this script can build from source instead)"

  local tag="$TAG"
  if [ -z "$tag" ]; then
    info "looking up the latest nanogo-v* release from github.com/${REPO}..."
    tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" \
      | grep -m1 '"tag_name": *"nanogo-v' \
      | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    [ -n "$tag" ] || fail "could not find any nanogo-v* release for ${REPO}. Pass --tag <tag> explicitly, or install a Go toolchain so this script can build from source."
  fi
  info "using release ${tag}"

  local asset="nanogo-${GOOS}-${GOARCH}"
  local base_url="https://github.com/${REPO}/releases/download/${tag}"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  info "downloading ${asset}..."
  curl -fsSL -o "$tmp_dir/$asset" "${base_url}/${asset}" \
    || fail "could not download ${base_url}/${asset} — check the tag and your network, or install a Go toolchain and re-run to build from source instead"

  info "downloading SHA256SUMS..."
  curl -fsSL -o "$tmp_dir/SHA256SUMS" "${base_url}/SHA256SUMS" \
    || fail "could not download the release's SHA256SUMS — refusing to install an unverifiable binary"

  local expected actual
  expected="$(grep " ${asset}\$" "$tmp_dir/SHA256SUMS" | awk '{print $1}')"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for ${asset} — refusing to install an unverifiable binary"
  actual="$(sha256_of "$tmp_dir/$asset")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual} — refusing to install. See go-host/docs/release-verification.md."
  info "checksum verified: ${actual}"

  mkdir -p "$(dirname "$DEST")"
  cp "$tmp_dir/$asset" "$DEST"
  chmod +x "$DEST"

  if [ "$GOOS" = "darwin" ]; then
    # See this file's header comment: the checksum check above is what
    # earns clearing this flag — never done for a file we have not just
    # verified ourselves.
    xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
    info "cleared macOS quarantine flag on the verified binary (see this script's header comment for why that's safe to do here)"
  fi
  info "installed verified ${asset} to $DEST"
}

INSTALLED=0
if [ "$FORCE_DOWNLOAD" -eq 0 ] && build_from_source; then
  INSTALLED=1
fi
if [ "$INSTALLED" -eq 0 ]; then
  download_release
  INSTALLED=1
fi

# ─── 4. Also link into ~/.local/bin (user-owned, no-sudo, matches the
#        kernel-supervisor module's own binary-search order) ────────────
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
if [ ! -e "$LOCAL_BIN/nanogo" ] || [ "$LOCAL_BIN/nanogo" -ef "$DEST" ]; then
  ln -sf "$DEST" "$LOCAL_BIN/nanogo"
  info "linked $LOCAL_BIN/nanogo -> $DEST"
else
  warn "$LOCAL_BIN/nanogo already exists and points elsewhere — leaving it alone. The TS host will still find the copy at $DEST directly."
fi

info "done. Verify with: $DEST doctor -config <path-to-a-config.json>"
case ":$PATH:" in
  *":$LOCAL_BIN:"*) ;;
  *) warn "$LOCAL_BIN is not on your PATH — add it (e.g. in ~/.zshrc or ~/.bashrc) if you want to run 'nanogo' directly from a shell." ;;
esac
