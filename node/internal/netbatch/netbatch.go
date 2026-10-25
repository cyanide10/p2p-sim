// Package netbatch coordinates network-scenario batches: the same topology and
// traffic simulated as independent seeded replications across every node,
// then aggregated per flow, link and router with 95% confidence intervals.
//
// It reuses the M/M/1 batch machinery's dispatcher, so retries, busy handling
// and coordinator-loss recovery (resubmit the same base_seed) behave the same.
package netbatch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

const (
	DefaultReplications = 30
	MaxReplications     = 10_000
	MaxScenarioBytes    = 512 << 10
	maxRetained         = 10
)

var ErrBusy = errors.New("a network batch is already running on this node")

type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// Validator checks a scenario before any task is dispatched. Implemented by sim.Network.
type Validator interface {
	Validate(ctx context.Context, scenario []byte) (sim.Summary, error)
}

// Request is the POST /netrun body.
type Request struct {
	Scenario     json.RawMessage `json:"scenario"`
	Replications *int            `json:"replications"`
	BaseSeed     *int64          `json:"base_seed"`
}

type Batch struct {
	ID           string
	Coordinator  string
	Replications int
	BaseSeed     int64
	Scenario     json.RawMessage
	Summary      sim.Summary
	Peers        []peers.Peer
	StartedAt    time.Time

	tracker *dispatch.Tracker
	done    chan struct{}

	mu         sync.Mutex
	finishedAt time.Time
	wall       time.Duration
}

func (b *Batch) Done() <-chan struct{} { return b.done }

func (b *Batch) finished() bool {
	select {
	case <-b.done:
		return true
	default:
		return false
	}
}

type Manager struct {
	ctx          context.Context
	dispatcher   *dispatch.Dispatcher
	peers        []peers.Peer
	selfID       string
	validator    Validator
	phaseTimeout time.Duration
	logger       *slog.Logger

	mu      sync.Mutex
	batches map[string]*Batch
	latest  *Batch
}

func NewManager(ctx context.Context, d *dispatch.Dispatcher, peerList []peers.Peer, selfID string,
	v Validator, phaseTimeout time.Duration, logger *slog.Logger) *Manager {
	return &Manager{ctx: ctx, dispatcher: d, peers: peerList, selfID: selfID, validator: v,
		phaseTimeout: phaseTimeout, logger: logger, batches: map[string]*Batch{}}
}

// Start validates the request (including the scenario, via netsim.py) and
// launches the batch in the background.
func (m *Manager) Start(ctx context.Context, req Request) (*Batch, error) {
	now := time.Now()
	reps := DefaultReplications
	if req.Replications != nil {
		reps = *req.Replications
	}
	seed := now.UnixMilli()
	if req.BaseSeed != nil {
		seed = *req.BaseSeed
	}
	switch {
	case reps < 2 || reps > MaxReplications:
		return nil, &ValidationError{fmt.Sprintf("replications must be between 2 and %d, got %d", MaxReplications, reps)}
	case seed < 0 || seed > math.MaxInt64-int64(reps):
		return nil, &ValidationError{fmt.Sprintf("base_seed must be >= 0 and leave room for %d seeds", reps)}
	case len(req.Scenario) == 0 || string(req.Scenario) == "null":
		return nil, &ValidationError{"scenario is required"}
	case len(req.Scenario) > MaxScenarioBytes:
		return nil, &ValidationError{"scenario is larger than 512 KiB"}
	}
	summary, err := m.validator.Validate(ctx, req.Scenario)
	var se *sim.ScenarioError
	if errors.As(err, &se) {
		return nil, &ValidationError{se.Msg}
	}
	if err != nil {
		return nil, fmt.Errorf("validate scenario: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.latest != nil && !m.latest.finished() {
		return m.latest, ErrBusy
	}
	m.evictOldLocked()

	id := newBatchID(m.selfID, now)
	tasks := dispatch.GenerateTasks(id, reps, seed, dispatch.SimParams{})
	for i := range tasks {
		tasks[i].Network = task.RawJSON(req.Scenario)
	}
	b := &Batch{
		ID: id, Coordinator: m.selfID, Replications: reps, BaseSeed: seed, Scenario: req.Scenario,
		Summary: summary, Peers: m.peers, StartedAt: now,
		tracker: dispatch.NewTracker(tasks), done: make(chan struct{}),
	}
	m.batches[id] = b
	m.latest = b
	go m.execute(b)
	return b, nil
}

// Get returns the batch with this id (no "latest" fallback: ids are required).
func (m *Manager) Get(id string) (*Batch, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.batches[id]
	return b, ok
}

func (m *Manager) evictOldLocked() {
	for len(m.batches) >= maxRetained {
		var oldest *Batch
		for _, b := range m.batches {
			if b != m.latest && b.finished() && (oldest == nil || b.StartedAt.Before(oldest.StartedAt)) {
				oldest = b
			}
		}
		if oldest == nil {
			return
		}
		delete(m.batches, oldest.ID)
	}
}

func newBatchID(nodeID string, now time.Time) string {
	var buf [3]byte
	_, _ = rand.Read(buf[:])
	return fmt.Sprintf("net-%s-%s-%s", nodeID, now.UTC().Format("20060102T150405"), hex.EncodeToString(buf[:]))
}

func (m *Manager) execute(b *Batch) {
	defer close(b.done)
	log := m.logger.With("batch_id", b.ID)
	log.Info("network batch started", "replications", b.Replications, "base_seed", b.BaseSeed,
		"nodes", b.Summary.Nodes, "links", b.Summary.Links, "flows", b.Summary.Flows, "peers", len(b.Peers))
	ctx, cancel := context.WithTimeout(m.ctx, m.phaseTimeout)
	wall := m.dispatcher.Run(ctx, b.Peers, b.tracker)
	cancel()
	b.mu.Lock()
	b.wall = wall
	b.finishedAt = time.Now()
	b.mu.Unlock()
	c := b.tracker.Counts()
	log.Info("network batch complete", "wall_clock_seconds", wall.Seconds(), "complete", c.Complete, "failed", c.Failed)
}

// StatusView matches the M/M/1 GET /status shape so the gateway tracks both.
type StatusView struct {
	Kind         string `json:"kind"`
	BatchID      string `json:"batch_id"`
	Coordinator  string `json:"coordinator"`
	State        string `json:"state"`
	Phase        string `json:"phase"`
	Replications int    `json:"replications"`
	dispatch.Counts
	ElapsedSeconds float64 `json:"elapsed_seconds"`
}

func (b *Batch) Status() StatusView {
	b.mu.Lock()
	finished := b.finishedAt
	b.mu.Unlock()
	v := StatusView{Kind: "network", BatchID: b.ID, Coordinator: b.Coordinator, State: "running",
		Phase: "distributed", Replications: b.Replications, Counts: b.tracker.Counts()}
	end := time.Now()
	if b.finished() {
		v.State, v.Phase, end = "complete", "complete", finished
	}
	v.ElapsedSeconds = end.Sub(b.StartedAt).Seconds()
	return v
}
