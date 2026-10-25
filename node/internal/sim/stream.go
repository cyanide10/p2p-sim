package sim

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Streaming bounds; they mirror simulate.py's validate_stream_params.
const (
	MaxStreamRho        = 1.5
	MaxStreamDuration   = 3600.0
	MaxStreamPacketRate = 200.0   // lambda * speed: packet arrivals per wall-clock second
	maxStreamLine       = 1 << 20 // the final network "done" event carries all metrics
)

// StreamParams describes one live replication: Duration simulated time units,
// played at Speed simulated units per wall-clock second.
type StreamParams struct {
	Seed     int64
	Lambda   float64
	Mu       float64
	Duration float64
	Speed    float64
}

func (p StreamParams) Validate() error {
	positive := func(v float64) bool { return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }
	switch {
	case p.Seed < 0:
		return fmt.Errorf("seed must be >= 0, got %d", p.Seed)
	case !positive(p.Lambda):
		return fmt.Errorf("lambda must be a positive number, got %v", p.Lambda)
	case !positive(p.Mu):
		return fmt.Errorf("mu must be a positive number, got %v", p.Mu)
	case p.Lambda/p.Mu > MaxStreamRho:
		return fmt.Errorf("rho = lambda/mu = %.4f exceeds %v for live traffic", p.Lambda/p.Mu, MaxStreamRho)
	case !positive(p.Duration) || p.Duration > MaxStreamDuration:
		return fmt.Errorf("duration must be in (0, %v], got %v", MaxStreamDuration, p.Duration)
	case !positive(p.Speed):
		return fmt.Errorf("speed must be a positive number, got %v", p.Speed)
	case p.Lambda*p.Speed > MaxStreamPacketRate:
		return fmt.Errorf("lambda * speed = %.1f packets per second exceeds %v", p.Lambda*p.Speed, MaxStreamPacketRate)
	}
	return nil
}

// StreamArgs builds the simulate.py argument list for streaming mode.
func StreamArgs(script string, p StreamParams) []string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	return []string{
		script, "--stream",
		"--seed", strconv.FormatInt(p.Seed, 10),
		"--lam", f(p.Lambda),
		"--mu", f(p.Mu),
		"--sim-time", f(p.Duration),
		"--speed", f(p.Speed),
	}
}

// Streamer runs simulate.py in streaming mode and hands each stdout line
// (one JSON event) to a callback as it is produced.
type Streamer struct {
	Python string
	Script string
	// Command builds the subprocess; nil means exec.CommandContext. Tests
	// substitute a shell command.
	Command func(ctx context.Context, name string, args ...string) *exec.Cmd
}

// Stream runs until the replication finishes, ctx is cancelled (the viewer
// left), or onLine returns an error. The subprocess is killed on return.
func (s *Streamer) Stream(ctx context.Context, p StreamParams, onLine func([]byte) error) error {
	if err := p.Validate(); err != nil {
		return err
	}
	// The run should take Duration/Speed seconds; allow slack for start-up.
	limit := time.Duration(p.Duration/p.Speed*float64(time.Second)) + 15*time.Second
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()

	return pipeLines(parent, ctx, limit, s.command(ctx, s.Python, StreamArgs(s.Script, p)...), nil, onLine)
}

func (s *Streamer) command(ctx context.Context, name string, args ...string) *exec.Cmd {
	if s.Command != nil {
		return s.Command(ctx, name, args...)
	}
	return exec.CommandContext(ctx, name, args...)
}

// pipeLines runs cmd (bound to ctx, a child of parent with deadline limit),
// feeding stdin, and passes each JSON line of stdout to onLine.
func pipeLines(parent, ctx context.Context, limit time.Duration, cmd *exec.Cmd, stdin []byte, onLine func([]byte) error) error {
	cmd.Env = subprocessEnv()
	cmd.WaitDelay = 2 * time.Second
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	stderr := &cappedBuffer{max: maxStderrBytes}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start simulation: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxStreamLine)
	var callbackErr error
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue // only JSON event lines are forwarded
		}
		if callbackErr = onLine(line); callbackErr != nil {
			break
		}
	}
	if callbackErr != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	switch {
	case callbackErr != nil:
		return callbackErr
	case parent.Err() != nil:
		return parent.Err() // the viewer left or the caller's deadline passed
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("live simulation exceeded %s", limit)
	case scanner.Err() != nil:
		return fmt.Errorf("read simulation output: %w", scanner.Err())
	case waitErr != nil:
		if detail := strings.TrimSpace(stderr.buf.String()); detail != "" {
			return fmt.Errorf("simulation failed (%v): %s", waitErr, detail)
		}
		return fmt.Errorf("simulation failed: %v", waitErr)
	}
	return nil
}
