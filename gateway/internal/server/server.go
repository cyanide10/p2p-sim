// Package server exposes the gateway API used by the web app. The gateway
// never coordinates batches; it forwards to the chosen coordinator, keeps a
// copy of what it learns, and serves that copy when the node is unreachable.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/p2p-sim/gateway/internal/cluster"
	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
)

const (
	maxBodyBytes = 1 << 20
	defaultLimit = 50
	maxLimit     = 200
)

type Deps struct {
	Peers    []config.Peer
	Defaults config.Defaults
	Client   *nodeclient.Client
	Store    *runs.Store
	Tracker  *runs.Tracker
	Logger   *slog.Logger
	Version  string
}

type server struct {
	Deps
	peerURLs map[string]string
}

func New(d Deps) http.Handler {
	s := &server{Deps: d, peerURLs: make(map[string]string, len(d.Peers))}
	for _, p := range d.Peers {
		s.peerURLs[p.ID] = p.URL
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("GET /api/cluster", s.cluster)
	mux.HandleFunc("POST /api/runs", s.createRun)
	mux.HandleFunc("GET /api/runs", s.listRuns)
	mux.HandleFunc("GET /api/runs/{id}", s.getRun)
	mux.HandleFunc("GET /api/runs/{id}/status", s.status)
	mux.HandleFunc("GET /api/runs/{id}/report", s.report)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "no such API route")
	})
	return s.wrap(mux)
}

func (s *server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Logger.Error("handler panic", "path", r.URL.Path, "panic", fmt.Sprint(v))
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
		s.Logger.Debug("request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
	})
}

func (s *server) config(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"defaults":        s.Defaults,
		"peers":           s.Peers,
		"gateway_version": s.Version,
		"features":        map[string]bool{"task_grid": false},
	})
}

func (s *server) cluster(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, cluster.Probe(r.Context(), s.Client, s.Peers))
}

func (s *server) createRun(w http.ResponseWriter, r *http.Request) {
	var req runs.CreateRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusBadRequest, "request body exceeds 1 MiB")
		} else {
			writeError(w, http.StatusBadRequest, "invalid request JSON: "+err.Error())
		}
		return
	}
	if req.Coordinator == "" {
		writeError(w, http.StatusBadRequest, "coordinator is required")
		return
	}
	base, ok := s.peerURLs[req.Coordinator]
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown coordinator %q", req.Coordinator))
		return
	}
	nodeReq, err := runs.Resolve(req, s.Defaults)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !s.Store.HasRoom() {
		writeError(w, http.StatusServiceUnavailable, runs.ErrFull.Error())
		return
	}

	body, _ := json.Marshal(nodeReq)
	started, err := s.Client.Run(r.Context(), base, body)
	if err != nil {
		s.Logger.Warn("run submission failed", "coordinator", req.Coordinator, "error", err)
		writeNodeError(w, err, true)
		return
	}

	rec := runs.Record{
		RunID:       runs.EncodeID(req.Coordinator, started.BatchID),
		BatchID:     started.BatchID,
		Coordinator: req.Coordinator,
		CreatedAt:   time.Now().UTC(),
		Params:      nodeReq.Params(started.Replications, started.BaseSeed),
		State:       runs.Running,
	}
	if err := s.Store.Add(rec); err != nil {
		// The node is already running the batch; say so rather than implying it was rejected.
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":    "the coordinator accepted the run but the gateway could not record it: " + err.Error(),
			"accepted": true, "run_id": rec.RunID, "coordinator": rec.Coordinator, "batch_id": rec.BatchID,
		})
		return
	}
	s.Tracker.Track(rec.RunID)
	s.Logger.Info("run started", "run_id", rec.RunID, "coordinator", rec.Coordinator, "batch_id", rec.BatchID)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id":       rec.RunID,
		"batch_id":     started.BatchID,
		"status":       started.Status,
		"coordinator":  req.Coordinator,
		"replications": started.Replications,
		"base_seed":    started.BaseSeed,
		"peers":        started.Peers,
	})
}

func (s *server) listRuns(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryInt(w, r, "limit", defaultLimit)
	if !ok {
		return
	}
	offset, ok := queryInt(w, r, "offset", 0)
	if !ok {
		return
	}
	limit = min(limit, maxLimit)
	list, total := s.Store.List(limit, offset)
	writeJSON(w, http.StatusOK, map[string]any{"runs": list, "limit": limit, "offset": offset, "total": total})
}

func queryInt(w http.ResponseWriter, r *http.Request, name string, def int) (int, bool) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, true
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		writeError(w, http.StatusBadRequest, name+" must be a non-negative integer")
		return 0, false
	}
	return n, true
}

func (s *server) lookup(w http.ResponseWriter, r *http.Request) (runs.Record, bool) {
	id := r.PathValue("id")
	if _, _, err := runs.DecodeID(id); err != nil {
		writeError(w, http.StatusNotFound, "run not found")
		return runs.Record{}, false
	}
	rec, ok := s.Store.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "run not found")
	}
	return rec, ok
}

func (s *server) getRun(w http.ResponseWriter, r *http.Request) {
	if rec, ok := s.lookup(w, r); ok {
		writeJSON(w, http.StatusOK, rec)
	}
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.lookup(w, r)
	if !ok {
		return
	}
	live, err := s.Client.Status(r.Context(), s.peerURLs[rec.Coordinator], rec.BatchID)
	if err == nil {
		s.Store.SetStatus(rec.RunID, live)
		writeRaw(w, withStale(live, false))
		return
	}
	s.fallback(w, rec.Status, err)
}

func (s *server) report(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.lookup(w, r)
	if !ok {
		return
	}
	live, err := s.Client.Report(r.Context(), s.peerURLs[rec.Coordinator], rec.BatchID)
	if err == nil {
		if stateOf(live) == "complete" {
			s.Store.SetReport(rec.RunID, live)
		}
		writeRaw(w, withStale(live, false))
		return
	}
	s.fallback(w, rec.Report, err)
}

// fallback serves a stored copy marked stale, or explains why there is none.
func (s *server) fallback(w http.ResponseWriter, stored json.RawMessage, err error) {
	switch {
	case stored != nil:
		writeRaw(w, withStale(stored, true))
	case nodeclient.IsNotFound(err):
		writeError(w, http.StatusNotFound, "coordinator no longer holds this batch")
	default:
		writeNodeError(w, err, false)
	}
}

func stateOf(obj json.RawMessage) string {
	var v struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(obj, &v)
	return v.State
}

// withStale adds a top-level "stale" field to a node JSON object.
func withStale(obj json.RawMessage, stale bool) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(obj, &m); err != nil {
		m = map[string]json.RawMessage{}
	}
	m["stale"] = json.RawMessage(strconv.FormatBool(stale))
	out, _ := json.Marshal(m)
	return out
}

// writeNodeError maps a node failure to a gateway status. With passthrough,
// node 400 and 409 bodies are returned unchanged so the UI shows the node's
// own message (and the busy batch id).
func writeNodeError(w http.ResponseWriter, err error, passthrough bool) {
	var e *nodeclient.Error
	if errors.As(err, &e) {
		if passthrough && e.Kind == nodeclient.HTTP &&
			(e.StatusCode == http.StatusBadRequest || e.StatusCode == http.StatusConflict) && json.Valid(e.Body) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(e.StatusCode)
			_, _ = w.Write(e.Body)
			return
		}
		if e.Kind == nodeclient.Timeout {
			writeError(w, http.StatusGatewayTimeout, err.Error())
			return
		}
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRaw(w http.ResponseWriter, body json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(append(body, '\n'))
}
