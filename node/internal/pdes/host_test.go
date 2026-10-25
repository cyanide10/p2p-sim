package pdes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeSlots struct {
	slots chan struct{}
}

func newFakeSlots(count int) *fakeSlots {
	return &fakeSlots{slots: make(chan struct{}, count)}
}

func (s *fakeSlots) Acquire() (func(), error) {
	select {
	case s.slots <- struct{}{}:
		return func() { <-s.slots }, nil
	default:
		return nil, ErrBusy
	}
}

type fakeWorker struct {
	mu       sync.Mutex
	opened   bool
	closed   bool
	openErr  error
	closedCh chan struct{}
}

func (w *fakeWorker) Open(context.Context, OpenRequest) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.opened = true
	return w.openErr
}

func (w *fakeWorker) Step(context.Context, StepRequest) (StepResponse, error) {
	return StepResponse{Outbound: []ArrivalRecord{}, ComputeS: 0.01, Events: 2}, nil
}

func (w *fakeWorker) Finish(context.Context) (FinishResponse, error) {
	return FinishResponse{Metrics: json.RawMessage(`{"totals":{}}`), State: json.RawMessage(`{}`)}, nil
}

func (w *fakeWorker) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.closed {
		w.closed = true
		if w.closedCh != nil {
			close(w.closedCh)
		}
	}
	return nil
}

func TestHostLifecycleReleasesSimulationSlot(t *testing.T) {
	slots := newFakeSlots(1)
	host := NewHost(context.Background(), func() Worker { return &fakeWorker{} }, slots, time.Minute)
	defer host.Close()
	request := OpenRequest{Scenario: json.RawMessage(`{"duration":1}`), Plan: Plan{OK: true, Parts: 1}}

	if err := host.Open(context.Background(), "run-1", request); err != nil {
		t.Fatal(err)
	}
	if _, err := host.Step(context.Background(), "run-1", StepRequest{Until: 0.5}); err != nil {
		t.Fatal(err)
	}
	if err := host.Open(context.Background(), "run-2", request); !errors.Is(err, ErrBusy) {
		t.Fatalf("second open err = %v; want busy", err)
	}
	if _, err := host.Finish(context.Background(), "run-1"); err != nil {
		t.Fatal(err)
	}
	if err := host.Open(context.Background(), "run-2", request); err != nil {
		t.Fatalf("open after finish: %v", err)
	}
	if err := host.Delete("run-2"); err != nil {
		t.Fatal(err)
	}
}

func TestHostReapsIdleWorkers(t *testing.T) {
	slots := newFakeSlots(1)
	worker := &fakeWorker{closedCh: make(chan struct{})}
	host := NewHost(context.Background(), func() Worker { return worker }, slots, 40*time.Millisecond)
	defer host.Close()
	if err := host.Open(context.Background(), "run-idle", OpenRequest{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-worker.closedCh:
	case <-time.After(time.Second):
		t.Fatal("idle worker was not reaped")
	}
	if _, err := host.Step(context.Background(), "run-idle", StepRequest{}); err == nil {
		t.Fatal("expected missing run after idle cleanup")
	}
}

func TestHostHTTPRoutesAndBusyStatus(t *testing.T) {
	slots := newFakeSlots(0)
	host := NewHost(context.Background(), func() Worker { return &fakeWorker{} }, slots, time.Minute)
	defer host.Close()
	handler := NewHandler(host, nil, http.NotFoundHandler())
	body := `{"scenario":{"duration":1},"plan":{"ok":true,"parts":1,"assignment":{},"cut_links":[],"lookahead":1,"windows":1,"load":[1]},"part":0,"seed":2}`
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/pdes/run-1/open", strings.NewReader(body)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("open status = %d, want 503; body=%s", rec.Code, rec.Body)
	}
}

func TestProcessWorkerSpeaksJSONLines(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh not available")
	}
	script := filepath.Join(t.TempDir(), "fake-worker.sh")
	body := "#!/bin/sh\n" +
		"read -r open_request\n" +
		"printf '%s\\n' '{\"ok\":true}'\n" +
		"read -r step_request\n" +
		"printf '%s\\n' '{\"outbound\":[],\"compute_s\":0.01,\"events\":2}'\n" +
		"read -r finish_request\n" +
		"printf '%s\\n' '{\"metrics\":{\"totals\":{}},\"state\":{}}'\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	worker := &ProcessWorker{Python: shell, Script: script}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := worker.Open(ctx, OpenRequest{Scenario: json.RawMessage(`{"duration":1}`)}); err != nil {
		t.Fatal(err)
	}
	step, err := worker.Step(ctx, StepRequest{Until: 0.5, Inbound: []ArrivalRecord{}})
	if err != nil {
		t.Fatal(err)
	}
	if step.Events != 2 || step.ComputeS != 0.01 || len(step.Outbound) != 0 {
		t.Fatalf("step = %+v", step)
	}
	finish, err := worker.Finish(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(finish.Metrics) != `{"totals":{}}` {
		t.Fatalf("finish metrics = %s", finish.Metrics)
	}
}
