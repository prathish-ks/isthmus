// Package credential traces and reproduces NanoClaw's credential flow in Go
// (P5-05, Phase 5 — Security Kernel): "trace current credential flow first,
// then reproduce its security properties in Go without introducing new
// secret exposure."
//
// The trace (src/gateway-providers/onecli.ts, src/drivers/types.ts): the
// OneCLI gateway is the built-in provider that injects the credentials an
// agent container needs to talk to the model API through the proxy. Its
// contribute() calls the OneCLI SDK's applyContainerConfig, which emits raw
// Docker argv (`-e KEY=VALUE`, `-v host:container[:ro]`) — onecli.ts's own
// doc comment is explicit about why: "the CA certificate, credential stub
// FILES — stubs never ride env." contributionFromArgs (ported verbatim
// below as ContributionFromArgs) parses that argv into the TYPED
// GatewayContribution the spec composer merges in as ContributedEnv/Mounts,
// with every `-v` mount stamped class: 'allowlisted-extra' — the exact class
// package mount's P5-02 hardening (CheckAllowlistedExtra) can newly
// scrutinize.
//
// The security properties this package proves are PRESERVED, not changed
// (so per this task's own done-when, no ADR is needed for this file alone —
// see docs/ADR-006-p5-05-credential-isolation.md for the one genuine new
// finding this trace surfaced, which DOES warrant a record):
//
//  1. Credential VALUES never ride contributedEnv, even though its KEY-NAME
//     check is deliberately exempt (types.ts's own comment: a provider
//     registering a placeholder for the proxy to overwrite is legitimate;
//     see mount.ValidateSpec's ContributedEnv loop, which this package's
//     tests exercise directly against a real OneCLI-shaped contribution).
//  2. Real credential material rides by reference (a mounted file), never by
//     value — proven by composing ContributionFromArgs's mount output
//     through mount.ValidateSpec end to end.
//  3. The argv grammar is closed: onecli.ts's own comment — "Anything else
//     refuses the spawn: nothing gets to ride raw argv around the spec
//     again" — ContributionFromArgs fails closed on any flag shape it does
//     not recognize, ported and tested identically.
//
// The one thing this package does NOT do, flagged explicitly rather than
// silently assumed: verify egress-lockdown.ts's network-isolation guarantee
// (no exfiltration to non-internal destinations) that the credential these
// mounts unlock ultimately depends on. That file is pure Docker-CLI-shelling
// with no decision logic to port (see its own doc comment) and remains an
// open item from the Opus readiness review, not resolved by this task.
package credential

import (
	"fmt"
	"strings"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// GatewayContribution mirrors gateway-provider-registry.ts's
// GatewayContribution — the typed shape a provider's argv is parsed into.
type GatewayContribution struct {
	Env    map[string]string
	Mounts []mount.Spec
}

// ContributionFromArgs ports onecli.ts's contributionFromArgs (lines 29-58)
// verbatim: pairs of Docker CLI flags → typed env/mounts, fail-closed on any
// flag shape outside the closed `-e KEY=VALUE` / `-v host:container[:ro]`
// grammar the OneCLI SDK is known to emit.
func ContributionFromArgs(args []string, groupScope string) (GatewayContribution, error) {
	contribution := GatewayContribution{Env: map[string]string{}}
	for i := 0; i < len(args); i += 2 {
		flag := args[i]
		var value string
		if i+1 < len(args) {
			value = args[i+1]
		}
		if flag == "-e" && strings.Contains(value, "=") {
			eq := strings.Index(value, "=")
			contribution.Env[value[:eq]] = value[eq+1:]
			continue
		}
		if flag == "-v" && value != "" {
			parts := strings.Split(value, ":")
			if len(parts) >= 2 && len(parts) <= 3 && (len(parts) < 3 || parts[2] == "ro") {
				mode := mount.ModeRW
				if len(parts) == 3 && parts[2] == "ro" {
					mode = mount.ModeRO
				}
				contribution.Mounts = append(contribution.Mounts, mount.Spec{
					Class:         mount.ClassAllowlistedExtra,
					HostPath:      parts[0],
					ContainerPath: parts[1],
					Mode:          mode,
					GroupScope:    groupScope,
					// P6-04: stamped provider-origin, mirroring
					// nanocoai/nanoclaw#3680/fdde3b26's onecli.ts fix — this
					// mount was never operator-configured, so it must be
					// exempt from mount.CheckAllowlistedExtra once that check
					// is wired in production (see ADR-006 and the
					// TestFinding_* test this closes below).
					Origin: mount.OriginProvider,
				})
				continue
			}
		}
		return GatewayContribution{}, fmt.Errorf("OneCLI gateway emitted argv this seam cannot type: '%s %s'", flag, value)
	}
	return contribution, nil
}
