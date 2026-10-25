// Package sim invokes the Python/SimPy simulation script as a subprocess and
// converts its single-line JSON stdout into a task.Result.
//
// The Go side never needs to know how the simulation works internally, only
// the CLI contract of simulate.py:
//
//	python3 simulate.py --seed N --lam X --mu Y --sim-time T --warmup-time W
//	stdout: one JSON line; stderr: diagnostics; exit 0 = success, non-zero = failure.
package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/p2p-sim/node/internal/task"
)

// CommandRunner executes an external command and returns its captured stdout
// and stderr. It is an interface so tests can substitute a fake and run
// without a Python installation.
type CommandRunner interface {
	Run(ctx context.Context, name string, args ...string) (stdout, stderr []byte, err error)
}

// Output caps. The expected stdout is a ~200 byte JSON line; anything beyond
// these limits is dropped so a misbehaving script cannot exhaust node memory
// (and oversized stderr is not echoed back to callers).
const (
	maxStdoutBytes = 1 << 20 // network metrics can be tens of KiB
	maxStderrBytes = 4 << 10
)

// InputCommandRunner is a CommandRunner that can also feed stdin, used for
// network scenarios (JSON is passed on stdin, never as arguments).
type InputCommandRunner interface {
	RunInput(ctx context.Context, stdin []byte, name string, args ...string) (stdout, stderr []byte, err error)
}

// ExecCommandRunner is the production CommandRunner backed by os/exec.
type ExecCommandRunner struct{}

func (r ExecCommandRunner) Run(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
	return r.RunInput(ctx, nil, name, args...)
}

func (ExecCommandRunner) RunInput(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	stdout := &cappedBuffer{max: maxStdoutBytes}
	stderr := &cappedBuffer{max: maxStderrBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = subprocessEnv()
	// If the context kills the process but a grandchild keeps the pipes open,
	// don't wait on them forever.
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	return stdout.buf.Bytes(), stderr.buf.Bytes(), err
}

// subprocessEnv passes only what the interpreter needs, so anything else in
// the node's environment (tokens, credentials) is not inherited by the child.
func subprocessEnv() []string {
	env := []string{"PYTHONDONTWRITEBYTECODE=1"}
	for _, key := range []string{"PATH", "LANG", "SIM_LOG_LEVEL"} {
		if v, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+v)
		}
	}
	return env
}

// cappedBuffer keeps at most max bytes and silently discards the rest. Write
// always reports success so the child never blocks or dies on a full pipe.
type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

// SimRunner runs one simulation replication per task.
type SimRunner struct {
	Cmd       CommandRunner
	Python    string        // interpreter, e.g. "python3"
	Script    string        // path to simulate.py
	NetScript string        // path to netsim.py (network tasks)
	Timeout   time.Duration // per-subprocess limit; keep below the coordinator's request timeout
}

// Args builds the simulate.py argument list (script path first) for a task.
// Only numeric values are passed, and exec does not use a shell, so request
// content cannot inject arguments or commands.
func Args(script string, t task.Task) []string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	return []string{
		script,
		"--seed", strconv.FormatInt(t.Seed, 10),
		"--lam", f(t.Params.Lambda),
		"--mu", f(t.Params.Mu),
		"--sim-time", f(t.Params.SimTime),
		"--warmup-time", f(t.Params.WarmupTime),
	}
}

// Run executes the simulation for t. Any failure (timeout, non-zero exit,
// malformed output) is returned as an error whose message is suitable for
// returning to the coordinating node.
func (r *SimRunner) Run(ctx context.Context, t task.Task) (task.Result, error) {
	if r.Timeout <= 0 {
		return task.Result{}, errors.New("runner misconfigured: timeout must be > 0")
	}
	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()
	if len(t.Network) > 0 {
		return r.runNetwork(ctx, t)
	}

	stdout, stderr, err := r.Cmd.Run(ctx, r.Python, Args(r.Script, t)...)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return task.Result{}, fmt.Errorf("simulation timed out after %s", r.Timeout)
	}
	if err != nil {
		detail := strings.TrimSpace(string(stderr))
		if detail == "" {
			return task.Result{}, fmt.Errorf("simulation failed: %v", err)
		}
		return task.Result{}, fmt.Errorf("simulation failed (%v): %s", err, detail)
	}

	out, err := ParseOutput(stdout)
	if err != nil {
		return task.Result{}, err
	}
	if out.Seed != t.Seed {
		return task.Result{}, fmt.Errorf("simulation echoed seed %d, expected %d", out.Seed, t.Seed)
	}
	return task.Result{
		TaskID:          t.TaskID,
		Seed:            t.Seed,
		MeanWaitTime:    out.MeanWaitTime,
		MeanQueueLength: out.MeanQueueLength,
		Utilization:     out.Utilization,
		PacketsServed:   out.PacketsServed,
		RuntimeSeconds:  out.RuntimeSeconds,
	}, nil
}

