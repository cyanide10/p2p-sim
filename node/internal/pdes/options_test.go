package pdes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubCoordinator struct {
	mu       sync.Mutex
	planPart int
}

func (s *stubCoordinator) Start(context.Context, RunRequest) (*Run, error) {
	return &Run{
		ID: "attack-run", Kind: "attack", Coordinator: "node-1", Seed: 5,
		Plan: Plan{OK: true, Parts: 2, Assignment: map[string]int{"dc": 0, "edge": 1}},
	}, nil
}

func (s *stubCoordinator) Get(id string) (*Run, bool) {
	if id != "attack-run" {
		return nil, false
	}
	return &Run{
		ID: "attack-run", Kind: "attack", Coordinator: "node-1", Seed: 5,
		Plan: Plan{OK: true, Parts: 2},
	}, true
}

func (s *stubCoordinator) Plan(_ context.Context, _ json.RawMessage, parts int) (Plan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.planPart = parts
	return Plan{OK: true, Parts: parts, Load: []int{1, 1}}, nil
}

func TestOptionsNormalizePrefixes(t *testing.T) {
	defaults := NetworkOptions()
	if defaults.Kind != "pdes" || defaults.RunPrefix != "pdes" ||
		defaults.EndpointPrefix != "/pdes" || defaults.StartPath != "/pdesrun" {
		t.Fatalf("network defaults = %+v", defaults)
	}
	attack := Options{Kind: "attack", RunPrefix: "attack", EndpointPrefix: "attack", StartPath: "attackrun"}
	normalized := attack.normalized()
	if normalized.EndpointPrefix != "/attack" || normalized.StartPath != "/attackrun" {
		t.Fatalf("normalized attack options = %+v", normalized)
	}
	empty := Options{}.normalized()
	if empty != defaults {
		t.Fatalf("empty options = %+v; want %+v", empty, defaults)
	}
	if got := makeRunID("attack", "node-1", time.Unix(0, 0)); !strings.HasPrefix(got, "attack-node-1-") {
		t.Fatalf("run id = %q", got)
	}
}

func TestHandlerWithOptionsServesAttackRoutes(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(299) })
	coordinator := &stubCoordinator{}
	options := Options{Kind: "attack", RunPrefix: "attack", EndpointPrefix: "/attack", StartPath: "/attackrun"}
	handler := NewHandlerWithOptions(nil, coordinator, next, options)

	planRec := httptest.NewRecorder()
	handler.ServeHTTP(planRec, httptest.NewRequest(http.MethodPost, "/attack/plan",
		strings.NewReader(`{"scenario":{"kind":"ddos"},"parts":2}`)))
	if planRec.Code != http.StatusOK || !strings.Contains(planRec.Body.String(), `"parts":2`) {
		t.Fatalf("attack plan route = %d %s", planRec.Code, planRec.Body)
	}
	if coordinator.planPart != 2 {
		t.Fatalf("planner saw parts = %d", coordinator.planPart)
	}

	startRec := httptest.NewRecorder()
	handler.ServeHTTP(startRec, httptest.NewRequest(http.MethodPost, "/attackrun",
		strings.NewReader(`{"scenario":{"kind":"ddos"},"parts":2}`)))
	if startRec.Code != http.StatusAccepted || !strings.Contains(startRec.Body.String(), `"batch_id":"attack-run"`) ||
		!strings.Contains(startRec.Body.String(), `"parts":2`) {
		t.Fatalf("attack start route = %d %s", startRec.Code, startRec.Body)
	}

	statusRec := httptest.NewRecorder()
	handler.ServeHTTP(statusRec, httptest.NewRequest(http.MethodGet, "/attack/status?batch_id=attack-run", nil))
	if statusRec.Code != http.StatusOK || !strings.Contains(statusRec.Body.String(), `"kind":"attack"`) {
		t.Fatalf("attack status route = %d %s", statusRec.Code, statusRec.Body)
	}

	// Network routes are not mounted on the attack handler.
	pdesRec := httptest.NewRecorder()
	handler.ServeHTTP(pdesRec, httptest.NewRequest(http.MethodGet, "/pdes/status?batch_id=attack-run", nil))
	if pdesRec.Code != 299 {
		t.Fatalf("unexpected /pdes route on attack handler = %d", pdesRec.Code)
	}
}

func TestPeerClientUsesConfiguredPrefix(t *testing.T) {
	paths := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewPeerClientWithPrefix(time.Second, "/attack")
	if err := client.Open(context.Background(), server.URL, "run-1", OpenRequest{}); err != nil {
		t.Fatalf("open: %v", err)
	}
	if got := <-paths; got != "/attack/run-1/open" {
		t.Fatalf("open path = %q", got)
	}
	if err := client.Delete(context.Background(), server.URL, "run-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := <-paths; got != "/attack/run-1" {
		t.Fatalf("delete path = %q", got)
	}
}
