package pdes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/p2p-sim/node/internal/peers"
)

var ErrCoordinatorBusy = errors.New("a partitioned run is already coordinating on this node")

type RunRequest struct {
	Scenario json.RawMessage `json:"scenario"`
	Parts    *int            `json:"parts"`
	BaseSeed *int64          `json:"base_seed"`
	Baseline *bool           `json:"baseline"`
}

type Planner interface {
	Plan(context.Context, []byte, int) (Plan, error)
	Merge(context.Context, []byte, []json.RawMessage) (json.RawMessage, error)
}

type HealthChecker interface {
	Health(context.Context, peers.Peer) error
}

type PartitionTiming struct {
	ComputeS float64 `json:"compute_s"`
	WaitS    float64 `json:"wait_s"`
	Messages int64   `json:"messages"`
	Bytes    int64   `json:"bytes"`
}

type Status struct {
	Kind          string                     `json:"kind"`
	BatchID       string                     `json:"batch_id"`
	Coordinator   string                     `json:"coordinator"`
	State         string                     `json:"state"`
	Phase         string                     `json:"phase"`
	SimulatedTime float64                    `json:"simulated_time"`
	WindowsDone   int                        `json:"windows_done"`
	WindowsTotal  int                        `json:"windows_total"`
	Partitions    map[string]PartitionTiming `json:"partitions"`
	FailedNode    string                     `json:"failed_node,omitempty"`
	Error         string                     `json:"error,omitempty"`
}

type Report struct {
	Kind             string                     `json:"kind"`
	BatchID          string                     `json:"batch_id"`
	Coordinator      string                     `json:"coordinator"`
	State            string                     `json:"state"`
	Phase            string                     `json:"phase"`
	Scenario         json.RawMessage            `json:"scenario"`
	Seed             int64                      `json:"base_seed"`
	Plan             Plan                       `json:"plan"`
	Metrics          json.RawMessage            `json:"metrics,omitempty"`
	BaselineMetrics  json.RawMessage            `json:"baseline_metrics,omitempty"`
	ResultsIdentical *bool                      `json:"results_identical,omitempty"`
	FirstDifference  string                     `json:"first_difference,omitempty"`
	Speedup          *float64                   `json:"speedup,omitempty"`
	PartitionWallS   float64                    `json:"partitioned_wall_seconds"`
	BaselineWallS    float64                    `json:"baseline_wall_seconds,omitempty"`
	Partitions       map[string]PartitionTiming `json:"partitions"`
	FailedNode       string                     `json:"failed_node,omitempty"`
	Error            string                     `json:"error,omitempty"`
}

type nodeFailure struct {
	node string
	err  error
}

func (e *nodeFailure) Error() string { return fmt.Sprintf("%s: %v", e.node, e.err) }
func (e *nodeFailure) Unwrap() error { return e.err }

type Manager struct {
	ctx          context.Context
	planner      Planner
	host         *Host
	peers        []peers.Peer
	selfID       string
	health       HealthChecker
	remote       *PeerClient
	stepTimeout  time.Duration
	phaseTimeout time.Duration

	mu     sync.Mutex
	runs   map[string]*Run
	latest *Run
}

func NewManager(ctx context.Context, planner Planner, host *Host, peerList []peers.Peer, selfID string,
	health HealthChecker, remote *PeerClient, stepTimeout, phaseTimeout time.Duration) *Manager {
	if stepTimeout <= 0 {
		stepTimeout = 30 * time.Second
	}
	if phaseTimeout <= 0 {
		phaseTimeout = time.Hour
	}
	return &Manager{
		ctx: ctx, planner: planner, host: host, peers: peerList, selfID: selfID,
		health: health, remote: remote, stepTimeout: stepTimeout, phaseTimeout: phaseTimeout,
		runs: make(map[string]*Run),
	}
}

type Run struct {
	ID          string
	Coordinator string
	Scenario    json.RawMessage
	Seed        int64
	Plan        Plan
	Baseline    bool
	StartedAt   time.Time

	mu               sync.Mutex
	state            string
	phase            string
	simulatedTime    float64
	windowsDone      int
	failedNode       string
	err              string
	metrics          json.RawMessage
	baselineMetrics  json.RawMessage
	resultsIdentical *bool
	firstDifference  string
	speedup          *float64
	partitionWall    float64
	baselineWall     float64
	partitions       map[string]PartitionTiming
	done             chan struct{}
}

func (r *Run) Done() <-chan struct{} { return r.done }