// runNetwork simulates the task's network scenario with netsim.py.
func (r *SimRunner) runNetwork(ctx context.Context, t task.Task) (task.Result, error) {
	runner, ok := r.Cmd.(InputCommandRunner)
	if !ok || r.NetScript == "" {
		return task.Result{}, errors.New("runner misconfigured: network simulation is not available")
	}
	stdout, stderr, err := runner.RunInput(ctx, []byte(t.Network), r.Python, r.NetScript, "--seed", strconv.FormatInt(t.Seed, 10))
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return task.Result{}, fmt.Errorf("network simulation timed out after %s", r.Timeout)
	}
	if err != nil {
		if detail := strings.TrimSpace(string(stderr)); detail != "" {
			return task.Result{}, fmt.Errorf("network simulation failed (%v): %s", err, detail)
		}
		return task.Result{}, fmt.Errorf("network simulation failed: %v", err)
	}
	line := bytes.TrimSpace(stdout)
	if len(line) == 0 || bytes.ContainsRune(line, '\n') {
		return task.Result{}, errors.New("network simulation stdout must be a single JSON line")
	}
	var out struct {
		Seed           int64           `json:"seed"`
		RuntimeSeconds float64         `json:"runtime_seconds"`
		Metrics        json.RawMessage `json:"metrics"`
	}
	if err := json.Unmarshal(line, &out); err != nil {
		return task.Result{}, fmt.Errorf("invalid JSON from network simulation: %w", err)
	}
	if out.Seed != t.Seed || len(out.Metrics) == 0 {
		return task.Result{}, fmt.Errorf("network simulation returned seed %d without metrics (expected seed %d)", out.Seed, t.Seed)
	}
	return task.Result{TaskID: t.TaskID, Seed: t.Seed, RuntimeSeconds: out.RuntimeSeconds, Network: task.RawJSON(out.Metrics)}, nil
}

// Output is the JSON object printed by simulate.py.
type Output struct {
	Seed            int64   `json:"seed"`
	MeanWaitTime    float64 `json:"mean_wait_time"`
	MeanQueueLength float64 `json:"mean_queue_length"`
	Utilization     float64 `json:"utilization"`
	PacketsServed   int64   `json:"packets_served"`
	RuntimeSeconds  float64 `json:"runtime_seconds"`
}

var requiredFields = []string{
	"seed", "mean_wait_time", "mean_queue_length", "utilization", "packets_served", "runtime_seconds",
}

// ParseOutput validates and decodes the simulation's stdout, which must be
// exactly one JSON object line containing every required field.
func ParseOutput(stdout []byte) (Output, error) {
	line := bytes.TrimSpace(stdout)
	if len(line) == 0 {
		return Output{}, errors.New("simulation produced no output on stdout")
	}
	if bytes.ContainsRune(line, '\n') {
		return Output{}, errors.New("simulation stdout must be a single JSON line")
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil {
		return Output{}, fmt.Errorf("invalid JSON from simulation: %w", err)
	}
	for _, name := range requiredFields {
		if _, ok := fields[name]; !ok {
			return Output{}, fmt.Errorf("simulation output missing field %q", name)
		}
	}

	var out Output
	if err := json.Unmarshal(line, &out); err != nil {
		return Output{}, fmt.Errorf("invalid JSON from simulation: %w", err)
	}
	return out, nil
}
