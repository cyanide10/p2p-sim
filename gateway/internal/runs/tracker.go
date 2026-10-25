package runs

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/p2p-sim/gateway/internal/nodeclient"
)

// NodeAPI is the part of the node client a tracker needs.
type NodeAPI interface {
	Status(ctx context.Context, base, batchID string) (json.RawMessage, error)
	Report(ctx context.Context, base, batchID string) (json.RawMessage, error)
}

// Tracker follows each running record in its own goroutine until the batch
// completes or its coordinator is lost, so the final report is captured even
// if no browser is watching.
type Tracker struct {
	ctx         context.Context
	store       *Store
	api         NodeAPI
	peerURLs    map[string]string
	interval    time.Duration
	maxFailures int
	logger      *slog.Logger
	wg          sync.WaitGroup
}

func NewTracker(ctx context.Context, store *Store, api NodeAPI, peerURLs map[string]string,
	interval time.Duration, maxFailures int, logger *slog.Logger) *Tracker {
	return &Tracker{ctx: ctx, store: store, api: api, peerURLs: peerURLs,
		interval: interval, maxFailures: maxFailures, logger: logger}
}

// Track starts following runID. Call it once per record.
func (t *Tracker) Track(runID string) {
	t.wg.Add(1)
	go func() {
		defer t.wg.Done()
		t.follow(runID)
	}()
}

// Wait blocks until every tracker has stopped; cancel the context first.
func (t *Tracker) Wait() { t.wg.Wait() }

func (t *Tracker) follow(runID string) {
	rec, ok := t.store.Get(runID)
	if !ok {
		return
	}
	log := t.logger.With("run_id", runID, "coordinator", rec.Coordinator, "batch_id", rec.BatchID)
	base, ok := t.peerURLs[rec.Coordinator]
	if !ok {
		log.Warn("coordinator is not configured; marking lost")
		t.store.SetState(runID, CoordinatorLost)
		return
	}

	statusFailures, reportFailures := 0, 0
	awaitingReport := false
	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()

	for {
		if !awaitingReport {
			status, err := t.api.Status(t.ctx, base, rec.BatchID)
			switch {
			case t.ctx.Err() != nil:
				return
			case nodeclient.IsNotFound(err):
				log.Warn("coordinator no longer holds the batch")
				t.store.SetState(runID, CoordinatorLost)
				return
			case err != nil:
				statusFailures++
				log.Debug("status poll failed", "error", err, "failures", statusFailures)
				if statusFailures >= t.maxFailures {
					log.Warn("coordinator unreachable; marking lost", "error", err)
					t.store.SetState(runID, CoordinatorLost)
					return
				}
			default:
				statusFailures = 0
				t.store.SetStatus(runID, status)
				var s struct {
					State string `json:"state"`
				}
				_ = json.Unmarshal(status, &s)
				awaitingReport = s.State == "complete"
			}
		}

		if awaitingReport {
			report, err := t.api.Report(t.ctx, base, rec.BatchID)
			if t.ctx.Err() != nil {
				return
			}
			if err == nil {
				t.store.SetReport(runID, report)
				t.store.SetState(runID, Complete)
				log.Info("run complete; report stored")
				return
			}
			reportFailures++
			if reportFailures >= t.maxFailures {
				log.Warn("batch complete but report could not be fetched", "error", err)
				t.store.SetState(runID, Complete)
				return
			}
		}

		select {
		case <-t.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
