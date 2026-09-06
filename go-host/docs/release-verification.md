# Verifying a downloaded `nanogo` release

P10-02 (Phase 11, Release Packaging). Every `nanogo-v*` tag pushed to this
repo triggers `.github/workflows/nanogo-release.yml`, which cross-compiles
`nanogo` for four platforms and publishes, alongside the binaries:

- **`SHA256SUMS`** — a checksum for every published file (the four
  platform binaries and the SBOM), so you can confirm a download is
  byte-for-byte what this repo's own CI produced.
- **`SHA256SUMS.sig`** and **`SHA256SUMS.pem`** — a
  [Sigstore/cosign](https://docs.sigstore.dev/) keyless signature over
  `SHA256SUMS` and the short-lived certificate that signature was made
  with. This is the step up from a checksum: a checksum proves a file
  matches what *some* SHA256SUMS says; the signature proves that
  `SHA256SUMS` itself was produced by *this repository's own release
  workflow*, not by anyone who could edit a webpage or a release's file
  list after the fact.
- **`nanogo-sbom.cdx.json`** — a [CycloneDX](https://cyclonedx.org/)
  software bill of materials for the Go module as built: every dependency
  and its exact pinned version (see `go-host/go.mod`), so a supply-chain
  scanner (or a person) can check what's actually in the binary without
  disassembling it.

## Why keyless signing, not a stored private key

This project has no private signing key sitting in a GitHub secret for
anyone to steal or for a compromised CI run to misuse. Instead, cosign's
keyless mode has the release workflow prove its own identity to Sigstore's
public Fulcio certificate authority via GitHub's own OIDC token for that
specific run, gets a certificate scoped to `prathish-ks/isthmus`'s
`.github/workflows/nanogo-release.yml` valid for a few minutes, signs with that,
and the certificate is published alongside the signature. Verifying later
means checking the signature was made with a certificate that really was
issued to *this repo's release workflow* — not trusting a key that could
have leaked or been rotated without anyone noticing.

## How to verify a download

1. Download the binary for your platform (e.g. `nanogo-darwin-arm64`) plus
   `SHA256SUMS`, `SHA256SUMS.sig`, and `SHA256SUMS.pem` from the same
   release.

2. **Checksum** — confirms the file is exactly what this release published:

   ```sh
   # macOS
   shasum -a 256 -c <(grep nanogo-darwin-arm64 SHA256SUMS)
   # Linux
   sha256sum -c <(grep nanogo-linux-amd64 SHA256SUMS)
   ```

   A `nanogo-darwin-arm64: OK` (or equivalent) line means the file matches.

3. **Signature** (recommended, optional) — confirms `SHA256SUMS` itself was
   produced by this repo's own release workflow, not substituted afterward:

   ```sh
   cosign verify-blob \
     --certificate SHA256SUMS.pem \
     --signature SHA256SUMS.sig \
     --certificate-identity "https://github.com/prathish-ks/isthmus/.github/workflows/nanogo-release.yml@refs/tags/<the tag you downloaded>" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
     SHA256SUMS
   ```

   (Install cosign first: `brew install cosign` on macOS, or see
   [sigstore/cosign releases](https://github.com/sigstore/cosign/releases)
   for Linux.) A `Verified OK` means step 2's checksum file is trustworthy
   in the first place — do step 2 either way, since it's what actually
   binds the specific binary you downloaded to that trusted checksum list.

4. **macOS Gatekeeper**: a binary downloaded this way (rather than built
   locally by `go-host/scripts/install.sh`'s Go-toolchain path) carries a
   quarantine flag and macOS will refuse to run it with "cannot be opened
   because it is from an unidentified developer." This project does not
   have a paid Apple Developer account to notarize releases with (see
   ADR-020's known-limitations section). If you downloaded and verified the
   binary through `install.sh`, it already cleared this flag for you after
   checking the SHA256SUMS match — see that script's own header comment
   for why that's a reasonable thing for it to do automatically. If you
   downloaded a binary by hand instead, clear it the same way yourself
   *only after completing step 2 above*:

   ```sh
   xattr -d com.apple.quarantine ./nanogo-darwin-arm64
   ```

   Never run this against a binary you have not checksum-verified.

## What this does and does not prove

Checksum + signature together prove: "this exact file is what
`prathish-ks/isthmus`'s own `nanogo-release.yml` workflow produced for
this tag, unmodified since." They do **not** prove the source code itself
is free of bugs or vulnerabilities — that is what `go-host/docs/
compatibility-security-report.md`'s test results and known-limitations
section are for, and what the published SBOM lets a separate vulnerability
scanner check independently.
