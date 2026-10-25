package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/p2p-sim/node/internal/netbatch"
	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

// NetworkSim validates and live-streams network scenarios. Implemented by sim.Network.
type NetworkSim interface {
	Validate(ctx context.Context, scenario []byte) (sim.Summary, error)
	Stream(ctx context.Context, scenario []byte, seed int64, speed, start float64, onLine func([]byte) error) error
}

type netStreamRequest struct {
	Scenario json.RawMessage `json:"scenario"`
	Seed     *int64          `json:"seed"`
	Speed    float64         `json:"speed"`
	Start    float64         `json:"start"` // simulated time to begin playback at
}

// NetworkHandler adds the network-scenario routes in front of next:
//
//	POST /netrun     start a network batch coordinated by this node
//	POST /netstream  one network replication run live, as Server-Sent Events
//	GET  /status, GET /report with the batch_id of a network batch
//
// Every other request (including /status and /report for M/M/1 batches) goes to next.
func NetworkHandler(m *netbatch.Manager, netsim NetworkSim, slots SlotAcquirer, nodeID string,
	logger *slog.Logger, next http.Handler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /netrun", func(w http.ResponseWriter, r *http.Request) {
		var req netbatch.Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid request JSON: " + err.Error()})
			return
		}
		b, err := m.Start(r.Context(), req)
		var ve *netbatch.ValidationError
		switch {
		case errors.As(err, &ve):
			writeJSON(w, http.StatusBadRequest, errorBody{Error: ve.Msg})
		case errors.Is(err, netbatch.ErrBusy):
			writeJSON(w, http.StatusConflict, errorBody{Error: err.Error(), BatchID: b.ID})
		case err != nil:
			logger.Error("failed to start network batch", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		default:
			writeJSON(w, http.StatusAccepted, startedBody{BatchID: b.ID, Status: "started", Coordinator: nodeID,
				Replications: b.Replications, BaseSeed: b.BaseSeed, Peers: len(b.Peers)})
		}
	})

	mux.HandleFunc("POST /netstream", func(w http.ResponseWriter, r *http.Request) {
		var req netStreamRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil || len(req.Scenario) == 0 {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: "body must be {scenario, speed, seed?}"})
			return
		}
		summary, err := netsim.Validate(r.Context(), req.Scenario)
		if err == nil {
			err = sim.CheckStreamRate(summary, req.Speed)
		}
		if err == nil && (req.Start < 0 || math.IsNaN(req.Start) || math.IsInf(req.Start, 0)) {
			err = &sim.ScenarioError{Msg: "start must be within the run"}
		}
		var se *sim.ScenarioError
		if errors.As(err, &se) {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: se.Msg})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
			return
		}
		seed := time.Now().UnixMilli()
		if req.Seed != nil && *req.Seed >= 0 {
			seed = *req.Seed
		}
		release, err := slots.Acquire()
		if errors.Is(err, task.ErrBusy) {
			writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: err.Error()})
			return
		}
		defer release()

		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Time{})
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		rc.Flush()
		log := logger.With("seed", seed, "speed", req.Speed, "nodes", summary.Nodes, "flows", summary.Flows)
		log.Info("live network stream started")
		err = netsim.Stream(r.Context(), req.Scenario, seed, req.Speed, req.Start, func(line []byte) error {
			if _, err := fmt.Fprintf(w, "data: %s\n\n", line); err != nil {
				return err
			}
			return rc.Flush()
		})
		switch {
		case r.Context().Err() != nil:
			log.Info("live network stream closed by viewer")
		case err != nil:
			log.Warn("live network stream failed", "error", err)
			fmt.Fprintf(w, "data: {\"type\":\"error\",\"message\":%q}\n\n", err.Error())
			rc.Flush()
		default:
			log.Info("live network stream finished")
		}
	})

	netBatch := func(r *http.Request) (*netbatch.Batch, bool) {
		id := r.URL.Query().Get("batch_id")
		if id == "" {
			return nil, false
		}
		return m.Get(id)
	}
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := netBatch(r); ok {
			writeJSON(w, http.StatusOK, b.Status())
			return
		}
		next.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /report", func(w http.ResponseWriter, r *http.Request) {
		if b, ok := netBatch(r); ok {
			writeJSON(w, http.StatusOK, b.Report())
			return
		}
		next.ServeHTTP(w, r)
	})
	mux.Handle("/", next)
	return mux
}
