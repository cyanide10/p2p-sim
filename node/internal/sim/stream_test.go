package sim

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

var valid = StreamParams{Seed: 1, Lambda: 0.8, Mu: 1, Duration: 60, Speed: 10}

// shell returns a Command that ignores the simulate.py arguments and runs script instead.
func shell(script string) func(ctx context.Context, name string, args ...string) *exec.Cmd {
	return func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "/bin/sh", "-c", script)
	}
}

func TestStreamParamsValidate(t *testing.T) {
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := []StreamParams{
		{Seed: -1, Lambda: 0.8, Mu: 1, Duration: 60, Speed: 10},
		{Seed: 1, Lambda: 2, Mu: 1, Duration: 60, Speed: 10},
		{Seed: 1, Lambda: 0.8, Mu: 1, Duration: 4000, Speed: 10},
		{Seed: 1, Lambda: 0.8, Mu: 1, Duration: 60, Speed: 0},
		{Seed: 1, Lambda: 0.9, Mu: 1, Duration: 60, Speed: 500},
	}
	for _, p := range bad {
		if p.Validate() == nil {
			t.Errorf("%+v: expected an error", p)
		}
	}
}

func TestStreamArgs(t *testing.T) {
	got := strings.Join(StreamArgs("sim.py", valid), " ")
	want := "sim.py --stream --seed 1 --lam 0.8 --mu 1 --sim-time 60 --speed 10"
	if got != want {
		t.Fatalf("got %q; want %q", got, want)
	}
}

func TestStreamForwardsJSONLines(t *testing.T) {
	s := &Streamer{Command: shell(`echo '{"type":"meta"}'; echo noise; echo '{"type":"done"}'`)}
	var lines []string
	if err := s.Stream(context.Background(), valid, func(b []byte) error {
		lines = append(lines, string(b))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(lines, ",") != `{"type":"meta"},{"type":"done"}` {
		t.Fatalf("lines %v", lines)
	}
}

func TestStreamReportsFailure(t *testing.T) {
	s := &Streamer{Command: shell(`echo 'invalid parameters: bad' >&2; exit 1`)}
	err := s.Stream(context.Background(), valid, func([]byte) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "invalid parameters: bad") {
		t.Fatalf("got %v; want the stderr detail", err)
	}
}

func TestStreamStopsWhenViewerLeaves(t *testing.T) {
	s := &Streamer{Command: shell(`while true; do echo '{"type":"stats"}'; sleep 0.01; done`)}
	stop := errors.New("viewer left")
	n := 0
	start := time.Now()
	err := s.Stream(context.Background(), valid, func([]byte) error {
		if n++; n == 3 {
			return stop
		}
		return nil
	})
	if !errors.Is(err, stop) || time.Since(start) > 5*time.Second {
		t.Fatalf("got %v after %s; want a prompt stop", err, time.Since(start))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err = s.Stream(ctx, valid, func([]byte) error { return nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v; want the caller's deadline", err)
	}
}
