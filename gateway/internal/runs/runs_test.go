package runs

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/testnode"
)

func ptr[T any](v T) *T { return &v }

func TestIDRoundTrip(t *testing.T) {
	id := EncodeID("node-2", "batch-node-2-20261024T000000-abcdef")
	if strings.ContainsAny(id, "=+/") {
		t.Fatalf("id is not unpadded base64url: %s", id)
	}
	c, b, err := DecodeID(id)
	if err != nil || c != "node-2" || b != "batch-node-2-20261024T000000-abcdef" {
		t.Fatalf("got %q %q %v", c, b, err)
	}
}

func TestDecodeIDRejectsMalformed(t *testing.T) {
	for _, id := range []string{"", "!!!", EncodeID("", "b"), "WyJhIl0", "eyJhIjoxfQ"} {
		if _, _, err := DecodeID(id); err == nil {
			t.Errorf("DecodeID(%q) should fail", id)
		}
	}
}

func TestResolveAppliesDefaultsAndLeavesSeedToNode(t *testing.T) {
	r, err := Resolve(CreateRequest{Coordinator: "node-1", Replications: ptr(40)}, config.BuiltinDefaults())
	if err != nil {
		t.Fatal(err)
	}
	if r.Replications != 40 || r.Lambda != 0.8 || r.Mu != 1 || !r.SerialBaseline || r.BaseSeed != nil {
		t.Fatalf("unexpected resolution: %+v", r)
	}
	body, _ := json.Marshal(r)
	if strings.Contains(string(body), "base_seed") {
		t.Fatalf("omitted seed must not be forwarded: %s", body)
	}
}

func TestResolveValidation(t *testing.T) {
	cases := map[string]CreateRequest{
		"too few replications":  {Replications: ptr(1)},
		"too many replications": {Replications: ptr(100_001)},
		"zero lambda":           {Lambda: ptr(0.0)},
		"nan mu":                {Mu: ptr(math.NaN())},
		"unstable":              {Lambda: ptr(1.0), Mu: ptr(1.0)},
		"zero sim time":         {SimTime: ptr(0.0), WarmupTime: ptr(0.0)},
		"negative warmup":       {WarmupTime: ptr(-1.0)},
		"warmup equals sim":     {SimTime: ptr(100.0), WarmupTime: ptr(100.0)},
		"zero tolerance":        {TolerancePct: ptr(0.0)},
		"negative seed":         {BaseSeed: ptr(int64(-1))},
		"seed too large":        {BaseSeed: ptr(int64(MaxBrowserSeed - 99))},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Resolve(req, config.BuiltinDefaults())
			if _, ok := err.(*ValidationError); !ok {
				t.Fatalf("expected ValidationError, got %v", err)
			}
		})
	}
	if _, err := Resolve(CreateRequest{BaseSeed: ptr(int64(MaxBrowserSeed - 100))}, config.BuiltinDefaults()); err != nil {
		t.Fatalf("largest allowed seed rejected: %v", err)
	}
}

func rec(id string, state State) Record {
	return Record{RunID: id, BatchID: "b-" + id, Coordinator: "node-1", State: state}
}

func TestStoreEvictsOldestFinished(t *testing.T) {
	s := NewStore(2)
	_ = s.Add(rec("a", Running))
	_ = s.Add(rec("b", Complete))
	if !s.HasRoom() {
		t.Fatal("a finished record should be evictable")
	}
	if err := s.Add(rec("c", Running)); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Get("b"); ok {
		t.Fatal("b should have been evicted")
	}
	list, total := s.List(10, 0)
	if total != 2 || list[0].RunID != "c" || list[1].RunID != "a" {
		t.Fatalf("unexpected list: %+v", list)
	}
}

func TestStoreFullOfRunning(t *testing.T) {
	s := NewStore(1)
	_ = s.Add(rec("a", Running))
	if s.HasRoom() {
		t.Fatal("store should be full")
	}
	if err := s.Add(rec("b", Running)); err != ErrFull {
		t.Fatalf("expected ErrFull, got %v", err)
	}
}

func TestStoreListPaging(t *testing.T) {
	s := NewStore(10)
	for _, id := range []string{"a", "b", "c"} {
		_ = s.Add(rec(id, Complete))
	}
	list, total := s.List(1, 1)
	if total != 3 || len(list) != 1 || list[0].RunID != "b" {
		t.Fatalf("unexpected page: %+v", list)
	}
	if list, _ := s.List(5, 9); len(list) != 0 {
		t.Fatalf("offset past end should be empty: %+v", list)
	}
}

