package worker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/p2p-sim/node/internal/task"
)

type fakeSim struct {
	res     task.Result
	err     error
	started chan struct{} // optional: signalled when Run begins
	release chan struct{} // optional: Run blocks until closed
}

func (f *fakeSim) Run(_ context.Context, t task.Task) (task.Result, error) {
	if f.started != nil {
		f.started <- struct{}{}
	}
	if f.release != nil {
		<-f.release
	}
	if f.err != nil {
		return task.Result{}, f.err
	}
	r := f.res
	r.TaskID, r.Seed = t.TaskID, t.Seed
	return r, nil
}

func newExec(sim Simulator, max int) *Executor {
	return New(sim, "node-7", max, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

var tk = task.Task{TaskID: "b-0001", Seed: 11}

func TestExecuteStampsNodeID(t *testing.T) {
	res, err := newExec(&fakeSim{res: task.Result{MeanWaitTime: 5}}, 1).Execute(context.Background(), tk)
	if err != nil {
		t.Fatal(err)
	}
	if res.PeerID != "node-7" || res.TaskID != "b-0001" || res.MeanWaitTime != 5 {
		t.Fatalf("result = %+v", res)
	}
}

func TestExecutePropagatesError(t *testing.T) {
	boom := errors.New("simulation failed")
	if _, err := newExec(&fakeSim{err: boom}, 1).Execute(context.Background(), tk); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestExecuteRequiresTaskID(t *testing.T) {
	if _, err := newExec(&fakeSim{}, 1).Execute(context.Background(), task.Task{}); err == nil {
		t.Fatal("expected error for empty task_id")
	}
}

func TestExecuteBusyWhenSlotsFull(t *testing.T) {
	sim := &fakeSim{started: make(chan struct{}, 2), release: make(chan struct{})}
	e := newExec(sim, 1)

	done := make(chan error)
	go func() {
		_, err := e.Execute(context.Background(), tk)
		done <- err
	}()
	<-sim.started

	if _, err := e.Execute(context.Background(), tk); !errors.Is(err, task.ErrBusy) {
		t.Fatalf("second concurrent Execute: err = %v, want ErrBusy", err)
	}

	close(sim.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// The slot is free again.
	if _, err := e.Execute(context.Background(), tk); err != nil {
		t.Fatalf("after release: %v", err)
	}
}
