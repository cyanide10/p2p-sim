// Package testnode provides scriptable fake p2p-sim nodes backed by
// httptest servers, so gateway tests need no real nodes, network or Python.
package testnode

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
)

// Node is a fake node. A batch completes after StepsToComplete GET /status
// calls. All setters are safe to call while requests are in flight.
type Node struct {
	ID     string
	Server *httptest.Server

	mu              sync.Mutex
	down            bool
	delay           time.Duration
	busy            bool
	forget          bool
	stepsToComplete int
	seen            map[string]bool // this node's view of peer health (GET /peers)
	batches         map[string]*batch
	order           []string
	runRequests     []map[string]any
	statusCalls     int
	streamBusy      bool
	streamQueries   []string
}

type batch struct {
	id    string
	reps  int
	seed  int64
	calls int
}

func New(tb testing.TB, id string) *Node {
	n := &Node{ID: id, stepsToComplete: 3, seen: map[string]bool{}, batches: map[string]*batch{}}
	n.Server = httptest.NewServer(http.HandlerFunc(n.serve))
	tb.Cleanup(n.Server.Close)
	return n
}

// Pool creates n fake nodes that all see each other as healthy, and the
// peer list naming them.
func Pool(tb testing.TB, count int) ([]*Node, []config.Peer) {
	nodes := make([]*Node, count)
	peers := make([]config.Peer, count)
	for i := range nodes {
		nodes[i] = New(tb, fmt.Sprintf("node-%d", i+1))
		peers[i] = config.Peer{ID: nodes[i].ID, URL: nodes[i].Server.URL}
	}
	for _, n := range nodes {
		for _, p := range peers {
			n.SetSees(p.ID, true)
		}
	}
	return nodes, peers
}

func (n *Node) URL() string { return n.Server.URL }

// SetDown makes every request fail at the connection level.
func (n *Node) SetDown(down bool) { n.mu.Lock(); n.down = down; n.mu.Unlock() }

// SetDelay delays every response.
func (n *Node) SetDelay(d time.Duration) { n.mu.Lock(); n.delay = d; n.mu.Unlock() }

// SetBusy makes POST /run answer 409.
func (n *Node) SetBusy(busy bool) { n.mu.Lock(); n.busy = busy; n.mu.Unlock() }

// Forget makes the node answer 404 for every batch, as after a restart.
func (n *Node) Forget() { n.mu.Lock(); n.forget = true; n.mu.Unlock() }

// SetSteps sets how many status calls a batch takes to complete.
func (n *Node) SetSteps(steps int) { n.mu.Lock(); n.stepsToComplete = steps; n.mu.Unlock() }

// SetSees sets this node's reported view of a peer's health.
func (n *Node) SetSees(peerID string, healthy bool) {
	n.mu.Lock()
	n.seen[peerID] = healthy
	n.mu.Unlock()
}

// SetStreamBusy makes GET /stream answer 503.
func (n *Node) SetStreamBusy(busy bool) { n.mu.Lock(); n.streamBusy = busy; n.mu.Unlock() }

// StreamQueries returns the raw query strings of GET /stream requests.
func (n *Node) StreamQueries() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.streamQueries...)
}

// RunRequests returns the POST /run bodies received.
func (n *Node) RunRequests() []map[string]any {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]map[string]any(nil), n.runRequests...)
}

// StatusCalls returns how many GET /status requests were received.
func (n *Node) StatusCalls() int { n.mu.Lock(); defer n.mu.Unlock(); return n.statusCalls }

