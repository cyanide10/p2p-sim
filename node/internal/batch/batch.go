// Package batch manages the lifecycle of a simulation batch coordinated by
// this node: resolving the request against configured defaults, running the
// distributed dispatch phase across all nodes, optionally re-running the same
// seeds serially on this node alone as a timing baseline, and building the
// final report.
//
// Batch state lives only on the node that received POST /run. There is no
// permanent coordinator: any node can coordinate, and if the coordinating
// node dies, resubmitting the same base_seed to another node reproduces the
// batch exactly.
package batch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/p2p-sim/node/internal/config"
	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/stats"
)

// MaxReplications bounds a single batch to keep memory and runtime sane.
const MaxReplications = 100_000

// MaxRetainedBatches bounds how many batches are kept in memory for /status
// and /report. Each can hold up to 2×MaxReplications task states, so an
// unbounded history is a memory-exhaustion vector.
const MaxRetainedBatches = 10

// ErrBusy is returned when a batch is started while another is still running.
var ErrBusy = errors.New("a batch is already running on this node")

// ValidationError reports an invalid run request.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// Request is the POST /run body. Omitted fields take configured defaults.
type Request struct {
	Replications   *int     `json:"replications"`
	Lambda         *float64 `json:"lambda"`
	Mu             *float64 `json:"mu"`
	SimTime        *float64 `json:"sim_time"`
	WarmupTime     *float64 `json:"warmup_time"`
	TolerancePct   *float64 `json:"tolerance_pct"`
	BaseSeed       *int64   `json:"base_seed"`
	SerialBaseline *bool    `json:"serial_baseline"`
}

// Spec is a fully resolved, validated batch definition.
type Spec struct {
	Replications   int                `json:"replications"`
	Params         dispatch.SimParams `json:"params"`
	TolerancePct   float64            `json:"tolerance_pct"`
	BaseSeed       int64              `json:"base_seed"`
	SerialBaseline bool               `json:"serial_baseline"`
}

// Resolve merges req over defaults and validates the result. When no base
// seed is supplied it is derived from the current time; it is always echoed
// in responses, logs and the report so the batch can be reproduced.
func Resolve(req Request, d config.RunDefaults, now time.Time) (Spec, error) {
	s := Spec{
		Replications:   d.Replications,
		Params:         dispatch.SimParams{Lambda: d.Lambda, Mu: d.Mu, SimTime: d.SimTime, WarmupTime: d.WarmupTime},
		TolerancePct:   d.TolerancePct,
		BaseSeed:       now.UnixMilli(),
		SerialBaseline: d.SerialBaseline,
	}
	if req.Replications != nil {
		s.Replications = *req.Replications
	}
	if req.Lambda != nil {
		s.Params.Lambda = *req.Lambda
	}
	if req.Mu != nil {
		s.Params.Mu = *req.Mu
	}
	if req.SimTime != nil {
		s.Params.SimTime = *req.SimTime
	}
	if req.WarmupTime != nil {
		s.Params.WarmupTime = *req.WarmupTime
	}
	if req.TolerancePct != nil {
		s.TolerancePct = *req.TolerancePct
	}
	if req.BaseSeed != nil {
		s.BaseSeed = *req.BaseSeed
	}
	if req.SerialBaseline != nil {
		s.SerialBaseline = *req.SerialBaseline
	}

	p := s.Params
	finite := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
	switch {
	case s.Replications < 2 || s.Replications > MaxReplications:
		return s, invalid("replications must be between 2 and %d, got %d", MaxReplications, s.Replications)
	case !finite(p.Lambda) || p.Lambda <= 0:
		return s, invalid("lambda must be a positive number, got %v", p.Lambda)
	case !finite(p.Mu) || p.Mu <= 0:
		return s, invalid("mu must be a positive number, got %v", p.Mu)
	case p.Lambda >= p.Mu:
		return s, invalid("unstable system: rho = lambda/mu = %.4f must be < 1", p.Lambda/p.Mu)
	case !finite(p.WarmupTime) || p.WarmupTime < 0:
		return s, invalid("warmup_time must be >= 0, got %v", p.WarmupTime)
	case !finite(p.SimTime) || p.SimTime <= p.WarmupTime:
		return s, invalid("sim_time (%v) must be greater than warmup_time (%v)", p.SimTime, p.WarmupTime)
	case !finite(s.TolerancePct) || s.TolerancePct <= 0:
		return s, invalid("tolerance_pct must be > 0, got %v", s.TolerancePct)
	case s.BaseSeed < 0 || s.BaseSeed > math.MaxInt64-int64(s.Replications):
		return s, invalid("base_seed must be >= 0 and leave room for %d seeds", s.Replications)
	}
	return s, nil
}

