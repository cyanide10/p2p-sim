package dispatch

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/task"
)

// Config controls retry and backoff behaviour.
type Config struct {
	MaxAttempts    int           // total tries per task before it is permanently failed
	BackoffInitial time.Duration // pause after a peer's first consecutive failure
	BackoffMax     time.Duration // cap for the doubling backoff
}

// Dispatcher runs tasks with a worker pool of exactly one goroutine per peer.
// Workers pull from a shared queue, so a task that fails on one peer is
// requeued and picked up by whichever peer is free next.
type Dispatcher struct {
	Client PeerClient
	Config Config
	Logger *slog.Logger
}

// Run dispatches every task in tr across peerList and blocks until each task
// is complete or permanently failed, or ctx ends (remaining tasks are then
// marked failed). It returns the wall-clock duration of the run.
func (d *Dispatcher) Run(ctx context.Context, peerList []peers.Peer, tr *Tracker) time.Duration {
	start := time.Now()
	tasks := tr.Tasks()

	// Capacity len(tasks) means requeueing never blocks: the queue can never
	// hold more entries than there are unfinished tasks.
	queue := make(chan Task, len(tasks))
	for _, t := range tasks {
		queue <- t
	}

	done := make(chan struct{})
	var mu sync.Mutex
	remaining := len(tasks)
	finishOne := func() {
		mu.Lock()
		defer mu.Unlock()
		remaining--
		if remaining == 0 {
			close(done)
		}
	}
	if remaining == 0 {
		close(done)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	for _, p := range peerList {
		wg.Add(1)
		go func(p peers.Peer) {
			defer wg.Done()
			d.worker(runCtx, p, queue, done, tr, finishOne)
		}(p)
	}

	select {
	case <-done:
	case <-ctx.Done():
		d.Logger.Warn("dispatch stopped before all tasks finished", "reason", ctx.Err())
	}
	cancel()
	wg.Wait()

	if ctx.Err() != nil {
		if n := tr.failUnfinished("dispatch stopped before completion: " + ctx.Err().Error()); n > 0 {
			d.Logger.Warn("marked unfinished tasks failed", "count", n)
		}
	}
	return time.Since(start)
}

func (d *Dispatcher) worker(ctx context.Context, p peers.Peer, queue chan Task, done <-chan struct{},
	tr *Tracker, finishOne func()) {
	log := d.Logger.With("peer_id", p.ID)
	streak := 0 // consecutive failures on this peer

	for {
		// A failing peer stops taking work: it waits with exponential backoff
		// and only resumes once /health answers. Without this, a dead peer
		// that fails instantly would drain the queue and burn every task's
		// retry budget.
		if streak > 0 {
			if !sleep(ctx, done, Backoff(streak, d.Config.BackoffInitial, d.Config.BackoffMax)) {
				return
			}
			if err := d.Client.Health(ctx, p); err != nil {
				streak++
				log.Debug("peer still unhealthy", "error", err, "streak", streak)
				continue
			}
			log.Info("peer healthy again, resuming dispatch", "after_failures", streak)
			streak = 0
		}

		var t Task
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case t = <-queue:
		}

		attempt := tr.assign(t.TaskID, p.ID)
		tlog := log.With("task_id", t.TaskID, "seed", t.Seed, "attempt", attempt)
		tlog.Info("dispatching task")
		started := time.Now()

		res, err := d.Client.RunTask(ctx, p, t)
		elapsed := time.Since(started)
		if err != nil {
			if ctx.Err() != nil {
				tr.release(t.TaskID)
				return
			}
			streak++
			if errors.Is(err, task.ErrBusy) {
				// The node refused before running anything, so this is not an
				// attempt: requeue without charging the task's retry budget.
				tr.release(t.TaskID)
				tlog.Info("node busy, requeueing without charging an attempt")
				queue <- t
				continue
			}
			if tr.fail(t.TaskID, err, d.Config.MaxAttempts) {
				tlog.Warn("task attempt failed, requeueing", "duration_ms", elapsed.Milliseconds(), "error", err)
				queue <- t
			} else {
				tlog.Error("task permanently failed", "duration_ms", elapsed.Milliseconds(), "error", err)
				finishOne()
			}
			continue
		}

		streak = 0
		res.PeerID = p.ID
		tr.complete(t.TaskID, res)
		tlog.Info("task complete",
			"duration_ms", elapsed.Milliseconds(),
			"mean_wait_time", res.MeanWaitTime,
			"mean_queue_length", res.MeanQueueLength,
		)
		finishOne()
	}
}

// Backoff returns initial·2^(streak-1), capped at max.
func Backoff(streak int, initial, max time.Duration) time.Duration {
	d := initial
	for i := 1; i < streak; i++ {
		d *= 2
		if d >= max {
			return max
		}
	}
	if d > max {
		return max
	}
	return d
}

// sleep waits for d; it returns false if the run finished or was cancelled.
func sleep(ctx context.Context, done <-chan struct{}, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-done:
		return false
	case <-ctx.Done():
		return false
	}
}