func (r *Run) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Status{
		Kind: "pdes", BatchID: r.ID, Coordinator: r.Coordinator, State: r.state, Phase: r.phase,
		SimulatedTime: r.simulatedTime, WindowsDone: r.windowsDone, WindowsTotal: r.Plan.Windows,
		Partitions: cloneTimings(r.partitions), FailedNode: r.failedNode, Error: r.err,
	}
}

func (r *Run) Report() Report {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Report{
		Kind: "pdes", BatchID: r.ID, Coordinator: r.Coordinator, State: r.state, Phase: r.phase,
		Scenario: r.Scenario, Seed: r.Seed, Plan: r.Plan, Metrics: cloneRaw(r.metrics),
		BaselineMetrics: cloneRaw(r.baselineMetrics), ResultsIdentical: r.resultsIdentical,
		FirstDifference: r.firstDifference, Speedup: r.speedup,
		PartitionWallS: r.partitionWall, BaselineWallS: r.baselineWall,
		Partitions: cloneTimings(r.partitions), FailedNode: r.failedNode, Error: r.err,
	}
}

func cloneTimings(src map[string]PartitionTiming) map[string]PartitionTiming {
	dst := make(map[string]PartitionTiming, len(src))
	for key, value := range src {
		dst[key] = value
	}
	return dst
}

func cloneRaw(src json.RawMessage) json.RawMessage {
	if src == nil {
		return nil
	}
	return append(json.RawMessage(nil), src...)
}

func (m *Manager) Get(id string) (*Run, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[id]
	return run, ok
}

func (m *Manager) Plan(ctx context.Context, scenario json.RawMessage, parts int) (Plan, error) {
	if len(scenario) == 0 || string(scenario) == "null" {
		return Plan{}, errors.New("scenario is required")
	}
	healthy, err := m.healthyPeers(ctx)
	if err != nil {
		return Plan{}, err
	}
	if parts == 0 {
		parts = len(healthy)
	}
	if parts < 1 || parts > len(healthy) {
		return Plan{}, fmt.Errorf("parts must be between 1 and the %d healthy nodes", len(healthy))
	}
	return m.planner.Plan(ctx, scenario, parts)
}

func (m *Manager) Start(ctx context.Context, req RunRequest) (*Run, error) {
	if len(req.Scenario) == 0 || string(req.Scenario) == "null" {
		return nil, errors.New("scenario is required")
	}
	if len(req.Scenario) > 4<<20 {
		return nil, errors.New("scenario is larger than 4 MiB")
	}
	healthy, err := m.healthyPeers(ctx)
	if err != nil {
		return nil, err
	}
	parts := len(healthy)
	if req.Parts != nil {
		parts = *req.Parts
	}
	if parts < 1 || parts > len(healthy) {
		return nil, fmt.Errorf("parts must be between 1 and the %d healthy nodes", len(healthy))
	}
	plan, err := m.planner.Plan(ctx, req.Scenario, parts)
	if err != nil {
		return nil, err
	}
	seed := time.Now().UnixMilli()
	if req.BaseSeed != nil {
		seed = *req.BaseSeed
	}
	if seed < 0 {
		return nil, errors.New("base_seed must be >= 0")
	}
	baseline := true
	if req.Baseline != nil {
		baseline = *req.Baseline
	}
	participants := selectParticipants(healthy, m.selfID, parts)
	if len(participants) != parts || participants[0].ID != m.selfID {
		return nil, errors.New("coordinator must be a healthy participant")
	}
	now := time.Now()
	run := &Run{
		ID: makeRunID(m.selfID, now), Coordinator: m.selfID, Scenario: cloneRaw(req.Scenario),
		Seed: seed, Plan: plan, Baseline: baseline, StartedAt: now,
		state: "running", phase: "planning", partitions: make(map[string]PartitionTiming),
		done: make(chan struct{}),
	}
	for _, participant := range participants {
		run.partitions[participant.ID] = PartitionTiming{}
	}
	m.mu.Lock()
	if m.latest != nil && m.latest.Status().State == "running" {
		m.mu.Unlock()
		return nil, ErrCoordinatorBusy
	}
	m.runs[run.ID] = run
	m.latest = run
	m.mu.Unlock()
	go m.execute(run, participants)
	return run, nil
}

func selectParticipants(healthy []peers.Peer, selfID string, count int) []peers.Peer {
	selected := make([]peers.Peer, 0, count)
	for _, peer := range healthy {
		if peer.ID == selfID {
			selected = append(selected, peer)
			break
		}
	}
	for _, peer := range healthy {
		if len(selected) == count {
			break
		}
		if peer.ID != selfID {
			selected = append(selected, peer)
		}
	}
	return selected
}

