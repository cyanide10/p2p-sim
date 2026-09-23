// Package api exposes a node's HTTP endpoints. Every node serves both roles:
//
//	POST /run     start a batch coordinated by this node
//	GET  /status  task counts for a batch this node coordinates (?batch_id=, default latest)
//	GET  /report  aggregated statistics for such a batch (?batch_id=, default latest)
//	GET  /peers   health of every node in the static peer list
//	GET  /health  liveness
//	POST /task    execute one replication (node-to-node)
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"

	"github.com/p2p-sim/node/internal/batch"
	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/task"
)

const maxBodyBytes = 1 << 20

// TaskExecutor runs one task on this node. Implemented by worker.Executor.
type TaskExecutor interface {
	Execute(ctx context.Context, t task.Task) (task.Result, error)
}

type errorBody struct {
	Error   string `json:"error"`
	BatchID string `json:"batch_id,omitempty"`
}

type taskErrorBody struct {
	TaskID string `json:"task_id"`
	Error  string `json:"error"`
}

type startedBody struct {
	BatchID      string `json:"batch_id"`
	Status       string `json:"status"`
	Coordinator  string `json:"coordinator"`
	Replications int    `json:"replications"`
	BaseSeed     int64  `json:"base_seed"`
	Peers        int    `json:"peers"`
}

type peerHealth struct {
	peers.Peer
	Self    bool   `json:"self"`
	Healthy bool   `json:"healthy"`
	Error   string `json:"error,omitempty"`
}

// NewHandler wires the node routes listed in the package documentation.
func NewHandler(m *batch.Manager, nodeID string, peerList []peers.Peer, client dispatch.PeerClient,
	exec TaskExecutor, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "node_id": nodeID, "peers": len(peerList)})
	})

	mux.HandleFunc("GET /peers", func(w http.ResponseWriter, r *http.Request) {
		out := make([]peerHealth, len(peerList))
		var wg sync.WaitGroup
		for i, p := range peerList {
			wg.Add(1)
			go func(i int, p peers.Peer) {
				defer wg.Done()
				out[i] = peerHealth{Peer: p, Self: p.ID == nodeID, Healthy: true}
				if err := client.Health(r.Context(), p); err != nil {
					out[i].Healthy, out[i].Error = false, err.Error()
				}
			}(i, p)
		}
		wg.Wait()
		writeJSON(w, http.StatusOK, map[string]any{"node_id": nodeID, "peers": out})
	})

	mux.HandleFunc("POST /run", func(w http.ResponseWriter, r *http.Request) {
		var req batch.Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid request JSON: " + err.Error()})
			return
		}

		b, err := m.Start(req)
		var ve *batch.ValidationError
		switch {
		case errors.As(err, &ve):
			writeJSON(w, http.StatusBadRequest, errorBody{Error: ve.Msg})
			return
		case errors.Is(err, batch.ErrBusy):
			writeJSON(w, http.StatusConflict, errorBody{Error: err.Error(), BatchID: b.ID})
			return
		case err != nil:
			logger.Error("failed to start batch", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusAccepted, startedBody{
			BatchID:      b.ID,
			Status:       "started",
			Coordinator:  nodeID,
			Replications: b.Spec.Replications,
			BaseSeed:     b.Spec.BaseSeed,
			Peers:        len(b.Peers),
		})
	})

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := lookup(w, r, m, nodeID); ok {
			writeJSON(w, http.StatusOK, b.Status())
		}
	})

	mux.HandleFunc("GET /report", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := lookup(w, r, m, nodeID); ok {
			writeJSON(w, http.StatusOK, b.Report())
		}
	})

	mux.HandleFunc("POST /task", func(w http.ResponseWriter, r *http.Request) {
		var t task.Task
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		if err := dec.Decode(&t); err != nil {
			writeJSON(w, http.StatusBadRequest, taskErrorBody{Error: "invalid task JSON: " + err.Error()})
			return
		}
		if t.TaskID == "" {
			writeJSON(w, http.StatusBadRequest, taskErrorBody{Error: "task_id is required"})
			return
		}

		res, err := exec.Execute(r.Context(), t)
		switch {
		case errors.Is(err, task.ErrBusy):
			writeJSON(w, http.StatusServiceUnavailable, taskErrorBody{TaskID: t.TaskID, Error: err.Error()})
		case err != nil:
			writeJSON(w, http.StatusBadRequest, taskErrorBody{TaskID: t.TaskID, Error: err.Error()})
		default:
			writeJSON(w, http.StatusOK, res)
		}
	})

	return mux
}

func lookup(w http.ResponseWriter, r *http.Request, m *batch.Manager, nodeID string) (*batch.Batch, bool) {
	id := r.URL.Query().Get("batch_id")
	b, ok := m.Get(id)
	if !ok {
		// Batch state lives only on the node that coordinates it.
		msg := "no batch has been started on " + nodeID
		if id != "" {
			msg = "batch " + id + " is not coordinated by " + nodeID
		}
		writeJSON(w, http.StatusNotFound, errorBody{Error: msg})
		return nil, false
	}
	return b, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// compile-time check that the HTTP client satisfies the interface used here.
var _ dispatch.PeerClient = (*dispatch.HTTPClient)(nil)
