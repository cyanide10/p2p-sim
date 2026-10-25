package pdes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Coordinator interface {
	Start(context.Context, RunRequest) (*Run, error)
	Get(string) (*Run, bool)
	Plan(context.Context, json.RawMessage, int) (Plan, error)
}

type Handler struct {
	host        *Host
	coordinator Coordinator
	next        http.Handler
}

func NewHandler(host *Host, coordinator Coordinator, next http.Handler) http.Handler {
	mux := http.NewServeMux()
	if next == nil {
		next = http.NotFoundHandler()
	}
	h := &Handler{host: host, coordinator: coordinator, next: next}
	mux.HandleFunc("POST /pdes/{run}/open", h.open)
	mux.HandleFunc("POST /pdes/{run}/step", h.step)
	mux.HandleFunc("POST /pdes/{run}/finish", h.finish)
	mux.HandleFunc("DELETE /pdes/{run}", h.delete)
	if coordinator != nil {
		mux.HandleFunc("POST /pdes/plan", h.plan)
		mux.HandleFunc("POST /pdesrun", h.start)
		mux.HandleFunc("GET /pdes/status", h.status)
		mux.HandleFunc("GET /pdes/report", h.report)
		mux.HandleFunc("GET /status", h.statusOrNext)
		mux.HandleFunc("GET /report", h.reportOrNext)
	}
	mux.Handle("/", next)
	return mux
}

func (h *Handler) open(w http.ResponseWriter, r *http.Request) {
	var req OpenRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Scenario) == 0 || string(req.Scenario) == "null" {
		writeError(w, http.StatusBadRequest, errors.New("scenario is required"))
		return
	}
	if err := h.host.Open(r.Context(), r.PathValue("run"), req); err != nil {
		if errors.Is(err, ErrBusy) {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) step(w http.ResponseWriter, r *http.Request) {
	var req StepRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	response, err := h.host.Step(r.Context(), r.PathValue("run"), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) finish(w http.ResponseWriter, r *http.Request) {
	response, err := h.host.Finish(r.Context(), r.PathValue("run"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	if err := h.host.Delete(r.PathValue("run")); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) plan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Scenario json.RawMessage `json:"scenario"`
		Parts    int             `json:"parts"`
	}
	if err := decodeBody(w, r, &req); err != nil || len(req.Scenario) == 0 {
		if err == nil {
			err = errors.New("scenario is required")
		}
		writeError(w, http.StatusBadRequest, err)
		return
	}
	plan, err := h.coordinator.Plan(r.Context(), req.Scenario, req.Parts)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (h *Handler) start(w http.ResponseWriter, r *http.Request) {
	var req RunRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	run, err := h.coordinator.Start(r.Context(), req)
	switch {
	case errors.Is(err, ErrCoordinatorBusy):
		writeError(w, http.StatusConflict, err)
	case err != nil:
		writeError(w, http.StatusBadRequest, err)
	default:
		writeJSON(w, http.StatusAccepted, map[string]any{
			"batch_id": run.ID, "status": "started", "coordinator": run.Coordinator,
			"base_seed": run.Seed, "parts": run.Plan.Parts,
		})
	}
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	run, ok := h.coordinator.Get(r.URL.Query().Get("batch_id"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("partitioned run was not found"))
		return
	}
	writeJSON(w, http.StatusOK, run.Status())
}

func (h *Handler) report(w http.ResponseWriter, r *http.Request) {
	run, ok := h.coordinator.Get(r.URL.Query().Get("batch_id"))
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("partitioned run was not found"))
		return
	}
	writeJSON(w, http.StatusOK, run.Report())
}

func (h *Handler) statusOrNext(w http.ResponseWriter, r *http.Request) {
	run, ok := h.coordinator.Get(r.URL.Query().Get("batch_id"))
	if !ok {
		h.next.ServeHTTP(w, r)
		return
	}
	writeJSON(w, http.StatusOK, run.Status())
}

func (h *Handler) reportOrNext(w http.ResponseWriter, r *http.Request) {
	run, ok := h.coordinator.Get(r.URL.Query().Get("batch_id"))
	if !ok {
		h.next.ServeHTTP(w, r)
		return
	}
	writeJSON(w, http.StatusOK, run.Report())
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxMessageBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid request JSON: %w", err)
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

type PeerClient struct {
	HTTP    *http.Client
	Timeout time.Duration
}

func NewPeerClient(timeout time.Duration) *PeerClient {
	return &PeerClient{
		HTTP: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		Timeout: timeout,
	}
}

func (c *PeerClient) Open(ctx context.Context, peerURL, run string, req OpenRequest) error {
	return c.call(ctx, http.MethodPost, peerURL+"/pdes/"+url.PathEscape(run)+"/open", req, nil)
}

func (c *PeerClient) Step(ctx context.Context, peerURL, run string, req StepRequest) (StepResponse, error) {
	var response StepResponse
	err := c.call(ctx, http.MethodPost, peerURL+"/pdes/"+url.PathEscape(run)+"/step", req, &response)
	return response, err
}

func (c *PeerClient) Finish(ctx context.Context, peerURL, run string) (FinishResponse, error) {
	var response FinishResponse
	err := c.call(ctx, http.MethodPost, peerURL+"/pdes/"+url.PathEscape(run)+"/finish", nil, &response)
	return response, err
}

func (c *PeerClient) Delete(ctx context.Context, peerURL, run string) error {
	return c.call(ctx, http.MethodDelete, peerURL+"/pdes/"+url.PathEscape(run), nil, nil)
}

func (c *PeerClient) call(ctx context.Context, method, endpoint string, request, response any) error {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var body io.Reader
	if request != nil {
		encoded, err := json.Marshal(request)
		if err != nil {
			return err
		}
		if len(encoded) > maxMessageBytes {
			return fmt.Errorf("partition request exceeds %d bytes", maxMessageBytes)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("partition request to %s failed: %w", endpoint, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxReplyBytes+1))
	if err != nil {
		return fmt.Errorf("read partition response: %w", err)
	}
	if len(data) > maxReplyBytes {
		return fmt.Errorf("partition response exceeds %d bytes", maxReplyBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var message struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &message) == nil && message.Error != "" {
			return fmt.Errorf("partition peer HTTP %d: %s", resp.StatusCode, message.Error)
		}
		return fmt.Errorf("partition peer returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if response != nil {
		if err := json.Unmarshal(data, response); err != nil {
			return fmt.Errorf("invalid partition response JSON: %w", err)
		}
	}
	return nil
}