func (m *Manager) healthyPeers(ctx context.Context) ([]peers.Peer, error) {
	selfFound := false
	healthy := make([]peers.Peer, 0, len(m.peers))
	var wait sync.WaitGroup
	results := make([]bool, len(m.peers))
	for i, peer := range m.peers {
		if peer.ID == m.selfID {
			selfFound = true
			results[i] = true
			continue
		}
		wait.Add(1)
		go func(index int, candidate peers.Peer) {
			defer wait.Done()
			results[index] = m.health.Health(ctx, candidate) == nil
		}(i, peer)
	}
	wait.Wait()
	if !selfFound {
		return nil, fmt.Errorf("coordinator %q is not in the peer list", m.selfID)
	}
	for i, peer := range m.peers {
		if results[i] {
			healthy = append(healthy, peer)
		}
	}
	return healthy, nil
}

func makeRunID(nodeID string, now time.Time) string {
	return fmt.Sprintf("pdes-%s-%s", nodeID, now.UTC().Format("20060102T150405.000000000"))
}

func (m *Manager) execute(run *Run, participants []peers.Peer) {
	defer close(run.done)
	ctx, cancel := context.WithTimeout(m.ctx, m.phaseTimeout)
	defer cancel()
	started := time.Now()
	opened := make([]bool, len(participants))
	openErr := m.openWorkers(ctx, run, participants, opened)
	if openErr != nil {
		m.fail(run, participants, opened, openErr)
		return
	}
	run.mu.Lock()
	run.phase = "running"
	run.mu.Unlock()

	owners := make(map[string]int, len(run.Plan.Assignment))
	for node, part := range run.Plan.Assignment {
		if part >= 0 && part < len(participants) {
			owners[node] = part
		}
	}
	inbound := make([][]ArrivalRecord, len(participants))
	current := 0.0
	for window := 0; window < run.Plan.Windows; window++ {
		until := math.Min(run.Plan.Lookahead*float64(window+1), scenarioDuration(run.Scenario))
		if until <= current {
			break
		}
		responses, elapsed, err := m.stepWorkers(ctx, run, participants, inbound, until)
		if err != nil {
			m.fail(run, participants, opened, err)
			return
		}
		nextInbound := make([][]ArrivalRecord, len(participants))
		for source, response := range responses {
			for _, record := range response.Outbound {
				target, ok := owners[record.To]
				if !ok || target == source {
					m.fail(run, participants, opened, fmt.Errorf("worker %s returned invalid outbound destination %q", participants[source].ID, record.To))
					return
				}
				nextInbound[target] = append(nextInbound[target], record)
				encoded, _ := json.Marshal(record)
				run.mu.Lock()
				timing := run.partitions[participants[source].ID]
				timing.Messages++
				timing.Bytes += int64(len(encoded))
				run.partitions[participants[source].ID] = timing
				run.mu.Unlock()
			}
		}
		for part := range nextInbound {
			sort.Slice(nextInbound[part], func(i, j int) bool {
				a, b := nextInbound[part][i], nextInbound[part][j]
				if a.Arrive != b.Arrive {
					return a.Arrive < b.Arrive
				}
				if a.Link != b.Link {
					return a.Link < b.Link
				}
				if a.Flow != b.Flow {
					return a.Flow < b.Flow
				}
				return a.Seq < b.Seq
			})
		}
		inbound = nextInbound
		current = until
		slowest := elapsed[0]
		for _, d := range elapsed[1:] {
			if d > slowest {
				slowest = d
			}
		}
		run.mu.Lock()
		run.windowsDone++
		run.simulatedTime = until
		for i, duration := range elapsed {
			timing := run.partitions[participants[i].ID]
			timing.WaitS += (slowest - duration).Seconds()
			run.partitions[participants[i].ID] = timing
		}
		run.mu.Unlock()
	}

	finished, err := m.finishWorkers(ctx, run.ID, participants)
	if err != nil {
		m.fail(run, participants, opened, err)
		return
	}
	states := make([]json.RawMessage, len(finished))
	for i, reply := range finished {
		states[i] = reply.State
	}
	metrics, err := m.planner.Merge(ctx, run.Scenario, states)
	if err != nil {
		m.fail(run, participants, opened, fmt.Errorf("merge partition metrics: %w", err))
		return
	}
	run.mu.Lock()
	run.metrics = metrics
	run.partitionWall = time.Since(started).Seconds()
	run.phase = "complete"
	run.state = "complete"
	run.mu.Unlock()
	if run.Baseline {
		run.mu.Lock()
		run.phase = "baseline"
		run.state = "running"
		run.mu.Unlock()
		m.runBaseline(ctx, run, metrics)
	}
}

