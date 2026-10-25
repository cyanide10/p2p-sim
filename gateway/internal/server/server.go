// Package server exposes the gateway API (docs/gateway-api.md) and serves the
// GUI's static bundle from the same origin.
package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/p2p-sim/gateway/internal/aggregate"
	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
	"github.com/p2p-sim/gateway/internal/store"
)

const (
	maxRequestBody   = 1 << 20
	defaultListLimit = 50
	maxListLimit     = 200
	clusterFanout    = 8
)

const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
	"connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

type Options struct {
	Peers    *config.PeerSource
	Nodes    *nodeclient.Client
	Runs     *runs.Manager
	Defaults config.RunDefaults
	Token    string // bearer token for /api/*; empty disables auth
	Version  string
	Static   fs.FS // built GUI; may lack index.html
	Log      *slog.Logger
}

type Server struct {
	opts Options
}

// Handler returns the complete gateway handler with middleware applied.
func Handler(opts Options) http.Handler {
	s := &Server{opts: opts}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /api/config", s.config)
	mux.HandleFunc("GET /api/cluster", s.cluster)
	mux.HandleFunc("POST /api/runs", s.createRun)
	mux.HandleFunc("GET /api/runs", s.listRuns)
	mux.HandleFunc("GET /api/runs/{id}", s.getRun)
	mux.HandleFunc("GET /api/runs/{id}/status", s.runStatus)
	mux.HandleFunc("GET /api/runs/{id}/report", s.runReport)
	mux.HandleFunc("GET /api/stream", s.stream)
	mux.HandleFunc("POST /api/netstream", s.netStream)
	// Other methods on API paths fall through to static(), which answers 405.
	mux.HandleFunc("GET /api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "no such API endpoint")
	})
	mux.Handle("/", s.static())
	return s.recover(s.logRequests(securityHeaders(s.auth(mux))))
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"defaults":        s.opts.Defaults,
		"peers":           s.opts.Peers.Peers(),
		"gateway_version": s.opts.Version,
		// Nodes expose aggregate counts only, so there is no per-task data.
		"features": map[string]bool{"task_grid": false},
	})
}

func (s *Server) cluster(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, aggregate.Cluster(r.Context(), s.opts.Nodes, s.opts.Peers.Peers(), clusterFanout))
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	var req runs.CreateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	created, err := s.opts.Runs.Create(r.Context(), req)
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, created)
}

func (s *Server) listRuns(w http.ResponseWriter, r *http.Request) {
	limit, offset := defaultListLimit, 0
	q := r.URL.Query()
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, maxListLimit)
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "offset must be a nonnegative integer")
			return
		}
		offset = n
	}
	list, total, err := s.opts.Runs.List(r.Context(), limit, offset)
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": list, "limit": limit, "offset": offset, "total": total})
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.opts.Runs.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) runStatus(w http.ResponseWriter, r *http.Request) {
	body, err := s.opts.Runs.Status(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	writeRaw(w, http.StatusOK, body)
}

func (s *Server) runReport(w http.ResponseWriter, r *http.Request) {
	body, err := s.opts.Runs.Report(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	writeRaw(w, http.StatusOK, body)
}

// streamParams are the query parameters forwarded to a node's /stream.
var streamParams = []string{"lambda", "mu", "duration", "speed", "seed"}

// stream relays a live traffic stream from the chosen node to the browser.
// The node runs the simulation; closing the page closes both connections.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	peer, ok := s.opts.Peers.Lookup(q.Get("node"))
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown node %q", q.Get("node")))
		return
	}
	forward := url.Values{}
	for _, key := range streamParams {
		if v := q.Get(key); v != "" {
			forward.Set(key, v)
		}
	}
	body, err := s.opts.Nodes.OpenStream(r.Context(), peer.URL, forward)
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	s.relaySSE(w, body)
}