type harness struct {
	node    *testnode.Node
	store   *Store
	tracker *Tracker
	cancel  context.CancelFunc
	runID   string
}

func newHarness(t *testing.T, completeAfter int) *harness {
	t.Helper()
	n := testnode.New("node-1")
	n.Update(func(n *testnode.Node) { n.CompleteAfter = completeAfter })
	c := nodeclient.New(time.Second)
	run, err := c.Run(context.Background(), n.URL(), []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := NewStore(10)
	id := EncodeID("node-1", run.BatchID)
	_ = s.Add(Record{RunID: id, BatchID: run.BatchID, Coordinator: "node-1", State: Running})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tr := NewTracker(ctx, s, c, map[string]string{"node-1": n.URL()}, 5*time.Millisecond, 5, logger)
	h := &harness{node: n, store: s, tracker: tr, cancel: cancel, runID: id}
	t.Cleanup(func() {
		cancel()
		tr.Wait()
		n.Close()
	})
	return h
}

func (h *harness) waitFor(t *testing.T, want State) Record {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := h.store.Get(h.runID)
		if r.State == want {
			return r
		}
		time.Sleep(5 * time.Millisecond)
	}
	r, _ := h.store.Get(h.runID)
	t.Fatalf("state %q, want %q", r.State, want)
	return r
}

func TestTrackerStoresReportOnCompletion(t *testing.T) {
	h := newHarness(t, 3)
	h.tracker.Track(h.runID)
	r := h.waitFor(t, Complete)
	if !strings.Contains(string(r.Report), `"verdict":"PASS"`) || !strings.Contains(string(r.Status), `"state":"complete"`) {
		t.Fatalf("report %s status %s", r.Report, r.Status)
	}
	if calls := h.node.StatusCalls(); calls != 3 {
		t.Fatalf("expected polling to stop after completion, got %d status calls", calls)
	}
}

func TestTrackerLostOnNotFound(t *testing.T) {
	h := newHarness(t, 1000)
	h.node.Update(func(n *testnode.Node) { n.Lost = true })
	h.tracker.Track(h.runID)
	h.waitFor(t, CoordinatorLost)
}

func TestTrackerLostAfterRepeatedFailures(t *testing.T) {
	h := newHarness(t, 1000)
	h.tracker.Track(h.runID)
	time.Sleep(20 * time.Millisecond)
	h.node.Close()
	r := h.waitFor(t, CoordinatorLost)
	if r.Status == nil {
		t.Fatal("last good status should be kept")
	}
}

// flakyAPI answers status calls by pattern (true = fail), then reports complete.
type flakyAPI struct {
	pattern []bool
	calls   int
}

func (f *flakyAPI) Status(context.Context, string, string) (json.RawMessage, error) {
	i := f.calls
	f.calls++
	if i < len(f.pattern) {
		if f.pattern[i] {
			return nil, &nodeclient.Error{Kind: nodeclient.Unreachable, Message: "refused"}
		}
		return json.RawMessage(`{"state":"running"}`), nil
	}
	return json.RawMessage(`{"state":"complete"}`), nil
}

func (f *flakyAPI) Report(context.Context, string, string) (json.RawMessage, error) {
	return json.RawMessage(`{"verdict":"PASS"}`), nil
}

func TestTrackerSuccessResetsFailureCount(t *testing.T) {
	s := NewStore(1)
	_ = s.Add(rec("a", Running))
	// Four failures, a success, four more failures: never five in a row.
	api := &flakyAPI{pattern: []bool{true, true, true, true, false, true, true, true, true}}
	tr := NewTracker(context.Background(), s, api, map[string]string{"node-1": "http://unused"},
		time.Millisecond, 5, slog.New(slog.NewTextHandler(io.Discard, nil)))
	tr.Track("a")
	tr.Wait()
	if r, _ := s.Get("a"); r.State != Complete {
		t.Fatalf("state %q, want complete", r.State)
	}
}

func TestTrackerStopsOnCancel(t *testing.T) {
	h := newHarness(t, 1_000_000)
	h.tracker.Track(h.runID)
	time.Sleep(20 * time.Millisecond)
	h.cancel()
	done := make(chan struct{})
	go func() { h.tracker.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("tracker did not stop after cancellation")
	}
	if r, _ := h.store.Get(h.runID); r.State != Running {
		t.Fatalf("cancellation must not change state, got %q", r.State)
	}
}
