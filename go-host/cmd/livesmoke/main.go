// Command livesmoke is a proof-harness-only tool for Phase 9's post-EC-02
// protocol-integration and live-smoke-test work (release-gate-checklist.md
// rows 5 and 11) — see scripts/ec06-live-smoke.sh, which builds and drives
// this binary. It is NOT part of the released nanogo CLI surface, is never
// wired into cmd/nanogo's own subcommand table, and is never installed by
// any release-packaging step: its only job is to speak internal/kernel's
// NDJSON wire protocol from outside the kernel process, exactly the way
// EC-02's TypeScript KernelClient (src/kernel/client.ts) does, so a shell
// harness can drive a real container.wake/container.kill through the real
// kernel socket instead of hand-rolling `docker create` itself — which is
// what the earlier P3-04/P3-06 proof harnesses had to do, before EC-02 put
// the kernel in the request path. Keeping this as a throwaway harness
// binary rather than adding "dial" subcommands to nanogo itself is
// deliberate: nanogo's real subcommands are operator tools meant to be
// shipped and run against a production kernel; a raw arbitrary-envelope
// injector is exactly the opposite of that, and has no business being part
// of the distributed binary's permanent surface.
//
// Usage: livesmoke -socket <path> < envelope.json
//
// Reads exactly one kernel.Envelope as JSON from stdin, sends it as one
// NDJSON line over a fresh connection to the given Unix socket, reads
// exactly one response line back, prints the raw response JSON to stdout,
// and exits 0 if the response's "ok" field is true, 1 if it is false
// (a well-formed denial/error response), or 2 on any usage or transport
// failure (bad flags, unreadable stdin, unparseable JSON, dial/write/read
// failure) — so a caller can tell "the kernel denied this" (1) apart from
// "this harness itself is broken" (2). This mirrors
// cmd/nanogo/serve_test.go's own TestServe_EndToEndRoundTripOverRealSocket
// dial/send/receive code exactly, generalized to an arbitrary
// caller-supplied envelope instead of one fixed status.trace request.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"

	"github.com/prathish-ks/isthmus/go-host/internal/kernel"
)

func main() {
	os.Exit(run())
}

func run() int {
	socketPath := flag.String("socket", "", "kernel Unix socket path (required)")
	flag.Parse()
	if *socketPath == "" {
		fmt.Fprintln(os.Stderr, "livesmoke: -socket is required")
		return 2
	}

	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: reading envelope JSON from stdin: %v\n", err)
		return 2
	}
	var env kernel.Envelope
	if err := json.Unmarshal(input, &env); err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: parsing envelope JSON from stdin: %v\n", err)
		return 2
	}

	conn, err := net.Dial("unix", *socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: dialing %s: %v\n", *socketPath, err)
		return 2
	}
	defer func() { _ = conn.Close() }()

	// Re-marshal (rather than forwarding the raw stdin bytes) so a caller's
	// pretty-printed/indented input still reaches the wire as the single
	// compact NDJSON line the server's line-oriented reader expects.
	line, err := json.Marshal(env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: re-marshaling envelope: %v\n", err)
		return 2
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: writing request: %v\n", err)
		return 2
	}

	scanner := bufio.NewScanner(conn)
	// A container.wake request's Session (and, on the way back, its
	// response) is small in practice, but bufio.Scanner's default 64KB
	// token limit is a silent-truncation trap for anything unexpectedly
	// larger (e.g. a Session carrying many mounts) — raised generously here
	// since this is a one-shot debug tool, not a hot path.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "livesmoke: reading response: %v\n", err)
		} else {
			fmt.Fprintln(os.Stderr, "livesmoke: connection closed with no response line")
		}
		return 2
	}

	fmt.Println(scanner.Text())

	var resp kernel.ResponseEnvelope
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		fmt.Fprintf(os.Stderr, "livesmoke: parsing response envelope: %v\n", err)
		return 2
	}
	if !resp.OK {
		return 1
	}
	return 0
}