// netStream relays a live network-scenario stream: body {node, scenario,
// speed, seed}; the node gets {scenario, speed, seed}.
func (s *Server) netStream(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Node     string          `json:"node"`
		Scenario json.RawMessage `json:"scenario"`
		Speed    float64         `json:"speed"`
		Seed     *int64          `json:"seed,omitempty"`
		Start    float64         `json:"start"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	peer, ok := s.opts.Peers.Lookup(req.Node)
	if !ok {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unknown node %q", req.Node))
		return
	}
	payload, _ := json.Marshal(map[string]any{"scenario": req.Scenario, "speed": req.Speed, "seed": req.Seed, "start": req.Start})
	body, err := s.opts.Nodes.OpenNetStream(r.Context(), peer.URL, payload)
	if err != nil {
		s.writeErr(w, r, err)
		return
	}
	s.relaySSE(w, body)
}

// relaySSE copies a node's event stream to the client, flushing as it goes.
func (s *Server) relaySSE(w http.ResponseWriter, body io.ReadCloser) {
	defer body.Close()
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		s.opts.Log.Warn("live stream: cannot clear write deadline", "err", err)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc.Flush()
	buf := make([]byte, 32<<10)
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
		if readErr != nil {
			return
		}
	}
}

// writeErr maps errors to responses: validation 400, unknown run 404, node
// 400/409/503 passed through unchanged, node timeout 504, other node failures 502.
func (s *Server) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var validation *runs.ValidationError
	var accepted *runs.AcceptedError
	var nodeErr *nodeclient.Error
	switch {
	case errors.As(err, &validation):
		writeError(w, http.StatusBadRequest, validation.Message)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "run not found")
	case errors.As(err, &accepted):
		s.opts.Log.Error("run accepted but not recorded", "err", err, "batch_id", accepted.Created.BatchID)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": accepted.Error(), "accepted": true, "run_id": accepted.Created.RunID,
			"coordinator": accepted.Created.Coordinator, "batch_id": accepted.Created.BatchID,
		})
	case errors.As(err, &nodeErr):
		switch {
		case nodeErr.Kind == nodeclient.KindStatus && (nodeErr.Status == 400 || nodeErr.Status == 409 || nodeErr.Status == 503):
			if nodeErr.Body != nil {
				writeRaw(w, nodeErr.Status, nodeErr.Body)
			} else {
				writeError(w, nodeErr.Status, nodeErr.Message)
			}
		case nodeErr.Kind == nodeclient.KindStatus && nodeErr.Status == 404:
			writeError(w, http.StatusBadGateway, "the coordinator no longer knows this batch")
		case nodeErr.Kind == nodeclient.KindTimeout:
			writeError(w, http.StatusGatewayTimeout, nodeErr.Error())
		default:
			writeError(w, http.StatusBadGateway, nodeErr.Error())
		}
	default:
		s.opts.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// static serves the embedded GUI with an index.html fallback for client
// routes. Paths are cleaned and resolved inside the embedded FS only.
func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.opts.Static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name != "" && name != "index.html" && fs.ValidPath(name) {
			if info, err := fs.Stat(s.opts.Static, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				r.URL.Path = "/" + name
				files.ServeHTTP(w, r)
				return
			}
		}
		index, err := fs.ReadFile(s.opts.Static, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, notBuiltPage)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
	})
}

const notBuiltPage = `<!doctype html><meta charset="utf-8"><title>p2p-sim gateway</title>
<p>The gateway is running, but the GUI bundle was not embedded in this build.</p>
<p>Build it with <code>cd web &amp;&amp; VITE_USE_MOCK=false npm run build</code>, copy <code>web/dist/*</code> into
<code>gateway/webui/dist/</code>, and rebuild the gateway. The Docker image does this automatically.</p>`

func (s *Server) auth(next http.Handler) http.Handler {
	if s.opts.Token == "" {
		return next
	}
	want := []byte("Bearer " + s.opts.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") &&
			subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="p2p-sim"`)
			writeError(w, http.StatusUnauthorized, "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach Flush and SetWriteDeadline.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		level := slog.LevelDebug
		if strings.HasPrefix(r.URL.Path, "/api/") && (r.Method != http.MethodGet || rec.status >= 400) {
			level = slog.LevelInfo
		}
		s.opts.Log.Log(r.Context(), level, "request", "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "duration_ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.opts.Log.Error("panic in handler", "path", r.URL.Path, "panic", fmt.Sprint(v))
				writeError(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// decodeJSON reads one JSON object, rejecting unknown fields, trailing data
// and bodies over 1 MiB. It writes the error response itself.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body exceeds 1 MiB")
		} else {
			writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		}
		return false
	}
	if dec.More() {
		writeError(w, http.StatusBadRequest, "invalid JSON body: unexpected data after the object")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeRaw(w, status, body)
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	body, _ := json.Marshal(map[string]string{"error": message})
	writeRaw(w, status, body)
}
