#!/usr/bin/env python3
"""
Pins the egress helper image (internal/egress's helperImage) by digest
instead of a floating tag, fixes the now-stale egress row in
go-host/docs/compatibility-matrix.md, adds an egress-image-watch CI job so
this pin can't silently go stale, and documents the detect/review/decide/
promote maintenance policy in go-host/docs/version-compatibility.md and
docs/ADR-013-p8-05-egress-network-controls.md.

This needs a REAL digest for alpine:3.20, which this script fetches itself
by shelling out to `docker` on THIS machine (requires Docker installed and
a real internet connection to Docker Hub -- exactly what the original
TODO in egress.go could not assume when it was first written in a
network-restricted sandbox).

Applied by content-anchor, not a line-numbered patch, the same approach as
the last two rounds -- immune to line-number drift against your actual
pushed branch. Safe to run twice: each replacement is independently
idempotent.

Run from the repo root (isthmus/):

    python3 apply_egress_image_pin.py
"""
import json
import re
import subprocess
import sys
from datetime import date

REPLACEMENTS = json.loads('[\n  {\n    "file": "go-host/internal/egress/egress.go",\n    "old": "\\n// helperImage is a small, official base image used only to run `iptables`\\n// inside the Docker daemon\'s own network namespace (see the package doc\\n// comment). Pinned to a specific release, not `latest`.\\n//\\n",\n    "new": "\\n// helperImage is a small, official base image used only to run `iptables`/\\n// `nft` inside the Docker daemon\'s own network namespace (see the package\\n// doc comment) — the single most privileged container this project runs\\n// (--network host, plus --cap-add NET_ADMIN on Ensure\'s and Check\'s\\n// invocations both — see Check\'s own doc comment for why the read path\\n// needs it too). Pinned by digest, not just a floating tag: a tag can be\\n// repointed at different bytes at any time without this project\'s own code\\n// or CI changing at all, and this is exactly the container where that\\n// would matter most. The trailing comment records which tag this digest\\n// corresponded to at pin time, for humans; Docker itself only ever\\n// resolves the digest.\\n//\\n",\n    "label": "egress.go#0",\n    "marker": "This resolves a TODO left open when the mechanism was first written"\n  },\n  {\n    "file": "go-host/internal/egress/egress.go",\n    "old": "//\\n// TODO(security): pin by digest, not just tag, once run somewhere with\\n// registry access — this was written in a sandboxed environment whose\\n// egress policy blocks the Docker Hub registry API, so a verified digest\\n// could not be looked up while authoring this.\\nconst helperImage = \\"alpine:3.20\\"\\n\\n",\n    "new": "//\\n// This resolves a TODO left open when the mechanism was first written in a\\n// sandboxed environment whose egress policy blocks the Docker Hub registry\\n// API — no verified digest could be looked up at the time. Verified\\n// PIN_DATE against Docker Hub\'s real manifest for alpine:3.20, from a\\n// machine with real registry access.\\n//\\n// This pin does not update itself, and going unnoticed is exactly the\\n// failure mode it\'s meant to avoid — see\\n// go-host/docs/version-compatibility.md §5 for the detect/review/decide/\\n// promote policy that keeps it current, and .github/workflows/ci.yml\'s\\n// egress-image-watch job for the automated \\"detect\\" half.\\nconst helperImage = \\"alpine:3.20@PIN_DIGEST\\" // alpine:3.20\\n\\n",\n    "label": "egress.go#1",\n    "marker": "const helperImage = \\"alpine:3.20@"\n  },\n  {\n    "file": "go-host/docs/compatibility-matrix.md",\n    "old": "| Capability scoping (`internal/capability`) / scoped credential brokering (`internal/credentialbroker`) | **Preview / Pending** | Prototyped and unit-tested in isolation (P8-02/P8-04), NOT adopted into any live request path — ADR-014\'s own v1.1-candidate framing. `credentialbroker`\'s expiry semantics now have direct `Validate`-path coverage too (P9-04), on top of the existing `Resolve`-path test. |\\n| Egress/network controls | **Preview / Pending** | Evaluation only (P8-05, ADR-013) — no enforcement code shipped. |\\n\\n",\n    "new": "| Capability scoping (`internal/capability`) / scoped credential brokering (`internal/credentialbroker`) | **Preview / Pending** | Prototyped and unit-tested in isolation (P8-02/P8-04), NOT adopted into any live request path — ADR-014\'s own v1.1-candidate framing. `credentialbroker`\'s expiry semantics now have direct `Validate`-path coverage too (P9-04), on top of the existing `Resolve`-path test. |\\n| Egress/network controls | **Stable (Linux)** | Real enforcement shipped, not evaluation-only (P8-05, ADR-013): `internal/egress` installs and independently verifies a `DOCKER-USER` iptables rule blocking `169.254.0.0/16` (cloud-metadata/link-local) on every container — called from `nanogo serve` startup by default, checkable via `nanogo doctor`. Covered by `egress_test.go`\'s fakeRunner suite and `live_docker_test.go`\'s real-Docker tests (`NANOCLAW_EGRESS_LIVE_DOCKER=1`, run in CI). Linux only by design: Docker Desktop for Mac\'s `--network host` is a proxy/forwarding emulation, not real namespace sharing, so `Ensure`/`Check` report a disclosed `LevelWarn` gap rather than a false pass on any other `GOOS` — see ADR-013\'s \\"Scope: Linux only\\" section. The platform qualifier is part of the rating, not a footnote. |\\n\\n",\n    "label": "compatibility-matrix.md#0"\n  },\n  {\n    "file": "go-host/docs/version-compatibility.md",\n    "old": "  anything Go-side.\\n",\n    "new": "  anything Go-side.\\n\\n## 5. Egress helper base-image pin\\n\\nA second, unrelated pin lives in this codebase and follows the same\\ndetect/review/decide/promote shape as §3, applied to a different kind of\\ndependency: `internal/egress`\'s `helperImage` const (`egress.go`) pins the\\none Docker image this project runs with real host-level privilege\\n(`--network host`, `--cap-add NET_ADMIN`) by exact digest, not a floating\\ntag — see that const\'s own doc comment for why a privileged helper\\ncontainer is exactly the wrong place to trust \\"whatever a tag currently\\nresolves to.\\"\\n\\nPinning by digest trades away something real, and this section exists so\\nthat trade doesn\'t go unnoticed: a floating tag gets the upstream image\'s\\nroutine security patches for free every time Alpine rebuilds it; a pinned\\ndigest gets none of that until someone deliberately re-pins. Silently\\ngoing stale is the specific failure this policy exists to prevent — an\\nold, unpatched base image is worse than the drift a floating tag would\\nhave introduced, if nobody is ever prompted to look again.\\n\\n1. **Detect.** `.github/workflows/ci.yml`\'s `egress-image-watch` job\\n   (weekly + on-demand, report-only — mirrors `upstream-watch`\'s own\\n   cadence and non-blocking posture from §3) pulls the live `alpine:3.20`\\n   tag and compares its current manifest digest against the one pinned in\\n   `egress.go`. A mismatch does not mean the pinned image is broken or\\n   insecure — only that a newer build of the same tag now exists.\\n2. **Review.** On a mismatch, check Alpine\'s own release notes/security\\n   advisories for what changed between the pinned digest and the new one\\n   before assuming an update is warranted — same discipline as §3\'s\\n   review step, scaled to a much smaller surface (one base image, not a\\n   whole upstream project).\\n3. **Decide.** If the new build fixes something worth having (a real CVE,\\n   a meaningful base-package update) or enough time has simply passed that\\n   staying current is the safer default: re-pin. If not: leave the pin as\\n   is and note why in the commit that acknowledges the watch job\'s\\n   finding, so the next person (or the next scheduled run) isn\'t left\\n   wondering whether the drift was ever actually looked at.\\n4. **Promote.** Update `egress.go`\'s `helperImage` const (new digest, new\\n   verification date in its doc comment) in its own small, reviewable\\n   commit — never bundled silently into an unrelated change, so `git log`\\n   on that one line stays a legible history of when and why the pin moved.\\n\\n**Tied to the release cadence, not just the weekly schedule**: before\\ncutting a `nanogo` release (`.github/workflows/nanogo-release.yml`),\\nmanually trigger `egress-image-watch` via `workflow_dispatch` (or check its\\nmost recent scheduled run) and resolve any flagged drift first, rather than\\nrelying solely on the next Monday\'s cron to catch it. A release is a\\nnatural, memorable checkpoint for this kind of maintenance that has no\\nother forcing function — the whole reason this policy exists is that\\nnothing else would ever prompt someone to look.\\n",\n    "label": "version-compatibility.md#0"\n  },\n  {\n    "file": "docs/ADR-013-p8-05-egress-network-controls.md",\n    "old": "\\n**Scope: Linux only, disclosed gap on macOS.** The mechanism above depends on the helper container sharing the host\'s real network namespace (`--network host`) so the `iptables` rule it inserts lands in the *host\'s* `DOCKER-USER` chain, not a namespace-local one. On native Linux that is exactly what `--network host` does. On Docker Desktop for Mac, it is not: per [Docker\'s own community forum](https://forums.docker.com/t/mac-host-network-driver-beta-feature/141989), the beta `--network host` support there is implemented via \\"proxies/forwarding rules,\\" not real namespace sharing — so the same helper-container invocation would silently insert a rule nowhere that matters, producing a false sense of security rather than a real block. Rather than ship a mechanism that looks identical but only works on one platform, `internal/egress.Ensure`/`Check` no-op/report a disclosed `LevelWarn` gap (never a false `LevelPass`) on any non-Linux `GOOS`, named explicitly in both the CLI warning text and the `doctor` output. This mirrors this project\'s existing precedent for native Windows never being a supported host (POSIX-only mount paths, see `.github/workflows/ci.yml`\'s `go-host-os-matrix` job comment) — a limitation stated plainly rather than implied away, with a path to close it (native Linux hosts, or a Linux VM/WSL2, get the real protection today; a Windows-container or Mac-native mechanism is future work, not silently assumed).\\n",\n    "new": "\\n**Helper image pinned by digest, not tag.** The helper container above (`alpine:3.20`, run with `--network host` and, for `Ensure`, `--cap-add NET_ADMIN`) is the single most privileged container this project runs, and it was initially referenced by a floating tag with an open `TODO(security)` in `egress.go` to pin it by digest instead — left open because the mechanism was first written in a sandboxed environment whose egress policy blocks the Docker Hub registry API, so no verified digest could be looked up at the time. Resolved once run somewhere with real registry access: `helperImage` now pins an exact manifest digest, with the tag it corresponded to kept as a trailing comment for humans. This trades away something real (a floating tag gets Alpine\'s routine security patches for free on every rebuild; a pinned digest gets none until someone deliberately re-pins) for something more important on a privileged container: every install running exactly the reviewed bits, not whatever the tag currently resolves to. `go-host/docs/version-compatibility.md` §5 records the detect/review/decide/promote policy that keeps this pin from silently going stale, and `.github/workflows/ci.yml`\'s `egress-image-watch` job is its automated \\"detect\\" half, run weekly and checked manually before cutting a release.\\n\\n**Scope: Linux only, disclosed gap on macOS.** The mechanism above depends on the helper container sharing the host\'s real network namespace (`--network host`) so the `iptables` rule it inserts lands in the *host\'s* `DOCKER-USER` chain, not a namespace-local one. On native Linux that is exactly what `--network host` does. On Docker Desktop for Mac, it is not: per [Docker\'s own community forum](https://forums.docker.com/t/mac-host-network-driver-beta-feature/141989), the beta `--network host` support there is implemented via \\"proxies/forwarding rules,\\" not real namespace sharing — so the same helper-container invocation would silently insert a rule nowhere that matters, producing a false sense of security rather than a real block. Rather than ship a mechanism that looks identical but only works on one platform, `internal/egress.Ensure`/`Check` no-op/report a disclosed `LevelWarn` gap (never a false `LevelPass`) on any non-Linux `GOOS`, named explicitly in both the CLI warning text and the `doctor` output. This mirrors this project\'s existing precedent for native Windows never being a supported host (POSIX-only mount paths, see `.github/workflows/ci.yml`\'s `go-host-os-matrix` job comment) — a limitation stated plainly rather than implied away, with a path to close it (native Linux hosts, or a Linux VM/WSL2, get the real protection today; a Windows-container or Mac-native mechanism is future work, not silently assumed).\\n",\n    "label": "ADR-013.md#0"\n  },\n  {\n    "file": ".github/workflows/ci.yml",\n    "old": "            echo \\"::warning title=Upstream release drift::nanocoai/nanoclaw has released $latest_tag, but this project\'s pin (docs/upstream-pin.json, docs/baseline.md) is still $pinned_tag. Run the upstream-compatibility review in go-host/docs/version-compatibility.md before relying on parity fixtures or ADR-cited upstream line numbers against the new release.\\"\\n          else\\n            echo \\"Up to date with the pinned baseline\'s tag — no review needed on tag alone. (This does not check unreleased commits on upstream main; see docs/baseline.md\'s own \'Upstream watch\' section for that slower-moving, human-run check.)\\"\\n          fi\\n",\n    "new": "            echo \\"::warning title=Upstream release drift::nanocoai/nanoclaw has released $latest_tag, but this project\'s pin (docs/upstream-pin.json, docs/baseline.md) is still $pinned_tag. Run the upstream-compatibility review in go-host/docs/version-compatibility.md before relying on parity fixtures or ADR-cited upstream line numbers against the new release.\\"\\n          else\\n            echo \\"Up to date with the pinned baseline\'s tag — no review needed on tag alone. (This does not check unreleased commits on upstream main; see docs/baseline.md\'s own \'Upstream watch\' section for that slower-moving, human-run check.)\\"\\n          fi\\n\\n  # egress-image-watch (maintenance follow-up to ADR-013\'s digest pin,\\n  # go-host/docs/version-compatibility.md §5): the DOCKER-USER helper\\n  # container (internal/egress\'s helperImage) is pinned by exact manifest\\n  # digest, not a floating tag — deliberately, so every install runs\\n  # exactly the reviewed bits on this project\'s single most privileged\\n  # container. The trade-off that discipline accepts is that a pinned\\n  # digest does NOT receive Alpine\'s routine security patches automatically\\n  # the way a floating tag would. This job is the automated \\"detect\\" half\\n  # of the policy that keeps that pin from silently going stale: same\\n  # cadence and posture as upstream-watch above (weekly + on-demand,\\n  # report-only, continue-on-error: true) — a mismatch here is not a\\n  # failure of this project, it\'s a prompt for a human to run\\n  # version-compatibility.md §5\'s review/decide/promote steps. Also meant\\n  # to be triggered manually (workflow_dispatch) before cutting a nanogo\\n  # release, per that same section, since a release is otherwise the one\\n  # natural checkpoint nothing else would prompt someone to use.\\n  egress-image-watch:\\n    if: github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\'\\n    runs-on: ubuntu-latest\\n    continue-on-error: true\\n    steps:\\n      - uses: actions/checkout@v4\\n      - name: Compare the live alpine:3.20 digest against the pinned helper-image digest\\n        run: |\\n          set -euo pipefail\\n          pinned_digest=\\"$(grep -oE \'sha256:[0-9a-f]{64}\' go-host/internal/egress/egress.go | head -1)\\"\\n          if [ -z \\"$pinned_digest\\" ]; then\\n            echo \\"::error title=No pinned digest found::Could not find a sha256:... digest in go-host/internal/egress/egress.go\'s helperImage const. This job\'s own grep pattern may be out of sync with that file.\\"\\n            exit 1\\n          fi\\n\\n          docker pull alpine:3.20 >/dev/null\\n          live_digest=\\"$(docker inspect --format=\'{{range .RepoDigests}}{{.}}{{\\"\\\\n\\"}}{{end}}\' alpine:3.20 \\\\\\n            | grep -oE \'sha256:[0-9a-f]{64}\' | head -1)\\"\\n\\n          echo \\"Pinned digest (egress.go):      $pinned_digest\\"\\n          echo \\"Live alpine:3.20 digest (Hub):  $live_digest\\"\\n\\n          if [ \\"$live_digest\\" != \\"$pinned_digest\\" ]; then\\n            echo \\"::warning title=Egress helper image drift::alpine:3.20 on Docker Hub now resolves to $live_digest, but internal/egress/egress.go still pins $pinned_digest. This is not necessarily urgent (a pin intentionally does not auto-update) — run the review/decide/promote steps in go-host/docs/version-compatibility.md §5 before re-pinning.\\"\\n          else\\n            echo \\"Up to date — the pinned digest still matches the live alpine:3.20 tag.\\"\\n          fi\\n",\n    "label": "ci.yml#0"\n  }\n]')

DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}")


def fetch_live_alpine_digest():
    print("Pulling alpine:3.20 and reading its manifest digest from Docker Hub...")
    try:
        subprocess.run(["docker", "pull", "alpine:3.20"], check=True)
        out = subprocess.run(
            ["docker", "inspect",
             "--format={{range .RepoDigests}}{{.}}{{\"\\n\"}}{{end}}",
             "alpine:3.20"],
            check=True, capture_output=True, text=True,
        ).stdout
    except FileNotFoundError:
        sys.exit("[FAIL] `docker` was not found on PATH. Nothing was changed. "
                  "Install/start Docker and re-run this script.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"[FAIL] docker pull/inspect failed: {e}. Nothing was changed. "
                  f"Make sure Docker is running and you have internet access to Docker Hub.")

    matches = DIGEST_RE.findall(out)
    if not matches:
        sys.exit(f"[FAIL] Could not find a sha256:... digest in `docker inspect`'s "
                  f"RepoDigests output for alpine:3.20. Nothing was changed. "
                  f"Raw output was:\n{out}")
    digest = matches[0]
    print(f"Live alpine:3.20 digest: {digest}")
    return digest


def apply_one(r):
    path = r["file"]
    old = r["old"]
    new = r["new"]
    label = r["label"]
    marker = r.get("marker", new)
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        sys.exit(f"[FAIL] {label}: {path} not found. Nothing further was changed. "
                  f"Make sure you're running this from the repo root.")

    if marker in text:
        print(f"[skip] {label}: already applied")
        return
    if old not in text:
        sys.exit(f"[FAIL] {label}: expected anchor text not found in {path}. "
                  f"Nothing in this file was changed by this run. Paste this "
                  f"message back (with the label) so the fix can be adjusted.")
    text = text.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"[ok]   {label}: applied to {path}")


def fill_in_pin(digest):
    path = "go-host/internal/egress/egress.go"
    with open(path, encoding="utf-8") as f:
        text = f.read()
    changed = False
    if "PIN_DIGEST" in text:
        text = text.replace("PIN_DIGEST", digest)
        changed = True
    if "PIN_DATE" in text:
        text = text.replace("PIN_DATE", date.today().isoformat())
        changed = True
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[ok]   filled in real digest/date in {path}")
    else:
        print(f"[skip] {path}: digest/date already filled in")


if __name__ == "__main__":
    digest = fetch_live_alpine_digest()
    for r in REPLACEMENTS:
        apply_one(r)
    fill_in_pin(digest)
    print("Done. Now run: git diff --stat")