// Phase is the stage a batch is in.
type Phase string

const (
	PhaseDistributed Phase = "distributed"
	PhaseSerial      Phase = "serial_baseline"
	PhaseComplete    Phase = "complete"
)

// Batch is one run request and its progress.
type Batch struct {
	ID          string
	Coordinator string // id of the node that received POST /run
	Spec        Spec
	Peers       []peers.Peer
	StartedAt   time.Time

	theory      stats.MM1Theory
	distributed *dispatch.Tracker
	done        chan struct{}

	mu              sync.Mutex
	phase           Phase
	finishedAt      time.Time
	distributedDone bool
	distributedWall time.Duration
	serial          *dispatch.Tracker
	serialPeer      string
	serialStart     time.Time
	serialWall      time.Duration
	serialNote      string
}

// Done is closed when the batch (including any serial baseline) has finished.
func (b *Batch) Done() <-chan struct{} { return b.done }

func (b *Batch) finished() bool {
	select {
	case <-b.done:
		return true
	default:
		return false
	}
}

// Manager starts batches coordinated by this node and keeps them in memory
// for /status and /report.
type Manager struct {
	ctx          context.Context
	dispatcher   *dispatch.Dispatcher
	peers        []peers.Peer
	selfID       string
	defaults     config.RunDefaults
	phaseTimeout time.Duration
	logger       *slog.Logger

	mu      sync.Mutex
	batches map[string]*Batch
	latest  *Batch
}

// NewManager creates a Manager for the node selfID, which must be in
// peerList. Cancelling ctx stops running batches.
func NewManager(ctx context.Context, d *dispatch.Dispatcher, peerList []peers.Peer, selfID string,
	defaults config.RunDefaults, phaseTimeout time.Duration, logger *slog.Logger) *Manager {
	return &Manager{
		ctx:          ctx,
		dispatcher:   d,
		peers:        peerList,
		selfID:       selfID,
		defaults:     defaults,
		phaseTimeout: phaseTimeout,
		logger:       logger,
		batches:      make(map[string]*Batch),
	}
}

