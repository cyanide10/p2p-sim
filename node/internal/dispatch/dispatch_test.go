package dispatch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/peers"
)

var testParams = SimParams{Lambda: 0.8, Mu: 1, SimTime: 1000, WarmupTime: 100}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// fakeClient routes calls to per-peer behaviour and records every attempt.
type fakeClient struct {
	mu       sync.Mutex
	run      map[string]func(t Task, call int) (Result, error)
	healthy  map[string]bool // default true
	calls    map[string]int
	attempts []string // "peer:task"
}

func newFake() *fakeClient {
	return &fakeClient{
		run:     map[string]func(Task, int) (Result, error){},
		healthy: map[string]bool{},
		calls:   map[string]int{},
	}
}

func okResult(t Task) Result {
	return Result{TaskID: t.TaskID, Seed: t.Seed, MeanWaitTime: float64(t.Seed), PacketsServed: 1}
}

func (f *fakeClient) RunTask(ctx context.Context, p peers.Peer, t Task) (Result, error) {
	f.mu.Lock()
	f.calls[p.ID]++
	call := f.calls[p.ID]
	f.attempts = append(f.attempts, p.ID+":"+t.TaskID)
	fn := f.run[p.ID]
	f.mu.Unlock()
	time.Sleep(time.Millisecond) // let other workers interleave
	if fn != nil {
		return fn(t, call)
	}
	return okResult(t), nil
}

func (f *fakeClient) Health(ctx context.Context, p peers.Peer) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if h, ok := f.healthy[p.ID]; ok && !h {
		return errors.New("down")
	}
	return nil
}

func peerList(ids ...string) []peers.Peer {
	out := make([]peers.Peer, len(ids))
	for i, id := range ids {
		out[i] = peers.Peer{ID: id, URL: "http://" + id + ":8000"}
	}
	return out
}

func newDispatcher(c PeerClient) *Dispatcher {
	return &Dispatcher{
		Client: c,
		Config: Config{MaxAttempts: 3, BackoffInitial: 5 * time.Millisecond, BackoffMax: 20 * time.Millisecond},
		Logger: discardLogger(),
	}
}

func runWithTimeout(t *testing.T, d *Dispatcher, ps []peers.Peer, tr *Tracker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	d.Run(ctx, ps, tr)
	if ctx.Err() != nil {
		t.Fatal("dispatch did not finish in time")
	}
}

func TestGenerateTasksSeedScheme(t *testing.T) {
	a := GenerateTasks("b1", 5, 1000, testParams)
	b := GenerateTasks("b1", 5, 1000, testParams)
	if len(a) != 5 {
		t.Fatalf("len = %d", len(a))
	}
	for i, task := range a {
		if task.Seed != 1000+int64(i) {
			t.Errorf("task %d seed = %d", i, task.Seed)
		}
		if task != b[i] {
			t.Errorf("task %d not reproducible", i)
		}
	}
	if a[3].TaskID != "b1-0003" {
		t.Errorf("task id = %q", a[3].TaskID)
	}
}

func TestAllTasksCompleteAcrossPeers(t *testing.T) {
	f := newFake()
	tr := NewTracker(GenerateTasks("b", 60, 1, testParams))
	runWithTimeout(t, newDispatcher(f), peerList("p1", "p2", "p3"), tr)

	c := tr.Counts()
	if c.Complete != 60 || c.Failed != 0 || c.Pending != 0 || c.Assigned != 0 {
		t.Fatalf("counts = %+v", c)
	}
	if len(f.attempts) != 60 {
		t.Fatalf("each task should be sent exactly once, got %d attempts", len(f.attempts))
	}
	for _, id := range []string{"p1", "p2", "p3"} {
		if f.calls[id] == 0 {
			t.Errorf("peer %s received no work", id)
		}
	}
	for i, r := range tr.Results() {
		if r.Seed != int64(1+i) || r.PeerID == "" {
			t.Fatalf("result %d = %+v", i, r)
		}
	}
}

func TestTransientFailureIsRetried(t *testing.T) {
	f := newFake()
	f.run["p2"] = func(t Task, call int) (Result, error) {
		if call == 1 {
			return Result{}, errors.New("connection reset")
		}
		return okResult(t), nil
	}
	tr := NewTracker(GenerateTasks("b", 20, 1, testParams))
	runWithTimeout(t, newDispatcher(f), peerList("p1", "p2"), tr)

	c := tr.Counts()
	if c.Complete != 20 || c.Failed != 0 || c.FailedAttempts != 1 {
		t.Fatalf("counts = %+v", c)
	}
	retried := 0
	for _, task := range tr.Tasks() {
		s, _ := tr.Get(task.TaskID)
		if s.Attempts == 2 {
			retried++
		}
	}
	if retried != 1 {
		t.Fatalf("expected exactly one task with 2 attempts, got %d", retried)
	}
}

func TestDeadPeerTasksAreReassigned(t *testing.T) {
	f := newFake()
	f.run["p2"] = func(Task, int) (Result, error) { return Result{}, errors.New("connection refused") }
	f.healthy["p2"] = false

	tr := NewTracker(GenerateTasks("b", 30, 1, testParams))
	runWithTimeout(t, newDispatcher(f), peerList("p1", "p2", "p3"), tr)

	c := tr.Counts()
	if c.Complete != 30 || c.Failed != 0 {
		t.Fatalf("counts = %+v", c)
	}
	// Backoff + health gating means the dead peer takes exactly one task.
	if f.calls["p2"] != 1 {
		t.Errorf("dead peer received %d tasks, want 1", f.calls["p2"])
	}
	for _, r := range tr.Results() {
		if r.PeerID == "p2" {
			t.Fatalf("result attributed to dead peer: %+v", r)
		}
	}
}

