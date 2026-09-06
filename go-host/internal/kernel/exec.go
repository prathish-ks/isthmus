package kernel

import (
	"context"
	"fmt"
	"os/exec"
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
	// actually created.
	Wake(ctx context.Context, spec mount.Session, runAs containerdefaults.RunAs, resources containerdefaults.Resources) (containerID string, containerName string, err error)
	// BuildImage runs `docker build` against a context directory the kernel
	// derived itself (never caller-supplied) with a fixed flag set, piping
	// dockerfile on stdin to `-f -`.
	BuildImage(ctx context.Context, contextDir, imageTag, dockerfile string) (imageID string, err error)
	// Kill performs graceful teardown (`docker stop -t <graceSeconds>` then
	// best-effort `docker rm --force`) against a container name the kernel
	// resolved from its own registry (never a caller-supplied name) —
	// mirroring DockerHandle.stop (docker-driver.ts:524-540) exactly, not
	// the unconditional `docker kill` an earlier version of this method
	// issued (see ADR-016).
	Kill(ctx context.Context, containerName string, graceSeconds int) error
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
	// driver built with no networkArgsFor at all.
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

func (d *dockerExecutor) Wake(ctx context.Context, spec mount.Session, runAs containerdefaults.RunAs, resources containerdefaults.Resources) (string, string, error) {
	agent, err := findAgentContainer(spec)
	if err != nil {
		return "", "", err
	}
	name := ContainerName(spec.Key)

	args := []string{"create", "--rm", "--name", name}
	args = append(args, labelArgs(LabelsForKey(spec.Key, "agent", mergeLabels(spec.Labels, agent.Labels)))...)
	args = append(args, containerdefaults.ResourceArgs(resources)...)
	args = append(args, containerdefaults.HardeningPosture...)
	args = append(args, containerdefaults.PidsLimitArg(resources)...)
	args = append(args, containerdefaults.UserArgs(runAs)...)
	// Composed env first, contributed env second: on a duplicate -e key
	// Docker's last flag wins — the contributed lane overrides composed
	// literals, matching docker-driver.ts:144-148 exactly.
	args = append(args, envArgs(agent.Env)...)
	args = append(args, envArgs(agent.ContributedEnv)...)
	args = append(args, mountArgs(agent.Mounts)...)
	if d.networkName != "" {
		args = append(args, "--network", d.networkName)
	}
	if len(agent.Command) > 0 {
		// Docker splits PID 1 across --entrypoint (argv[0] + fixed flags)
		// and the post-image argv — docker-driver.ts:154-159.
		args = append(args, "--entrypoint", agent.Command[0])
		args = append(args, agent.Image)
		args = append(args, agent.Command[1:]...)
		args = append(args, agent.Args...)
	} else {
		args = append(args, agent.Image)
		args = append(args, agent.Args...)
	}

	out, err := d.runner(ctx, d.dockerBin, args...)
	if err != nil {
		return "", "", fmt.Errorf("docker create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	containerID := strings.TrimSpace(string(out))
	if _, err := d.runner(ctx, d.dockerBin, "start", name); err != nil {
		// Best-effort cleanup of the just-created-but-unstarted container —
		// prepare is atomic: allocate all or leave nothing (docker-driver.ts:164-173).
		_, _ = d.runner(ctx, d.dockerBin, "rm", "--force", name)
		return "", "", fmt.Errorf("docker start: %w", err)
	}
	return containerID, name, nil
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

func (d *dockerExecutor) Kill(ctx context.Context, containerName string, graceSeconds int) error {
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
	return nil
}

// findAgentContainer mirrors prepare's `spec.containers.find((c) => c.role
// === 'agent')!` plus its preceding refusal of any non-agent container
// (docker-driver.ts:109-122) — this driver realizes the agent container
// only.
func findAgentContainer(spec mount.Session) (mount.Container, error) {
	var agent *mount.Container
	for i := range spec.Containers {
		c := spec.Containers[i]
		if c.Role != "agent" {
			return mount.Container{}, fmt.Errorf("spec-invalid: docker driver does not manage container role %q; auxiliary containers are not supported by this kernel", c.Role)
		}
		if c.Role == "agent" {
			agent = &spec.Containers[i]
		}
	}
	if agent == nil {
		return mount.Container{}, fmt.Errorf("spec-invalid: session has no agent-role container")
	}
	return *agent, nil
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
