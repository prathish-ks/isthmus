package kernel

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// defaultStopGraceSeconds mirrors DockerHandle.stop's own fallback
// (docker-driver.ts:527: `String(this.pendingSpec?.stopGraceSeconds ?? 1)`).
const defaultStopGraceSeconds = 1

// Executor is the ONLY interface in this package through which a `docker`
// (or future driver) process is ever invoked. Every method takes narrow,
// already-validated arguments — not a request struct, not a raw argv slice
// from the caller — precisely so that satisfying this interface can never
// become a way to smuggle an unvalidated field through to a shell. capability.go
// is the only caller.
type Executor interface {
	// Wake constructs and runs the exact argv this method decides on (no
	// caller-supplied flags) from a spec that has already passed
	// mount.ValidateSpec, and returns the resulting container id AND the
	// name the kernel derived and created it under (EC-02, Phase 9) — the
	// caller never supplies or trusts a name; it uses whatever this method
	// actually created. auxiliaryNames and privateNetwork (v2.4.0
	// promotion, Workstream A3) are non-empty only for a multi-container
	// (gateway) session — the caller must record them (lifecycle.Runtime)
	// so a later Kill can tear them down; see Kill's own doc comment.
	Wake(ctx context.Context, spec mount.Session, runAs containerdefaults.RunAs, resources containerdefaults.Resources) (containerID string, containerName string, auxiliaryNames []string, privateNetwork string, err error)
	// BuildImage runs `docker build` against a context directory the kernel
	// derived itself (never caller-supplied) with a fixed flag set, piping
	// dockerfile on stdin to `-f -`.
	BuildImage(ctx context.Context, contextDir, imageTag, dockerfile string) (imageID string, err error)
	// Kill performs graceful teardown (`docker stop -t <graceSeconds>` then
	// best-effort `docker rm --force`) against a container name the kernel
	// resolved from its own registry (never a caller-supplied name) —
	// mirroring DockerHandle.stop (docker-driver.ts:524-540) exactly, not
	// the unconditional `docker kill` an earlier version of this method
	// issued (see ADR-016). auxiliaryNames/privateNetwork (v2.4.0
	// promotion, Workstream A3), also caller-resolved from its own
	// registry rather than re-derived here, are torn down in the same
	// call — auxiliaries in reverse creation order, then the network —
	// mirroring DockerHandle.stop's own teardown order exactly. Both are
	// safe to pass as nil/"" for an ordinary single-container session.
	Kill(ctx context.Context, containerName string, auxiliaryNames []string, privateNetwork string, graceSeconds int) error
}

// dockerExecutor is the real Executor: os/exec wrapping the `docker` CLI,
// mirroring docker-driver.ts's own use of the Cli wrapper for the same
// three operations, now run from the one process authorized to do so.
type dockerExecutor struct {
	dockerBin string // overridable in tests; defaults to "docker"
	// networkName mirrors drivers/index.ts's dockerNetworkArgs: a FIXED,
	// install-level network name injected once at driver construction —
	// never a per-request field, so it never widens the "no caller-supplied
	// flags" invariant (see ADR-016 §"the network flag becomes kernel
	// startup configuration"). Empty means no --network flag, matching a
	// driver built with no networkArgsFor at all. Used only when a session
	// has no auxiliary containers — see Wake's own comment on why a
	// multi-container session uses its own private network instead.
	networkName string
	runner      func(ctx context.Context, name string, args ...string) ([]byte, error)
	// runnerStdin is used only by BuildImage, to pipe the Dockerfile body to
	// `docker build -f -` — kept as a separate function (rather than
	// widening runner's signature everywhere) so every other call site's
	// signature stays exactly as narrow as the doc comment above promises.
	runnerStdin func(ctx context.Context, name string, stdin string, args ...string) ([]byte, error)
}

