// Package runs submits batches to a coordinating node, records them, and
// tracks each one in the background until it completes or its coordinator
// is lost. Live status and report reads fall back to stored snapshots.
package runs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/store"
)

// maxSafeInteger keeps seeds exact in JavaScript (Number.MAX_SAFE_INTEGER).
const maxSafeInteger = 1<<53 - 1

// CreateRequest is the POST /api/runs body. Omitted fields take the defaults.
type CreateRequest struct {
	Coordinator string `json:"coordinator"`
	// Kind "network" runs Scenario (a topology with traffic) instead of M/M/1;
	// only Replications and BaseSeed apply then.
	Kind           string          `json:"kind"`
	Scenario       json.RawMessage `json:"scenario"`
	Replications   *int            `json:"replications"`
	Lambda         *float64        `json:"lambda"`
	Mu             *float64        `json:"mu"`
	SimTime        *float64        `json:"sim_time"`
	WarmupTime     *float64        `json:"warmup_time"`
	TolerancePct   *float64        `json:"tolerance_pct"`
	BaseSeed       *int64          `json:"base_seed"`
	SerialBaseline *bool           `json:"serial_baseline"`
}

type Created struct {
	RunID string `json:"run_id"`
	nodeclient.RunStarted
}

// ValidationError is a request the gateway rejects before contacting a node.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

// AcceptedError means the node started the batch but the gateway could not
// record it. The batch is running; only the history entry is missing.
type AcceptedError struct {
	Created Created
	Err     error
}

func (e *AcceptedError) Error() string {
	return "the coordinator accepted the run but the gateway could not record it: " + e.Err.Error()
}

func (e *AcceptedError) Unwrap() error { return e.Err }

type Options struct {
	Store        *store.Store
	Nodes        *nodeclient.Client
	Peers        *config.PeerSource
	Defaults     config.RunDefaults
	PollInterval time.Duration
	LostAfter    int
	HistoryLimit int
	MaxTrackers  int
	Log          *slog.Logger
}

type Manager struct {
	opts   Options
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	slots  chan struct{}

	mu       sync.Mutex
	tracking map[string]bool
}

func New(opts Options) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		opts:     opts,
		ctx:      ctx,
		cancel:   cancel,
		slots:    make(chan struct{}, max(1, opts.MaxTrackers)),
		tracking: map[string]bool{},
	}
}