func scenarioDuration(raw json.RawMessage) float64 {
	var scenario struct {
		Duration float64 `json:"duration"`
	}
	_ = json.Unmarshal(raw, &scenario)
	return scenario.Duration
}

func (m *Manager) openWorkers(ctx context.Context, run *Run, participants []peers.Peer, opened []bool) error {
	var wait sync.WaitGroup
	var mu sync.Mutex
	var first error
	for index, participant := range participants {
		wait.Add(1)
		go func(i int, peer peers.Peer) {
			defer wait.Done()
			err := m.open(ctx, peer, run.ID, OpenRequest{
				Scenario: run.Scenario, Plan: run.Plan, Part: i, Seed: run.Seed,
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil && first == nil {
				first = &nodeFailure{node: peer.ID, err: fmt.Errorf("open partition: %w", err)}
				return
			}
			opened[i] = true
		}(index, participant)
	}
	wait.Wait()
	return first
}

func (m *Manager) stepWorkers(ctx context.Context, run *Run, participants []peers.Peer, inbound [][]ArrivalRecord,
	until float64) ([]StepResponse, []time.Duration, error) {
	responses := make([]StepResponse, len(participants))
	elapsed := make([]time.Duration, len(participants))
	errs := make(chan error, len(participants))
	var wait sync.WaitGroup
	for index, participant := range participants {
		wait.Add(1)
		go func(i int, peer peers.Peer) {
			defer wait.Done()
			stepCtx, cancel := context.WithTimeout(ctx, m.stepTimeout)
			defer cancel()
			start := time.Now()
			records := append([]ArrivalRecord{}, inbound[i]...)
			reply, err := m.step(stepCtx, peer, run.ID, StepRequest{Until: until, Inbound: records})
			elapsed[i] = time.Since(start)
			if err != nil {
				errs <- &nodeFailure{node: peer.ID, err: fmt.Errorf("step at %.6f: %w", until, err)}
				return
			}
			responses[i] = reply
			run.mu.Lock()
			timing := run.partitions[peer.ID]
			timing.ComputeS += reply.ComputeS
			timing.Messages += int64(len(inbound[i]))
			for _, record := range inbound[i] {
				encoded, _ := json.Marshal(record)
				timing.Bytes += int64(len(encoded))
			}
			run.partitions[peer.ID] = timing
			run.mu.Unlock()
		}(index, participant)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			return nil, nil, err
		}
	}
	return responses, elapsed, nil
}

func (m *Manager) finishWorkers(ctx context.Context, runID string, participants []peers.Peer) ([]FinishResponse, error) {
	results := make([]FinishResponse, len(participants))
	errs := make(chan error, len(participants))
	var wait sync.WaitGroup
	for i, peer := range participants {
		wait.Add(1)
		go func(index int, participant peers.Peer) {
			defer wait.Done()
			response, err := m.finish(ctx, participant, runID)
			if err != nil {
				errs <- &nodeFailure{node: participant.ID, err: fmt.Errorf("finish partition: %w", err)}
				return
			}
			results[index] = response
		}(i, peer)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}

func (m *Manager) runBaseline(ctx context.Context, run *Run, distributed json.RawMessage) {
	plan, err := m.planner.Plan(ctx, run.Scenario, 1)
	if err != nil {
		m.setFailed(run, fmt.Errorf("plan baseline: %w", err))
		return
	}
	id := run.ID + "-baseline"
	peer := peers.Peer{ID: m.selfID}
	if err := m.open(ctx, peer, id, OpenRequest{Scenario: run.Scenario, Plan: plan, Part: 0, Seed: run.Seed}); err != nil {
		m.setFailed(run, fmt.Errorf("open baseline: %w", err))
		return
	}
	start := time.Now()
	_, err = m.step(ctx, peer, id, StepRequest{Until: scenarioDuration(run.Scenario), Inbound: []ArrivalRecord{}})
	if err != nil {
		_ = m.delete(peer, id)
		m.setFailed(run, fmt.Errorf("run baseline: %w", err))
		return
	}
	result, err := m.finish(ctx, peer, id)
	if err != nil {
		_ = m.delete(peer, id)
		m.setFailed(run, fmt.Errorf("finish baseline: %w", err))
		return
	}
	wall := time.Since(start).Seconds()
	equal, path, err := compareJSON(distributed, result.Metrics)
	if err != nil {
		m.setFailed(run, fmt.Errorf("compare baseline metrics: %w", err))
		return
	}
	run.mu.Lock()
	run.baselineMetrics = cloneRaw(result.Metrics)
	run.resultsIdentical = &equal
	run.firstDifference = path
	run.baselineWall = wall
	if run.partitionWall > 0 {
		speedup := wall / run.partitionWall
		run.speedup = &speedup
	}
	run.phase, run.state = "complete", "complete"
	run.mu.Unlock()
}

func compareJSON(left, right json.RawMessage) (bool, string, error) {
	var a, b any
	if err := json.Unmarshal(left, &a); err != nil {
		return false, "", err
	}
	if err := json.Unmarshal(right, &b); err != nil {
		return false, "", err
	}
	canonicalA, err := json.Marshal(a)
	if err != nil {
		return false, "", err
	}
	canonicalB, err := json.Marshal(b)
	if err != nil {
		return false, "", err
	}
	if bytes.Equal(canonicalA, canonicalB) {
		return true, "", nil
	}
	return false, firstDifference(a, b, "$"), nil
}

func firstDifference(a, b any, path string) string {
	leftMap, leftOK := a.(map[string]any)
	rightMap, rightOK := b.(map[string]any)
	if leftOK && rightOK {
		keys := make(map[string]struct{}, len(leftMap)+len(rightMap))
		for key := range leftMap {
			keys[key] = struct{}{}
		}
		for key := range rightMap {
			keys[key] = struct{}{}
		}
		ordered := make([]string, 0, len(keys))
		for key := range keys {
			ordered = append(ordered, key)
		}
		sort.Strings(ordered)
		for _, key := range ordered {
			left, leftExists := leftMap[key]
			right, rightExists := rightMap[key]
			if !leftExists || !rightExists {
				return path + "." + key
			}
			if diff := firstDifference(left, right, path+"."+key); diff != "" {
				return diff
			}
		}
		return ""
	}
	leftSlice, leftOK := a.([]any)
	rightSlice, rightOK := b.([]any)
	if leftOK && rightOK {
		if len(leftSlice) != len(rightSlice) {
			return path + ".length"
		}
		for i := range leftSlice {
			if diff := firstDifference(leftSlice[i], rightSlice[i], fmt.Sprintf("%s[%d]", path, i)); diff != "" {
				return diff
			}
		}
		return ""
	}
	if !equalJSONValue(a, b) {
		return path
	}
	return ""
}

func equalJSONValue(a, b any) bool {
	left, err := json.Marshal(a)
	if err != nil {
		return false
	}
	right, err := json.Marshal(b)
	return err == nil && bytes.Equal(left, right)
}

func (m *Manager) fail(run *Run, participants []peers.Peer, opened []bool, err error) {
	var cancel sync.WaitGroup
	for i, peer := range participants {
		if i >= len(opened) || !opened[i] {
			continue
		}
		cancel.Add(1)
		go func(participant peers.Peer) {
			defer cancel.Done()
			_ = m.delete(participant, run.ID)
		}(peer)
	}
	cancel.Wait()
	m.setFailed(run, err)
}

func (m *Manager) setFailed(run *Run, err error) {
	run.mu.Lock()
	run.state, run.phase, run.err = "failed", "failed", err.Error()
	var failed *nodeFailure
	if errors.As(err, &failed) {
		run.failedNode = failed.node
	}
	run.partitionWall = time.Since(run.StartedAt).Seconds()
	run.mu.Unlock()
}

func (m *Manager) open(ctx context.Context, peer peers.Peer, run string, req OpenRequest) error {
	if peer.ID == m.selfID {
		return m.host.Open(ctx, run, req)
	}
	return m.remote.Open(ctx, peer.URL, run, req)
}

func (m *Manager) step(ctx context.Context, peer peers.Peer, run string, req StepRequest) (StepResponse, error) {
	if peer.ID == m.selfID {
		return m.host.Step(ctx, run, req)
	}
	return m.remote.Step(ctx, peer.URL, run, req)
}

func (m *Manager) finish(ctx context.Context, peer peers.Peer, run string) (FinishResponse, error) {
	if peer.ID == m.selfID {
		return m.host.Finish(ctx, run)
	}
	return m.remote.Finish(ctx, peer.URL, run)
}

func (m *Manager) delete(peer peers.Peer, run string) error {
	if peer.ID == m.selfID {
		return m.host.Delete(run)
	}
	ctx, cancel := context.WithTimeout(context.Background(), m.stepTimeout)
	defer cancel()
	return m.remote.Delete(ctx, peer.URL, run)
}
