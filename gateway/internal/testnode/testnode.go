// Package testnode is a scriptable in-process fake of a p2p-sim node, so
// gateway tests need no network, Docker or Python.
package testnode

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
)

// Node serves /health, /peers, /run, /status and /report. Change its
// behavior through Update; fields must not be touched directly while the
// server is running.
type Node struct {
	ID string

	// Healthy false makes /health answer 503.
	Healthy bool
	// PeerView is this node's /peers answer: peer id -> healthy.
	PeerView map[string]bool
	// RunStatus other than 0 or 202 makes /run answer with that status.
	RunStatus int
	// CompleteAfter is the number of /status calls after which the batch is complete.
	CompleteAfter int
	// Lost makes /status and /report answer 404, as after a node restart.
	Lost bool
	// Delay is applied before every response.
	Delay time.Duration

	mu          sync.Mutex
	srv         *httptest.Server
	runBodies   [][]byte
	runs        int
	batchID     string
	baseSeed    int64
	reps        int
	statusCalls int
}

func New(id string) *Node {
	n := &Node{ID: id, Healthy: true, PeerView: map[string]bool{id: true}, CompleteAfter: 1}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", n.health)
	mux.HandleFunc("GET /peers", n.peers)
	mux.HandleFunc("POST /run", n.run)
	mux.HandleFunc("GET /status", n.status)
	mux.HandleFunc("GET /report", n.report)
	n.srv = httptest.NewServer(n.delayed(mux))
	return n
}

func (n *Node) URL() string { return n.srv.URL }

// Close stops the server; later requests fail with connection refused.
func (n *Node) Close() {
	n.srv.CloseClientConnections()
	n.srv.Close()
}

func (n *Node) Update(fn func(*Node)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	fn(n)
}

// RunBodies returns the raw POST /run bodies received so far.
func (n *Node) RunBodies() [][]byte {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([][]byte(nil), n.runBodies...)
}

func (n *Node) StatusCalls() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.statusCalls
}

// Peers returns a gateway peer list addressing the given fake nodes.
func Peers(nodes ...*Node) []config.Peer {
	out := make([]config.Peer, len(nodes))
	for i, n := range nodes {
		out[i] = config.Peer{ID: n.ID, URL: n.URL()}
	}
	return out
}

func (n *Node) delayed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.mu.Lock()
		d := n.Delay
		n.mu.Unlock()
		if d > 0 {
			select {
			case <-time.After(d):
			case <-r.Context().Done():
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (n *Node) health(w http.ResponseWriter, _ *http.Request) {
	n.mu.Lock()
	healthy, peers := n.Healthy, len(n.PeerView)
	n.mu.Unlock()
	if !healthy {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "unhealthy"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "node_id": n.ID, "peers": peers})
}

func (n *Node) peers(w http.ResponseWriter, _ *http.Request) {
	n.mu.Lock()
	ids := make([]string, 0, len(n.PeerView))
	for id := range n.PeerView {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	list := make([]map[string]any, len(ids))
	for i, id := range ids {
		list[i] = map[string]any{"id": id, "url": "http://" + id + ":8000", "self": id == n.ID, "healthy": n.PeerView[id]}
		if !n.PeerView[id] {
			list[i]["error"] = "connection refused"
		}
	}
	n.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"node_id": n.ID, "peers": list})
}

func (n *Node) run(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.runBodies = append(n.runBodies, body)
	switch n.RunStatus {
	case 0, http.StatusAccepted:
	case http.StatusConflict:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "a batch is already running on this node", "batch_id": n.batchID})
		return
	default:
		writeJSON(w, n.RunStatus, map[string]string{"error": fmt.Sprintf("scripted status %d", n.RunStatus)})
		return
	}
	var req struct {
		Replications *int   `json:"replications"`
		BaseSeed     *int64 `json:"base_seed"`
	}
	_ = json.Unmarshal(body, &req)
	n.runs++
	n.batchID = fmt.Sprintf("batch-%s-%d", n.ID, n.runs)
	n.baseSeed, n.reps, n.statusCalls = 1761300000000, 100, 0
	if req.BaseSeed != nil {
		n.baseSeed = *req.BaseSeed
	}
	if req.Replications != nil {
		n.reps = *req.Replications
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"batch_id": n.batchID, "status": "started", "coordinator": n.ID,
		"replications": n.reps, "base_seed": n.baseSeed, "peers": len(n.PeerView),
	})
}

// known reports whether id is this node's batch; n.mu must be held.
func (n *Node) known(id string) bool {
	return !n.Lost && n.batchID != "" && id == n.batchID
}

func (n *Node) status(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.known(r.URL.Query().Get("batch_id")) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch is not coordinated by " + n.ID})
		return
	}
	n.statusCalls++
	done := n.statusCalls >= n.CompleteAfter
	state, phase, complete, pending := "running", "distributed", n.reps/2, n.reps-n.reps/2
	if done {
		state, phase, complete, pending = "complete", "complete", n.reps, 0
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"batch_id": n.batchID, "coordinator": n.ID, "state": state, "phase": phase,
		"replications": n.reps, "pending": pending, "assigned": 0, "complete": complete,
		"failed": 0, "failed_attempts": 0, "elapsed_seconds": 1.5,
	})
}

func (n *Node) report(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.known(r.URL.Query().Get("batch_id")) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch is not coordinated by " + n.ID})
		return
	}
	state, phase, verdict := "running", "distributed", "PENDING"
	if n.statusCalls >= n.CompleteAfter {
		state, phase, verdict = "complete", "complete", "PASS"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"batch_id": n.batchID, "coordinator": n.ID, "state": state, "phase": phase,
		"verdict": verdict, "verdict_detail": "scripted", "base_seed": n.baseSeed,
		"replications_requested": n.reps, "tasks_per_peer": map[string]int{n.ID: n.reps},
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