func newDockerExecutor(networkName string) *dockerExecutor {
	return &dockerExecutor{
		dockerBin:   "docker",
		networkName: networkName,
		// name is always d.dockerBin ("docker", overridable only in tests) and
		// args comes entirely from this package's own validated construction —
		// see the Executor doc comment above: never a caller-supplied argv.
		runner: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			// #nosec G204 -- name/args are never caller-supplied, see comment above
			return exec.CommandContext(ctx, name, args...).CombinedOutput() // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
		},
		// Same as runner above: name/args are never caller-supplied.
		runnerStdin: func(ctx context.Context, name string, stdin string, args ...string) ([]byte, error) {
			// #nosec G204 -- name/args are never caller-supplied, see comment above
			cmd := exec.CommandContext(ctx, name, args...) // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
			cmd.Stdin = strings.NewReader(stdin)
			return cmd.CombinedOutput()
		},
	}
}

// Wake ports DockerSessionDriver.prepare + DockerHandle.start's combined
// behavior (docker-driver.ts, commit 249bbe93 — the v2.4.0 promotion's
// "Iron Proxy gateway" work) into Go's single create-and-start call, since
// this Executor has no separate prepare/start phases the way the TS driver
// does. For an ordinary single-container session (no auxiliary containers
// requested), behavior is byte-for-byte the pre-v2.4.0 flow this method
// already had. For a multi-container (gateway) session:
//
//   - A private, --internal Docker network is created for this session
//     alone (never shared across sessions — sessionNetworkName is derived
//     from the session key).
//   - Each auxiliary container is created --read-only (unlike the agent),
//     given the fixed bridge+host-gateway network args auxiliaryNetworkArgs
//     returns (its OWN uplink to the outside world — never the private
//     network directly, matching the package doc comment's "Auxiliary
//     containers keep the ordinary bridge as their uplink" topology note),
//     then connected to the private network under an alias: the session's
//     configured gateway endpoint if this IS the networkAccess target,
//     else its own role name.
//   - The agent container is created attached to the private network
//     instead of this executor's fixed d.networkName, so it can reach the
//     gateway ONLY through whichever auxiliary container networkAccess
//     named — never the outside network directly (sharedNetworkNamespace
//     stays false either way; see the package doc comment).
//   - Auxiliaries are started before the agent (mirrors DockerHandle.start's
//     own ordering).
//   - "allocate all or leave nothing" is preserved through both the create
//     and start phases: any failure at any point rolls back every
//     container created so far (reverse order) and the network, exactly
//     mirroring docker-driver.ts's own rollback loop.
func (d *dockerExecutor) Wake(ctx context.Context, spec mount.Session, runAs containerdefaults.RunAs, resources containerdefaults.Resources) (string, string, []string, string, error) {
	agent, extra, err := splitContainers(spec)
	if err != nil {
		return "", "", nil, "", err
	}
	if err := validateNetworkAccessTarget(spec, extra); err != nil {
		return "", "", nil, "", err
	}

	name := ContainerName(spec.Key)
	var privateNetwork string
	auxiliaryNames := make([]string, len(extra))
	for i, c := range extra {
		auxiliaryNames[i] = auxiliaryContainerName(spec.Key, c.Role)
	}
	if len(extra) > 0 {
		privateNetwork = sessionNetworkName(spec.Key)
	}

	var created []string
	rollback := func() {
		for i := len(created) - 1; i >= 0; i-- {
			_, _ = d.runner(ctx, d.dockerBin, "rm", "--force", created[i])
		}
		if privateNetwork != "" {
			_, _ = d.runner(ctx, d.dockerBin, "network", "rm", privateNetwork)
		}
	}

	if privateNetwork != "" {
		netArgs := []string{"network", "create", "--internal"}
		netArgs = append(netArgs, labelArgs(LabelsForKey(spec.Key, "session-network", spec.Labels))...)
		netArgs = append(netArgs, privateNetwork)
		if _, err := d.runner(ctx, d.dockerBin, netArgs...); err != nil {
			return "", "", nil, "", fmt.Errorf("docker network create: %w", err)
		}
		for i, container := range extra {
			auxiliaryName := auxiliaryNames[i]
			if _, err := d.runner(ctx, d.dockerBin, containerCreateArgs(spec, container, auxiliaryName, auxiliaryNetworkArgs(), runAs, resources)...); err != nil {
				rollback()
				return "", "", nil, "", fmt.Errorf("docker create (auxiliary %s): %w", container.Role, err)
			}
			created = append(created, auxiliaryName)
			alias := container.Role
			if spec.NetworkAccess.Target.Kind == mount.NetworkTargetSessionContainer && spec.NetworkAccess.Target.Role == container.Role {
				alias = spec.NetworkAccess.Endpoint
			}
			if _, err := d.runner(ctx, d.dockerBin, "network", "connect", "--alias", alias, privateNetwork, auxiliaryName); err != nil {
				rollback()
				return "", "", nil, "", fmt.Errorf("docker network connect (auxiliary %s): %w", container.Role, err)
			}
		}
	}

	agentNetworkArgs := []string{}
	if privateNetwork != "" {
		agentNetworkArgs = []string{"--network", privateNetwork}
	} else if d.networkName != "" {
		agentNetworkArgs = []string{"--network", d.networkName}
	}
	out, err := d.runner(ctx, d.dockerBin, containerCreateArgs(spec, agent, name, agentNetworkArgs, runAs, resources)...)
	if err != nil {
		rollback()
		return "", "", nil, "", fmt.Errorf("docker create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	created = append(created, name)
	containerID := strings.TrimSpace(string(out))

	// Start order mirrors DockerHandle.start: auxiliaries first, agent last.
	for _, auxiliaryName := range auxiliaryNames {
		if _, err := d.runner(ctx, d.dockerBin, "start", auxiliaryName); err != nil {
			rollback()
			return "", "", nil, "", fmt.Errorf("docker start (auxiliary): %w", err)
		}
	}
	if _, err := d.runner(ctx, d.dockerBin, "start", name); err != nil {
		rollback()
		return "", "", nil, "", fmt.Errorf("docker start: %w", err)
	}

	return containerID, name, auxiliaryNames, privateNetwork, nil
}

func (d *dockerExecutor) BuildImage(ctx context.Context, contextDir, imageTag, dockerfile string) (string, error) {
	// A fixed flag set — see doc.go's non-capabilities list. No
	// --network/--add-host/--build-arg/--secret passthrough of any kind.
	// The Dockerfile body is piped on stdin to `-f -`, never written to a
	// caller-controlled path.
	out, err := d.runnerStdin(ctx, d.dockerBin, dockerfile, "build", "-t", imageTag, "-f", "-", contextDir)
	if err != nil {
		return "", fmt.Errorf("docker build: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return imageTag, nil
}

func (d *dockerExecutor) Kill(ctx context.Context, containerName string, auxiliaryNames []string, privateNetwork string, graceSeconds int) error {
	if graceSeconds <= 0 {
		graceSeconds = defaultStopGraceSeconds
	}
	// Graceful stop, then best-effort remove — mirrors DockerHandle.stop
	// (docker-driver.ts:524-540) exactly, including tolerating a stop
	// failure (already gone, or the daemon refused) and an rm failure
	// (--rm already got there first).
	if _, err := d.runner(ctx, d.dockerBin, "stop", "-t", fmt.Sprintf("%d", graceSeconds), containerName); err != nil {
		// Not fatal — fall through to rm exactly as the TS handle does,
		// rather than returning early and leaving the container behind.
		_ = err
	}
	_, _ = d.runner(ctx, d.dockerBin, "rm", "--force", containerName)

	// Auxiliaries torn down in reverse creation order, then the private
	// network — mirrors DockerHandle.stop's own teardown order (commit
	// 249bbe93) exactly. Both no-op cleanly for an ordinary
	// single-container session (auxiliaryNames nil, privateNetwork "").
	for i := len(auxiliaryNames) - 1; i >= 0; i-- {
		auxiliary := auxiliaryNames[i]
		if _, err := d.runner(ctx, d.dockerBin, "stop", "-t", "1", auxiliary); err != nil {
			_ = err // already gone — same tolerance as the agent's own stop above
		}
		_, _ = d.runner(ctx, d.dockerBin, "rm", "--force", auxiliary)
	}
	if privateNetwork != "" {
		// Best-effort: already gone, or still referenced by a container
		// this method just failed to remove above — either way, not fatal
		// to the kill itself (mirrors the TS handle's own tolerance here).
		_, _ = d.runner(ctx, d.dockerBin, "network", "rm", privateNetwork)
	}
	return nil
}

// splitContainers finds the session's exactly-one agent container and
// returns every other container as "extra" (potential auxiliaries) —
// replaces the pre-v2.4.0 findAgentContainer, which refused any non-agent
// role outright (docker-driver.ts:109-122, pre-249bbe93: "this driver
// realizes the agent container only"). mount.ValidateSpec has already
// confirmed exactly one agent-role container exists by the time this runs
// (capability.go's handleWake calls it first); this still re-derives
// rather than trusts a count, the same defense-in-depth posture the
// original refusal already had.
func splitContainers(spec mount.Session) (agent mount.Container, extra []mount.Container, err error) {
	var found bool
	for _, c := range spec.Containers {
		if c.Role == "agent" {
			agent = c
			found = true
			continue
		}
		extra = append(extra, c)
	}
	if !found {
		return mount.Container{}, nil, fmt.Errorf("spec-invalid: session has no agent-role container")
	}
	return agent, extra, nil
}

// validateNetworkAccessTarget ports prepare's two networkAccess checks
// (docker-driver.ts, commit 249bbe93) verbatim: a session with auxiliary
// containers must route its gateway access through one of them (never mix
// a central/shared gateway network with an auxiliary gateway container),
// and a session-container target must actually name one of the session's
// own auxiliary containers, not an arbitrary role string.
func validateNetworkAccessTarget(spec mount.Session, extra []mount.Container) error {
	if len(extra) > 0 && spec.NetworkAccess.Target.Kind != mount.NetworkTargetSessionContainer {
		return fmt.Errorf("spec-invalid: a session cannot use both a central gateway network and an auxiliary gateway container")
	}
	if spec.NetworkAccess.Target.Kind == mount.NetworkTargetSessionContainer {
		named := false
		for _, c := range extra {
			if c.Role == spec.NetworkAccess.Target.Role {
				named = true
				break
			}
		}
		if !named {
			return fmt.Errorf("spec-invalid: session-container network target must name an auxiliary container")
		}
	}
	return nil
}

// sessionNetworkName ports sessionNetworkName (docker-driver.ts, commit
// 249bbe93) verbatim: the session's own private network, derived from the
// session key alone — never caller-supplied, same "resolve the fact
// ourselves" discipline ContainerName already established.
func sessionNetworkName(key mount.SessionKey) string {
	return ContainerName(key) + "-private"
}

// auxiliaryContainerName ports auxiliaryContainerName (docker-driver.ts,
// commit 249bbe93): <agent name>-<role>, hash-truncated the same way
// ContainerName itself truncates when the raw form would exceed Docker's
// name-length practical limit. Uses the identical sanitization ContainerName
// already applies (nonNameChar.ReplaceAllString) rather than a separate
// validateRuntimeName port — TS's own validateRuntimeName call here is
// belt-and-suspenders over an already-legal-charset input; this
// construction is legal-by-construction the same way ContainerName already
// is, so no second validation pass is needed.
func auxiliaryContainerName(key mount.SessionKey, role string) string {
	raw := nonNameChar.ReplaceAllString(fmt.Sprintf("%s-%s", ContainerName(key), role), "-")
	if len(raw) <= 63 {
		return raw
	}
	sum := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(sum[:])[:8]
	return fmt.Sprintf("%s-%s", raw[:54], hash)
}

// auxiliaryNetworkArgs ports auxiliaryNetworkArgs (docker-driver.ts, commit
// 249bbe93) verbatim: an auxiliary container's OWN uplink is the ordinary
// Docker bridge network (never the agent's private network directly — see
// the package doc comment's topology note), plus the Linux-only explicit
// host-gateway alias Docker provides automatically on macOS/Windows but not
// Linux.
func auxiliaryNetworkArgs() []string {
	args := []string{"--network", "bridge"}
	if runtime.GOOS == "linux" {
		args = append(args, "--add-host=host.docker.internal:host-gateway")
	}
	return args
}

// containerCreateArgs ports containerCreateArgs (docker-driver.ts, commit
// 249bbe93) verbatim — the generalized argv builder every container (agent
// or auxiliary) now goes through, replacing Wake's pre-v2.4.0 agent-only
// inline construction. The one behavioral difference by role: a non-agent
// container is created --read-only (auxiliary containers get no
// expectation of writing to their own container filesystem — the agent
// alone keeps a writable root, matching upstream's own new hardening
// addition here, not just a wiring change).
//
// runAs/resources are session-level in TS (spec.resources/spec.hardening,
// read via resourceArgs(spec)/userArgs(spec) — the whole SessionSpec, not
// per-container fields), applied identically to every container in the
// session. Go's Wake receives them as separate parameters rather than
// fields on mount.Session (they come from CapabilityRequestPayload.RunAs/
// .Resources, validated by containerdefaults before Wake is ever called),
// so this helper takes them explicitly and applies them uniformly the same
// way — every container in a session gets the one validated runAs/
// resources pair Wake itself received, agent and auxiliaries alike.
func containerCreateArgs(spec mount.Session, container mount.Container, name string, networkArgs []string, runAs containerdefaults.RunAs, resources containerdefaults.Resources) []string {
	args := []string{"create", "--rm", "--name", name}
	args = append(args, labelArgs(LabelsForKey(spec.Key, container.Role, mergeLabels(spec.Labels, container.Labels)))...)
	args = append(args, containerdefaults.ResourceArgs(resources)...)
	args = append(args, containerdefaults.HardeningPosture...)
	if container.Role != "agent" {
		args = append(args, "--read-only")
	}
	args = append(args, containerdefaults.PidsLimitArg(resources)...)
	args = append(args, containerdefaults.UserArgs(runAs)...)
	// Composed env first, contributed env second: on a duplicate -e key
	// Docker's last flag wins — the contributed lane overrides composed
	// literals, matching docker-driver.ts:144-148 exactly.
	args = append(args, envArgs(container.Env)...)
	args = append(args, envArgs(container.ContributedEnv)...)
	args = append(args, mountArgs(container.Mounts)...)
	args = append(args, networkArgs...)
	if len(container.Command) > 0 {
		// Docker splits PID 1 across --entrypoint (argv[0] + fixed flags)
		// and the post-image argv — docker-driver.ts:154-159.
		args = append(args, "--entrypoint", container.Command[0])
		args = append(args, container.Image)
		args = append(args, container.Command[1:]...)
		args = append(args, container.Args...)
	} else {
		args = append(args, container.Image)
		args = append(args, container.Args...)
	}
	return args
}

func mergeLabels(sessionLabels, containerLabels map[string]string) map[string]string {
	merged := make(map[string]string, len(sessionLabels)+len(containerLabels))
	for k, v := range sessionLabels {
		merged[k] = v
	}
	for k, v := range containerLabels {
		merged[k] = v
	}
	return merged
}

func mountArgs(mounts []mount.Spec) []string {
	args := make([]string, 0, len(mounts)*2)
	for _, m := range mounts {
		ro := ""
		if m.Mode == mount.ModeRO {
			ro = ":ro"
		}
		args = append(args, "-v", fmt.Sprintf("%s:%s%s", m.HostPath, m.ContainerPath, ro))
	}
	return args
}

func envArgs(env map[string]string) []string {
	args := make([]string, 0, len(env)*2)
	for k, v := range env {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}
	return args
}

func labelArgs(labels map[string]string) []string {
	args := make([]string, 0, len(labels)*2)
	for k, v := range labels {
		args = append(args, "--label", fmt.Sprintf("%s=%s", k, v))
	}
	return args
}
