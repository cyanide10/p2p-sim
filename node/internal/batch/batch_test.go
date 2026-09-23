package batch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/config"
	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
)

// fakeClient returns deterministic per-seed results scattered around the
// M/M/1 values for lambda=0.8, mu=1 (W=5, L=4), optionally blocking on gate.
type fakeClient struct {
	gate chan struct{}
}

func (f *fakeClient) RunTask(ctx context.Context, p peers.Peer, t dispatch.Task) (dispatch.Result, error) {
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return dispatch.Result{}, ctx.Err()
		}
	}
	noise := math.Sin(float64(t.Seed)) * 0.3
	return dispatch.Result{
		TaskID: t.TaskID, PeerID: p.ID, Seed: t.Seed,
		MeanWaitTime: 5 + noise, MeanQueueLength: 4 + 0.8*noise, Utilization: 0.8,
		PacketsServed: 7000, RuntimeSeconds: 0.01,
	}, nil
}

func (f *fakeClient) Health(context.Context, peers.Peer) error { return nil }

func newManager(t *testing.T, c dispatch.PeerClient, defaults config.RunDefaults) *Manager {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	d := &dispatch.Dispatcher{
		Client: c,
		Config: dispatch.Config{MaxAttempts: 3, BackoffInitial: time.Millisecond, BackoffMax: time.Millisecond},
		Logger: logger,
	}
	list := []peers.Peer{{ID: "peer-1", URL: "http://peer-1:8000"}, {ID: "peer-2", URL: "http://peer-2:8000"}}
	return NewManager(context.Background(), d, list, "peer-1", defaults, time.Minute, logger)
}

func ptr[T any](v T) *T { return &v }

func waitDone(t *testing.T, b *Batch) {
	t.Helper()
	select {
	case <-b.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("batch did not finish")
	}
}

func TestResolveDefaultsAndOverrides(t *testing.T) {
	d := config.Default().Defaults
	now := time.UnixMilli(1_700_000_000_000)

	s, err := Resolve(Request{}, d, now)
	if err != nil {
		t.Fatal(err)
	}
	if s.Replications != 100 || s.Params.Lambda != 0.8 || s.BaseSeed != now.UnixMilli() {
		t.Fatalf("defaults not applied: %+v", s)
	}

	s, err = Resolve(Request{Replications: ptr(10), Lambda: ptr(0.5), BaseSeed: ptr(int64(42)), SerialBaseline: ptr(true)}, d, now)
	if err != nil {
		t.Fatal(err)
	}
	if s.Replications != 10 || s.Params.Lambda != 0.5 || s.Params.Mu != 1 || s.BaseSeed != 42 || !s.SerialBaseline {
		t.Fatalf("overrides not applied: %+v", s)
	}
}

func TestResolveValidation(t *testing.T) {
	d := config.Default().Defaults
	cases := map[string]Request{
		"too few reps":    {Replications: ptr(1)},
		"unstable":        {Lambda: ptr(1.0), Mu: ptr(1.0)},
		"negative lambda": {Lambda: ptr(-0.1)},
		"zero mu":         {Mu: ptr(0.0)},
		"no window":       {SimTime: ptr(100.0), WarmupTime: ptr(100.0)},
		"neg warmup":      {WarmupTime: ptr(-1.0)},
		"zero tolerance":  {TolerancePct: ptr(0.0)},
		"neg seed":        {BaseSeed: ptr(int64(-5))},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Resolve(req, d, time.Now())
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("err = %v, want ValidationError", err)
			}
		})
	}
}