// EncodeRunID is the unpadded base64url form of ["coordinator","batch_id"].
func EncodeRunID(coordinator, batchID string) string {
	raw, _ := json.Marshal([]string{coordinator, batchID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Resolve fills omitted fields from the defaults. BaseSeed stays nil when
// omitted: the node then picks one and reports it back.
func Resolve(req CreateRequest, d config.RunDefaults) (store.Params, *int64) {
	p := store.Params{
		Replications: d.Replications, Lambda: d.Lambda, Mu: d.Mu, SimTime: d.SimTime,
		WarmupTime: d.WarmupTime, TolerancePct: d.TolerancePct, SerialBaseline: d.SerialBaseline,
	}
	set := func(dst *float64, v *float64) {
		if v != nil {
			*dst = *v
		}
	}
	if req.Replications != nil {
		p.Replications = *req.Replications
	}
	set(&p.Lambda, req.Lambda)
	set(&p.Mu, req.Mu)
	set(&p.SimTime, req.SimTime)
	set(&p.WarmupTime, req.WarmupTime)
	set(&p.TolerancePct, req.TolerancePct)
	if req.SerialBaseline != nil {
		p.SerialBaseline = *req.SerialBaseline
	}
	if req.BaseSeed != nil {
		p.BaseSeed = *req.BaseSeed
	}
	return p, req.BaseSeed
}

// Validate mirrors the frontend and node rules (docs/gateway-api.md).
func Validate(p store.Params, seed *int64) error {
	finitePositive := func(v float64) bool { return v > 0 && !math.IsInf(v, 0) && !math.IsNaN(v) }
	switch {
	case p.Replications < 2 || p.Replications > 100_000:
		return &ValidationError{"replications must be a whole number from 2 to 100000"}
	case !finitePositive(p.Lambda):
		return &ValidationError{"lambda must be a positive finite number"}
	case !finitePositive(p.Mu):
		return &ValidationError{"mu must be a positive finite number"}
	case p.Lambda >= p.Mu:
		return &ValidationError{"lambda must be less than mu (unstable queue)"}
	case !finitePositive(p.SimTime):
		return &ValidationError{"sim_time must be a positive finite number"}
	case math.IsNaN(p.WarmupTime) || p.WarmupTime < 0 || p.WarmupTime >= p.SimTime:
		return &ValidationError{"warmup_time must be at least 0 and less than sim_time"}
	case !finitePositive(p.TolerancePct):
		return &ValidationError{"tolerance_pct must be a positive finite number"}
	case seed != nil && (*seed < 0 || *seed > maxSafeInteger-int64(p.Replications)):
		return &ValidationError{"base_seed must be a nonnegative safe integer with room for every replication"}
	}
	return nil
}

// resolveNetwork checks a network run request. The node validates the
// scenario itself (with the simulator), so only its presence is checked here.
func resolveNetwork(req CreateRequest) (store.Params, *int64, error) {
	p := store.Params{Kind: "network", Scenario: req.Scenario, Replications: 30}
	if req.Replications != nil {
		p.Replications = *req.Replications
	}
	if req.BaseSeed != nil {
		p.BaseSeed = *req.BaseSeed
	}
	switch {
	case len(req.Scenario) == 0 || string(req.Scenario) == "null":
		return p, nil, &ValidationError{"scenario is required for a network run"}
	case len(req.Scenario) > 512<<10:
		return p, nil, &ValidationError{"scenario is larger than 512 KiB"}
	case p.Replications < 2 || p.Replications > 10_000:
		return p, nil, &ValidationError{"replications must be a whole number from 2 to 10000"}
	case req.BaseSeed != nil && (*req.BaseSeed < 0 || *req.BaseSeed > maxSafeInteger-int64(p.Replications)):
		return p, nil, &ValidationError{"base_seed must be a nonnegative safe integer with room for every replication"}
	}
	return p, req.BaseSeed, nil
}

// Create starts a batch on the requested coordinator and begins tracking it.
func (m *Manager) Create(ctx context.Context, req CreateRequest) (Created, error) {
	var params store.Params
	var seed *int64
	switch req.Kind {
	case "", "mm1":
		params, seed = Resolve(req, m.opts.Defaults)
		if err := Validate(params, seed); err != nil {
			return Created{}, err
		}
	case "network":
		var err error
		if params, seed, err = resolveNetwork(req); err != nil {
			return Created{}, err
		}
	default:
		return Created{}, &ValidationError{fmt.Sprintf("unknown run kind %q", req.Kind)}
	}
	peer, ok := m.opts.Peers.Lookup(req.Coordinator)
	if !ok {
		return Created{}, &ValidationError{fmt.Sprintf("unknown coordinator %q", req.Coordinator)}
	}
	var started nodeclient.RunStarted
	var err error
	if params.Kind == "network" {
		started, err = m.opts.Nodes.NetRun(ctx, peer.URL, nodeclient.NetRunRequest{
			Scenario: params.Scenario, Replications: &params.Replications, BaseSeed: seed,
		})
	} else {
		started, err = m.opts.Nodes.Run(ctx, peer.URL, nodeclient.RunRequest{
			Replications: &params.Replications, Lambda: &params.Lambda, Mu: &params.Mu,
			SimTime: &params.SimTime, WarmupTime: &params.WarmupTime, TolerancePct: &params.TolerancePct,
			BaseSeed: seed, SerialBaseline: &params.SerialBaseline,
		})
	}
	if err != nil {
		return Created{}, err
	}
	params.BaseSeed = started.BaseSeed
	params.Replications = started.Replications
	created := Created{RunID: EncodeRunID(peer.ID, started.BatchID), RunStarted: started}
	created.Coordinator = peer.ID

	run := store.Run{
		RunID: created.RunID, BatchID: started.BatchID, Coordinator: peer.ID,
		CreatedAt: time.Now().UTC(), Params: params, State: store.StateRunning,
	}
	// The node has accepted the run, so record it even if the client went away.
	if err := m.opts.Store.Insert(context.WithoutCancel(ctx), run); err != nil {
		return created, &AcceptedError{Created: created, Err: err}
	}
	if n, err := m.opts.Store.Prune(context.WithoutCancel(ctx), m.opts.HistoryLimit); err != nil {
		m.opts.Log.Error("prune history", "err", err)
	} else if n > 0 {
		m.opts.Log.Info("pruned run history", "removed", n)
	}
	m.track(run)
	return created, nil
}

// Resume starts trackers for runs left running by a previous gateway process.
func (m *Manager) Resume(ctx context.Context) error {
	running, err := m.opts.Store.ListByState(ctx, store.StateRunning)
	if err != nil {
		return err
	}
	for _, run := range running {
		m.track(run)
	}
	if len(running) > 0 {
		m.opts.Log.Info("resumed tracking", "runs", len(running))
	}
	return nil
}

// Shutdown stops every tracker and waits for them to exit.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.cancel()
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Tracking reports how many runs currently have a tracker.
func (m *Manager) Tracking() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.tracking)
}

func (m *Manager) track(run store.Run) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tracking[run.RunID] || m.ctx.Err() != nil {
		return
	}
	m.tracking[run.RunID] = true
	m.wg.Add(1)
	go m.trackLoop(run)
}