func TestPeerRecoversAfterHealthCheck(t *testing.T) {
	f := newFake()
	f.run["p1"] = func(t Task, call int) (Result, error) {
		if call <= 2 {
			return Result{}, errors.New("boom")
		}
		return okResult(t), nil
	}
	tr := NewTracker(GenerateTasks("b", 5, 1, testParams))
	runWithTimeout(t, newDispatcher(f), peerList("p1"), tr)
	if c := tr.Counts(); c.Complete != 5 || c.FailedAttempts != 2 {
		t.Fatalf("counts = %+v", c)
	}
}

func TestRetryCeilingMarksTaskFailed(t *testing.T) {
	f := newFake()
	f.run["p1"] = func(t Task, _ int) (Result, error) {
		if t.TaskID == "b-0002" {
			return Result{}, &PeerError{StatusCode: 400, Message: "simulation failed"}
		}
		return okResult(t), nil
	}
	tr := NewTracker(GenerateTasks("b", 5, 1, testParams))
	runWithTimeout(t, newDispatcher(f), peerList("p1"), tr)

	c := tr.Counts()
	if c.Complete != 4 || c.Failed != 1 || c.FailedAttempts != 3 {
		t.Fatalf("counts = %+v", c)
	}
	failed := tr.FailedTasks()
	if len(failed) != 1 || failed[0].Task.TaskID != "b-0002" || failed[0].Attempts != 3 ||
		!strings.Contains(failed[0].LastError, "simulation failed") {
		t.Fatalf("failed = %+v", failed)
	}
}

func TestAllPeersDownStopsAtContextDeadline(t *testing.T) {
	f := newFake()
	f.run["p1"] = func(Task, int) (Result, error) { return Result{}, errors.New("refused") }
	f.healthy["p1"] = false

	tr := NewTracker(GenerateTasks("b", 4, 1, testParams))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		newDispatcher(f).Run(ctx, peerList("p1"), tr)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context deadline")
	}
	if c := tr.Counts(); c.Failed != 4 || c.Pending != 0 || c.Assigned != 0 {
		t.Fatalf("counts = %+v", c)
	}
}

func TestEmptyTaskList(t *testing.T) {
	tr := NewTracker(nil)
	runWithTimeout(t, newDispatcher(newFake()), peerList("p1"), tr)
}

func TestBackoff(t *testing.T) {
	ms := time.Millisecond
	cases := map[int]time.Duration{1: 100 * ms, 2: 200 * ms, 3: 400 * ms, 4: 800 * ms, 5: time.Second, 50: time.Second}
	for streak, want := range cases {
		if got := Backoff(streak, 100*ms, time.Second); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", streak, got, want)
		}
	}
}

// --- HTTPClient against an in-process test server ---

func TestHTTPClient(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /task", func(w http.ResponseWriter, r *http.Request) {
		var task Task
		_ = jsonDecode(r, &task)
		switch task.TaskID {
		case "ok":
			writeJSON(w, 200, Result{TaskID: "ok", PeerID: "srv", Seed: task.Seed, MeanWaitTime: 4.9})
		case "bad":
			writeJSON(w, 400, map[string]string{"task_id": "bad", "error": "invalid parameters: rho >= 1"})
		case "wrong":
			writeJSON(w, 200, Result{TaskID: "other", Seed: task.Seed})
		case "slow":
			time.Sleep(300 * time.Millisecond)
			writeJSON(w, 200, Result{TaskID: "slow", Seed: task.Seed})
		}
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := peers.Peer{ID: "srv", URL: srv.URL}
	c := NewHTTPClient(100*time.Millisecond, 100*time.Millisecond)
	ctx := context.Background()

	res, err := c.RunTask(ctx, p, Task{TaskID: "ok", Seed: 9})
	if err != nil || res.MeanWaitTime != 4.9 || res.PeerID != "srv" {
		t.Fatalf("ok: res=%+v err=%v", res, err)
	}

	_, err = c.RunTask(ctx, p, Task{TaskID: "bad", Seed: 9})
	var pe *PeerError
	if !errors.As(err, &pe) || pe.StatusCode != 400 || !strings.Contains(pe.Message, "rho >= 1") {
		t.Fatalf("bad: err=%v", err)
	}

	if _, err = c.RunTask(ctx, p, Task{TaskID: "wrong", Seed: 9}); err == nil {
		t.Fatal("wrong: mismatched task id should fail")
	}

	start := time.Now()
	_, err = c.RunTask(ctx, p, Task{TaskID: "slow", Seed: 9})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("slow: err=%v", err)
	}
	if time.Since(start) > 250*time.Millisecond {
		t.Fatal("slow: timeout was not enforced")
	}

	if err := c.Health(ctx, p); err != nil {
		t.Fatalf("health: %v", err)
	}
	if err := c.Health(ctx, peers.Peer{ID: "gone", URL: "http://127.0.0.1:1"}); err == nil {
		t.Fatal("health of unreachable peer should fail")
	}
}