func TestBatchEndToEndWithSerialBaseline(t *testing.T) {
	m := newManager(t, &fakeClient{}, config.Default().Defaults)
	b, err := m.Start(Request{Replications: ptr(60), BaseSeed: ptr(int64(1000)), SerialBaseline: ptr(true)})
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, b)

	r := b.Report()
	if r.State != "complete" || r.Verdict != "PASS" {
		t.Fatalf("state=%s verdict=%s detail=%s", r.State, r.Verdict, r.VerdictDetail)
	}
	if r.Tasks.Complete != 60 || len(r.FailedTasks) != 0 {
		t.Fatalf("tasks = %+v failed=%+v", r.Tasks, r.FailedTasks)
	}
	if r.MeanWaitTime.N != 60 || math.Abs(r.MeanWaitTime.Theoretical-5) > 1e-12 || math.Abs(r.MeanQueueLength.Theoretical-4) > 1e-12 {
		t.Fatalf("comparisons = %+v / %+v", r.MeanWaitTime, r.MeanQueueLength)
	}
	if r.TasksPerPeer["peer-1"]+r.TasksPerPeer["peer-2"] != 60 {
		t.Fatalf("tasks per peer = %v", r.TasksPerPeer)
	}
	if r.Timing.SerialWallSeconds == nil || r.Timing.Speedup == nil || r.Timing.SerialPeer != "peer-1" {
		t.Fatalf("serial timing missing: %+v", r.Timing)
	}
	if r.Timing.SerialResultsMatch == nil || !*r.Timing.SerialResultsMatch {
		t.Fatalf("serial results should match distributed ones: %+v", r.Timing)
	}
	if s := b.Status(); s.State != "complete" || s.SerialBaseline == nil || s.SerialBaseline.Complete != 60 {
		t.Fatalf("status = %+v", s)
	}
}

func TestBatchWithoutSerialBaseline(t *testing.T) {
	m := newManager(t, &fakeClient{}, config.Default().Defaults)
	b, err := m.Start(Request{Replications: ptr(10), SerialBaseline: ptr(false)})
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, b)
	r := b.Report()
	if r.Timing.SerialWallSeconds != nil || r.Timing.Speedup != nil || r.Phase != PhaseComplete {
		t.Fatalf("unexpected serial timing: %+v", r.Timing)
	}
}

func TestOnlyOneBatchAtATime(t *testing.T) {
	gate := make(chan struct{})
	m := newManager(t, &fakeClient{gate: gate}, config.Default().Defaults)

	first, err := m.Start(Request{Replications: ptr(4)})
	if err != nil {
		t.Fatal(err)
	}
	if r := first.Report(); r.Verdict != "PENDING" || r.State != "running" {
		t.Fatalf("running batch report: verdict=%s state=%s", r.Verdict, r.State)
	}

	running, err := m.Start(Request{Replications: ptr(4)})
	if !errors.Is(err, ErrBusy) || running != first {
		t.Fatalf("second start: err=%v", err)
	}

	close(gate)
	waitDone(t, first)

	second, err := m.Start(Request{Replications: ptr(4)})
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, second)
	if latest, _ := m.Get(""); latest != second {
		t.Fatal("Get(\"\") should return the latest batch")
	}
	if got, ok := m.Get(first.ID); !ok || got != first {
		t.Fatal("Get(id) should return earlier batches")
	}
}

func TestOldBatchesAreEvicted(t *testing.T) {
	m := newManager(t, &fakeClient{}, config.Default().Defaults)
	var first *Batch
	for i := 0; i < MaxRetainedBatches+3; i++ {
		b, err := m.Start(Request{Replications: ptr(2), SerialBaseline: ptr(false)})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = b
		}
		waitDone(t, b)
	}
	if n := len(m.batches); n != MaxRetainedBatches {
		t.Fatalf("retained %d batches, want %d", n, MaxRetainedBatches)
	}
	if _, ok := m.Get(first.ID); ok {
		t.Fatal("oldest batch should have been evicted")
	}
	if latest, ok := m.Get(""); !ok || latest == first {
		t.Fatal("latest batch must always be retained")
	}
}

func TestResultsMatch(t *testing.T) {
	a := []dispatch.Result{{Seed: 1, MeanWaitTime: 5}, {Seed: 2, MeanWaitTime: 6}}
	if m, ok := resultsMatch(a, []dispatch.Result{{Seed: 2, MeanWaitTime: 6}}); !ok || !m {
		t.Error("identical seeds should match")
	}
	if m, ok := resultsMatch(a, []dispatch.Result{{Seed: 1, MeanWaitTime: 5.1}}); !ok || m {
		t.Error("differing values should not match")
	}
	if _, ok := resultsMatch(a, []dispatch.Result{{Seed: 9}}); ok {
		t.Error("no overlap should report ok=false")
	}
}