// Start validates req and launches a batch in the background. Only one batch
// runs per coordinating node at a time so its timing measurements are not
// distorted; a concurrent request gets ErrBusy together with the running
// batch. (Other nodes may still coordinate batches of their own.)
func (m *Manager) Start(req Request) (*Batch, error) {
	now := time.Now()
	spec, err := Resolve(req, m.defaults, now)
	if err != nil {
		return nil, err
	}
	theory, err := stats.MM1(spec.Params.Lambda, spec.Params.Mu)
	if err != nil {
		return nil, invalid("%v", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.latest != nil && !m.latest.finished() {
		return m.latest, ErrBusy
	}

	m.evictOldLocked()

	id := newBatchID(m.selfID, now)
	b := &Batch{
		ID:          id,
		Coordinator: m.selfID,
		Spec:        spec,
		Peers:       m.peers,
		StartedAt:   now,
		theory:      theory,
		distributed: dispatch.NewTracker(dispatch.GenerateTasks(id, spec.Replications, spec.BaseSeed, spec.Params)),
		done:        make(chan struct{}),
		phase:       PhaseDistributed,
	}
	m.batches[id] = b
	m.latest = b
	go m.execute(b)
	return b, nil
}

// Get returns the batch with the given id, or the most recent batch if id is empty.
func (m *Manager) Get(id string) (*Batch, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == "" {
		return m.latest, m.latest != nil
	}
	b, ok := m.batches[id]
	return b, ok
}

// evictOldLocked drops the oldest finished batches so that, with the batch
// about to be added, at most MaxRetainedBatches remain. m.mu must be held.
func (m *Manager) evictOldLocked() {
	for len(m.batches) >= MaxRetainedBatches {
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

// newBatchID embeds the coordinating node's id so batch and task ids are
// unique across the whole pool, not just on one node.
func newBatchID(nodeID string, now time.Time) string {
	var buf [3]byte
	_, _ = rand.Read(buf[:])
	return fmt.Sprintf("batch-%s-%s-%s", nodeID, now.UTC().Format("20060102T150405"), hex.EncodeToString(buf[:]))
}

func (m *Manager) execute(b *Batch) {
	defer close(b.done)
	log := m.logger.With("batch_id", b.ID)
	log.Info("batch started",
		"coordinator", b.Coordinator,
		"replications", b.Spec.Replications,
		"base_seed", b.Spec.BaseSeed,
		"seed_scheme", dispatch.SeedScheme,
		"lambda", b.Spec.Params.Lambda,
		"mu", b.Spec.Params.Mu,
		"sim_time", b.Spec.Params.SimTime,
		"warmup_time", b.Spec.Params.WarmupTime,
		"peers", len(b.Peers),
		"serial_baseline", b.Spec.SerialBaseline,
	)

	ctx, cancel := context.WithTimeout(m.ctx, m.phaseTimeout)
	wall := m.dispatcher.Run(ctx, b.Peers, b.distributed)
	cancel()

	c := b.distributed.Counts()
	log.Info("distributed phase finished",
		"wall_clock_seconds", wall.Seconds(),
		"complete", c.Complete, "failed", c.Failed, "failed_attempts", c.FailedAttempts)

	b.mu.Lock()
	b.distributedDone = true
	b.distributedWall = wall
	b.mu.Unlock()

	if b.Spec.SerialBaseline && m.ctx.Err() == nil {
		m.runSerialBaseline(b, log)
	}

	b.mu.Lock()
	b.phase = PhaseComplete
	b.finishedAt = time.Now()
	b.mu.Unlock()

	r := b.Report()
	attrs := []any{"verdict", r.Verdict, "detail", r.VerdictDetail,
		"distributed_wall_clock_seconds", r.Timing.DistributedWallSeconds}
	if r.Timing.SerialWallSeconds != nil && r.Timing.Speedup != nil {
		attrs = append(attrs, "serial_wall_clock_seconds", *r.Timing.SerialWallSeconds, "speedup", *r.Timing.Speedup)
	}
	log.Info("batch complete", attrs...)
}

// runSerialBaseline re-runs the batch's seeds on the coordinating node alone,
// one task at a time, to measure what the same work costs without the rest of
// the pool. Because the seeds are identical, its results must also match the
// distributed ones.
func (m *Manager) runSerialBaseline(b *Batch, log *slog.Logger) {
	var self peers.Peer
	for _, p := range b.Peers {
		if p.ID == m.selfID {
			self = p
		}
	}
	if self.ID == "" {
		b.mu.Lock()
		b.serialNote = "serial baseline skipped: coordinating node is not in the peer list"
		b.mu.Unlock()
		log.Warn("serial baseline skipped: self not in peer list")
		return
	}

	tr := dispatch.NewTracker(dispatch.GenerateTasks(b.ID+"-serial", b.Spec.Replications, b.Spec.BaseSeed, b.Spec.Params))
	b.mu.Lock()
	b.phase = PhaseSerial
	b.serial = tr
	b.serialPeer = self.ID
	b.serialStart = time.Now()
	b.mu.Unlock()
	log.Info("serial baseline started", "peer_id", self.ID)

	ctx, cancel := context.WithTimeout(m.ctx, m.phaseTimeout)
	defer cancel()
	wall := m.dispatcher.Run(ctx, []peers.Peer{self}, tr)

	b.mu.Lock()
	b.serialWall = wall
	b.mu.Unlock()
	log.Info("serial baseline finished", "peer_id", self.ID, "wall_clock_seconds", wall.Seconds())
}