func (m *Manager) trackLoop(run store.Run) {
	defer m.wg.Done()
	defer func() {
		m.mu.Lock()
		delete(m.tracking, run.RunID)
		m.mu.Unlock()
	}()
	select {
	case m.slots <- struct{}{}:
		defer func() { <-m.slots }()
	case <-m.ctx.Done():
		return
	}
	log := m.opts.Log.With("run_id", run.RunID, "batch_id", run.BatchID, "coordinator", run.Coordinator)
	ticker := time.NewTicker(m.opts.PollInterval)
	defer ticker.Stop()
	failures := 0
	for {
		if m.pollOnce(run, &failures, log) {
			return
		}
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pollOnce fetches the coordinator's status once and records it. It returns
// true when tracking should stop.
func (m *Manager) pollOnce(run store.Run, failures *int, log *slog.Logger) bool {
	ctx := m.ctx
	status, err := m.liveStatus(ctx, run)
	if err != nil {
		if ctx.Err() != nil {
			return true
		}
		if nodeclient.IsStatus(err, 404) {
			log.Warn("coordinator no longer knows the batch; marking coordinator_lost")
			return m.markLost(run, log)
		}
		*failures++
		log.Debug("status poll failed", "failures", *failures, "err", err)
		if *failures >= m.opts.LostAfter {
			log.Warn("coordinator unreachable; marking coordinator_lost", "failures", *failures, "err", err)
			return m.markLost(run, log)
		}
		return false
	}
	*failures = 0
	if nodeState(status) == store.StateComplete {
		m.finish(ctx, run, status, log)
		return true
	}
	if err := m.opts.Store.Update(ctx, run.RunID, store.StateRunning, status, nil); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return true // pruned from history
		}
		log.Error("store status", "err", err)
	}
	return false
}

func (m *Manager) finish(ctx context.Context, run store.Run, status json.RawMessage, log *slog.Logger) {
	var report json.RawMessage
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if report, err = m.liveReport(ctx, run); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(m.opts.PollInterval):
		}
	}
	if err != nil {
		log.Error("batch complete but the final report could not be fetched", "err", err)
	}
	if err := m.opts.Store.Update(ctx, run.RunID, store.StateComplete, status, report); err != nil {
		log.Error("store final report", "err", err)
		return
	}
	log.Info("batch complete")
}

func (m *Manager) markLost(run store.Run, log *slog.Logger) bool {
	if err := m.opts.Store.Update(m.ctx, run.RunID, store.StateCoordinatorLost, nil, nil); err != nil &&
		!errors.Is(err, store.ErrNotFound) {
		log.Error("store coordinator_lost", "err", err)
	}
	return true
}

func (m *Manager) liveStatus(ctx context.Context, run store.Run) (json.RawMessage, error) {
	peer, ok := m.opts.Peers.Lookup(run.Coordinator)
	if !ok {
		return nil, &nodeclient.Error{Kind: nodeclient.KindUnreachable, Message: "coordinator is no longer in the peer list"}
	}
	return m.opts.Nodes.Status(ctx, peer.URL, run.BatchID)
}

func (m *Manager) liveReport(ctx context.Context, run store.Run) (json.RawMessage, error) {
	peer, ok := m.opts.Peers.Lookup(run.Coordinator)
	if !ok {
		return nil, &nodeclient.Error{Kind: nodeclient.KindUnreachable, Message: "coordinator is no longer in the peer list"}
	}
	return m.opts.Nodes.Report(ctx, peer.URL, run.BatchID)
}

func (m *Manager) Get(ctx context.Context, runID string) (store.Run, error) {
	return m.opts.Store.Get(ctx, runID)
}

func (m *Manager) List(ctx context.Context, limit, offset int) ([]store.Run, int, error) {
	return m.opts.Store.List(ctx, limit, offset)
}

// Status returns the coordinator's live status with "stale": false, or the
// last stored snapshot with "stale": true when the coordinator cannot answer.
func (m *Manager) Status(ctx context.Context, runID string) (json.RawMessage, error) {
	run, err := m.opts.Store.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.State == store.StateComplete && run.Status != nil {
		return withStale(run.Status, false) // final; the node may have evicted the batch
	}
	live, err := m.liveStatus(ctx, run)
	if err == nil {
		if run.State != store.StateRunning {
			// The coordinator came back and still knows the batch.
			if err := m.opts.Store.Update(ctx, run.RunID, store.StateRunning, live, nil); err == nil {
				m.opts.Log.Info("coordinator answered again; resuming tracking", "run_id", run.RunID)
				m.track(run)
			}
		}
		return withStale(live, false)
	}
	if nodeclient.IsStatus(err, 404) && run.State == store.StateRunning {
		m.markLost(run, m.opts.Log.With("run_id", run.RunID))
	}
	if run.Status != nil {
		return withStale(run.Status, true)
	}
	return nil, err
}

// Report returns the final stored report, the coordinator's live (possibly
// provisional) report, or a previously stored report marked stale.
func (m *Manager) Report(ctx context.Context, runID string) (json.RawMessage, error) {
	run, err := m.opts.Store.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.State == store.StateComplete && run.Report != nil {
		return withStale(run.Report, false)
	}
	live, err := m.liveReport(ctx, run)
	if err == nil {
		return withStale(live, false)
	}
	if run.Report != nil {
		return withStale(run.Report, true)
	}
	return nil, err
}

func nodeState(status json.RawMessage) string {
	var s struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(status, &s)
	return s.State
}

// withStale adds a top-level "stale" field to a JSON object.
func withStale(body json.RawMessage, stale bool) (json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return nil, fmt.Errorf("stored snapshot is not a JSON object: %w", err)
	}
	obj["stale"] = json.RawMessage(fmt.Sprint(stale))
	return json.Marshal(obj)
}
