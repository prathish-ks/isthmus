// Package hostinfo exists only to give P3-01 (create isolated Go module)
// something real to build, unit-test, and print from the CLI. It is a
// placeholder proving the module structure works — it is not part of the
// eventual Go host's actual design and will very likely be deleted once
// P3-02 onward starts adding real internal packages (config, mailbox,
// session, etc.) per docs/host-decomposition.md.
package hostinfo

// ModuleName identifies this experimental scaffold within the
// nanoclaw-go-lab workspace, distinct from the "nanoclaw" TypeScript host
// it sits alongside.
const ModuleName = "nanogo"

// Describe returns a short, human-readable identification string. It is
// deliberately trivial: P3-01's whole job is proving `go build`/`go test`
// work end to end for this module, not implementing anything real yet.
func Describe() string {
	return ModuleName + ": minimal Go host scaffold (P3-01)"
}
