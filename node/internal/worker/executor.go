// Package worker is the executing side of a node: it runs simulation tasks,
// whether they arrive from another node over HTTP or from this node's own
// batch in-process. Both paths share one concurrency limit, so a node that is
// coordinating a batch and serving tasks for other nodes' batches at the same
// time never runs more simulations than it is configured for.
package worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/p2p-sim/node/internal/task"
)

// Simulator runs one replication. Implemented by sim.SimRunner; faked in tests.
type Simulator interface {
	Run(ctx context.Context, t task.Task) (task.Result, error)
}

// Executor bounds concurrent simulations and stamps results with the node id.
// It is stateless between tasks.
type Executor struct {
	sim    Simulator
	nodeID string
	slots  chan struct{}
	logger *slog.Logger
}

func New(sim Simulator, nodeID string, maxConcurrent int, logger *slog.Logger) *Executor {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &Executor{sim: sim, nodeID: nodeID, slots: make(chan struct{}, maxConcurrent), logger: logger}
}

// Acquire takes one simulation slot without queueing, for work other than a
// task (a live traffic stream). It returns task.ErrBusy when every slot is
// taken; otherwise the caller must call release when done.
func (e *Executor) Acquire() (release func(), err error) {
	select {
	case e.slots <- struct{}{}:
		return func() { <-e.slots }, nil
	default:
		return nil, task.ErrBusy
	}
}

// Execute runs t. It never queues: when every slot is taken it returns
// task.ErrBusy immediately so the caller can place the task elsewhere.
func (e *Executor) Execute(ctx context.Context, t task.Task) (task.Result, error) {
	if t.TaskID == "" {
		return task.Result{}, errors.New("task_id is required")
	}
	select {
	case e.slots <- struct{}{}:
		defer func() { <-e.slots }()
	default:
		return task.Result{}, task.ErrBusy
	}

	log := e.logger.With("task_id", t.TaskID, "seed", t.Seed)
	start := time.Now()
	res, err := e.sim.Run(ctx, t)
	elapsed := time.Since(start)
	if err != nil {
		log.Warn("task execution failed", "duration_ms", elapsed.Milliseconds(), "error", err)
		return task.Result{}, err
	}
	res.PeerID = e.nodeID
	log.Info("task executed",
		"duration_ms", elapsed.Milliseconds(),
		"mean_wait_time", res.MeanWaitTime,
		"packets_served", res.PacketsServed,
	)
	return res, nil
}