func (n *Node) serve(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	down, delay := n.down, n.delay
	n.mu.Unlock()
	if down {
		if hj, ok := w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		write(w, 200, map[string]any{"status": "ok", "node_id": n.ID, "peers": len(n.peersSeen())})
	case r.Method == http.MethodGet && r.URL.Path == "/peers":
		write(w, 200, map[string]any{"node_id": n.ID, "peers": n.peersSeen()})
	case r.Method == http.MethodPost && r.URL.Path == "/run":
		n.run(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/status":
		n.status(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/report":
		n.report(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/stream":
		n.stream(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/netrun":
		n.netrun(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/netstream":
		n.netstream(w, r)
	default:
		write(w, 404, map[string]string{"error": "not found"})
	}
}

func (n *Node) peersSeen() []map[string]any {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := []map[string]any{}
	for id, healthy := range n.seen {
		entry := map[string]any{"id": id, "url": "http://" + id + ":8000", "self": id == n.ID, "healthy": healthy}
		if !healthy {
			entry["error"] = "connection refused"
		}
		out = append(out, entry)
	}
	return out
}

func (n *Node) run(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		write(w, 400, map[string]string{"error": "malformed JSON"})
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.runRequests = append(n.runRequests, req)
	if n.busy {
		write(w, 409, map[string]string{"error": "a batch is already running on this node", "batch_id": "batch-existing"})
		return
	}
	reps := 100
	if v, ok := req["replications"].(float64); ok {
		reps = int(v)
	}
	seed := int64(1700000000000)
	if v, ok := req["base_seed"].(float64); ok {
		seed = int64(v)
	}
	id := fmt.Sprintf("batch-%s-%d", n.ID, len(n.order)+1)
	n.batches[id] = &batch{id: id, reps: reps, seed: seed}
	n.order = append(n.order, id)
	write(w, 202, map[string]any{"batch_id": id, "status": "started", "coordinator": n.ID,
		"replications": reps, "base_seed": seed, "peers": len(n.seen)})
}

func (n *Node) lookup(w http.ResponseWriter, r *http.Request) (*batch, bool) {
	b := n.batches[r.URL.Query().Get("batch_id")]
	if b == nil || n.forget {
		write(w, 404, map[string]string{"error": "unknown batch"})
		return nil, false
	}
	return b, true
}

func (n *Node) status(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.statusCalls++
	b, ok := n.lookup(w, r)
	if !ok {
		return
	}
	b.calls++
	write(w, 200, n.statusBody(b))
}

func (n *Node) statusBody(b *batch) map[string]any {
	done := min(b.reps, b.reps*b.calls/max(1, n.stepsToComplete))
	state, phase := "running", "distributed"
	if b.calls >= n.stepsToComplete {
		state, phase = "complete", "complete"
	}
	return map[string]any{
		"batch_id": b.id, "coordinator": n.ID, "state": state, "phase": phase, "replications": b.reps,
		"pending": b.reps - done, "assigned": 0, "complete": done, "failed": 0, "failed_attempts": 0,
		"elapsed_seconds": float64(b.calls) * 0.5,
	}
}

func (n *Node) report(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	b, ok := n.lookup(w, r)
	if !ok {
		return
	}
	s := n.statusBody(b)
	verdict := "PENDING"
	if s["state"] == "complete" {
		verdict = "PASS"
	}
	metric := func(mean, theory float64) map[string]any {
		return map[string]any{"n": s["complete"], "mean": mean, "stddev": 0.8, "ci95_low": mean - 0.15,
			"ci95_high": mean + 0.15, "ci95_half_width": 0.15, "theoretical": theory, "rel_error_pct": 1.2,
			"tolerance_pct": 10, "within_tolerance": true, "theoretical_in_ci": true}
	}
	write(w, 200, map[string]any{
		"batch_id": b.id, "coordinator": n.ID, "state": s["state"], "phase": s["phase"],
		"verdict": verdict, "verdict_detail": "fake node", "params": map[string]any{
			"lambda": 0.8, "mu": 1.0, "sim_time": 10000, "warmup_time": 1000},
		"replications_requested": b.reps, "base_seed": b.seed, "seed_scheme": "seed = base_seed + task_index",
		"tolerance_pct": 10, "ci_method": "normal approximation",
		"tasks":          map[string]any{"pending": s["pending"], "assigned": 0, "complete": s["complete"], "failed": 0, "failed_attempts": 0},
		"tasks_per_peer": map[string]int{n.ID: s["complete"].(int)}, "failed_tasks": []any{},
		"theoretical":    map[string]float64{"rho": 0.8, "L": 4, "W": 5},
		"mean_wait_time": metric(5.06, 5), "mean_queue_length": metric(4.05, 4), "utilization": metric(0.8, 0.8),
		"timing": map[string]any{"distributed_wall_clock_seconds": 3.2, "distributed_peers": len(n.seen),
			"sum_replication_runtime_seconds": 8.6, "serial_wall_clock_seconds": nil, "speedup": nil},
	})
}

// netrun accepts a network batch; it progresses like an M/M/1 batch.
func (n *Node) netrun(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req["scenario"] == nil {
		write(w, 400, map[string]string{"error": "scenario is required"})
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.runRequests = append(n.runRequests, req)
	reps := 30
	if v, ok := req["replications"].(float64); ok {
		reps = int(v)
	}
	id := fmt.Sprintf("net-%s-%d", n.ID, len(n.order)+1)
	n.batches[id] = &batch{id: id, reps: reps, seed: 99}
	n.order = append(n.order, id)
	write(w, 202, map[string]any{"batch_id": id, "status": "started", "coordinator": n.ID,
		"replications": reps, "base_seed": 99, "peers": len(n.seen)})
}

// netstream echoes the request body back as one event, then finishes.
func (n *Node) netstream(w http.ResponseWriter, r *http.Request) {
	var req map[string]any
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req["scenario"] == nil {
		write(w, 400, map[string]string{"error": "body must be {scenario, speed, seed?}"})
		return
	}
	echo, _ := json.Marshal(map[string]any{"type": "meta", "request": req})
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: %s\n\ndata: {\"type\":\"done\"}\n\n", echo)
}

// stream sends a short live-traffic stream: meta, one packet, done.
func (n *Node) stream(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	n.streamQueries = append(n.streamQueries, r.URL.RawQuery)
	busy := n.streamBusy
	n.mu.Unlock()
	if busy {
		write(w, 503, map[string]string{"error": "node busy: concurrent task limit reached"})
		return
	}
	if r.URL.Query().Get("lambda") == "" {
		write(w, 400, map[string]string{"error": "lambda is required"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range []string{
		`{"type":"meta","seed":1,"lambda":0.8,"mu":1,"duration":10,"speed":10,"rho":0.8,"theory":{"rho":0.8,"W":5,"L":4}}`,
		`{"type":"arrival","t":0.5,"id":1,"in_system":1}`,
		`{"type":"done","t":10,"arrived":1,"served":0,"in_system":1}`,
	} {
		fmt.Fprintf(w, "data: %s\n\n", event)
		w.(http.Flusher).Flush()
	}
}

func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
