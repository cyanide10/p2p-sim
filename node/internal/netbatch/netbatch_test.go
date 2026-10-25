package netbatch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

// fakePool answers every task with metrics derived from the seed and records
// which peer ran it and what scenario it carried.
type fakePool struct {
	mu        sync.Mutex
	scenarios map[string]int
	failPeer  string
}

func (f *fakePool) RunTask(ctx context.Context, p peers.Peer, t dispatch.Task) (dispatch.Result, error) {
	f.mu.Lock()
	f.scenarios[string(t.Network)]++
	f.mu.Unlock()
	if p.ID == f.failPeer {
		return dispatch.Result{}, errors.New("node down")
	}
	time.Sleep(2 * time.Millisecond)   // like a real simulation, so work spreads over the pool
	delay := 1 + float64(t.Seed%10)/10 // 1.0 .. 1.9
	metrics := fmt.Sprintf(`{"duration":100,"flows":{"f1":{"sent":100,"delivered":90,"mean_delay":%g,"p95_delay":null}},`+
		`"links":{"l1":{"utilization":0.5}},"routers":{"r1":{"utilization":0.25,"drops":%d}},`+
		`"totals":{"sent":100,"delivered":90,"loss_rate":0.1},`+
		`"series":{"bin_width":2.5,"delivered_rate":[1,2],"dropped_rate":[0,0],"mean_delay":[null,%g],"flows":{"f1":[1,2]}}}`,
		delay, t.Seed%3, delay)
	return dispatch.Result{TaskID: t.TaskID, PeerID: p.ID, Seed: t.Seed, RuntimeSeconds: 0.01, Network: task.RawJSON(metrics)}, nil
}

// Health fails for the dead peer, as a real health check would.
func (f *fakePool) Health(_ context.Context, p peers.Peer) error {
	if p.ID == f.failPeer {
		return errors.New("node down")
	}
	return nil
}

type fakeValidator struct{ err error }

func (v fakeValidator) Validate(context.Context, []byte) (sim.Summary, error) {
	return sim.Summary{OK: true, Nodes: 3, Links: 2, Flows: 1, PeakRate: 10}, v.err
}

func manager(t *testing.T, pool *fakePool, v Validator) *Manager {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	d := &dispatch.Dispatcher{Client: pool, Config: dispatch.Config{MaxAttempts: 3, BackoffInitial: time.Millisecond, BackoffMax: time.Millisecond}, Logger: log}
	list := []peers.Peer{{ID: "node-1"}, {ID: "node-2"}, {ID: "node-3"}}
	return NewManager(context.Background(), d, list, "node-1", v, time.Minute, log)
}

func ptr[T any](v T) *T { return &v }

func TestBatchRunsEveryReplicationAndAggregates(t *testing.T) {
	pool := &fakePool{scenarios: map[string]int{}}
	m := manager(t, pool, fakeValidator{})
	b, err := m.Start(context.Background(), Request{Scenario: []byte(`{"duration":100}`), Replications: ptr(20), BaseSeed: ptr(int64(0))})
	if err != nil {
		t.Fatal(err)
	}
	<-b.Done()
	if pool.scenarios[`{"duration":100}`] != 20 {
		t.Fatalf("scenario dispatched %v; want 20 tasks carrying it", pool.scenarios)
	}
	r := b.Report()
	if r.Verdict != "COMPLETE" || r.Tasks.Complete != 20 || len(r.TasksPerPeer) != 3 {
		t.Fatalf("report %s %+v %v", r.Verdict, r.Tasks, r.TasksPerPeer)
	}
	d := r.Flows["f1"]["mean_delay"]
	if d == nil || d.N != 20 || d.Mean < 1.4 || d.Mean > 1.5 || !(d.CI95Low < d.Mean && d.Mean < d.CI95High) {
		t.Fatalf("mean_delay estimate %+v", d)
	}
	if r.Flows["f1"]["p95_delay"] != nil {
		t.Fatal("an all-null metric must aggregate to null")
	}
	if math.Abs(r.Links["l1"]["utilization"].Mean-0.5) > 1e-12 || math.Abs(r.Totals["loss_rate"].Mean-0.1) > 1e-12 {
		t.Fatalf("links/totals %+v %+v", r.Links, r.Totals)
	}
	if r.Series.MeanDelay.Mean[0] != nil || r.Series.MeanDelay.Mean[1] == nil || *r.Series.DeliveredRate.Mean[1] != 2 {
		t.Fatalf("series %+v", r.Series)
	}
	if st := b.Status(); st.State != "complete" || st.Kind != "network" || st.Complete != 20 {
		t.Fatalf("status %+v", st)
	}
}

func TestFailedNodeTasksMoveElsewhere(t *testing.T) {
	pool := &fakePool{scenarios: map[string]int{}, failPeer: "node-2"}
	b, err := manager(t, pool, fakeValidator{}).Start(context.Background(), Request{Scenario: []byte(`{}`), Replications: ptr(12)})
	if err != nil {
		t.Fatal(err)
	}
	<-b.Done()
	r := b.Report()
	if r.Tasks.Complete != 12 || r.TasksPerPeer["node-2"] != 0 || r.Tasks.FailedAttempts == 0 {
		t.Fatalf("tasks %+v per peer %v", r.Tasks, r.TasksPerPeer)
	}
}

func TestValidationAndBusy(t *testing.T) {
	pool := &fakePool{scenarios: map[string]int{}}
	bad := manager(t, pool, fakeValidator{err: &sim.ScenarioError{Msg: "add at least one flow"}})
	_, err := bad.Start(context.Background(), Request{Scenario: []byte(`{}`)})
	var ve *ValidationError
	if !errors.As(err, &ve) || ve.Msg != "add at least one flow" {
		t.Fatalf("got %v; want the validator's message", err)
	}
	m := manager(t, pool, fakeValidator{})
	for _, req := range []Request{{}, {Scenario: []byte(`{}`), Replications: ptr(1)}, {Scenario: []byte(`{}`), BaseSeed: ptr(int64(-1))}} {
		if _, err := m.Start(context.Background(), req); !errors.As(err, &ve) {
			t.Errorf("%+v: got %v; want ValidationError", req, err)
		}
	}
	first, _ := m.Start(context.Background(), Request{Scenario: []byte(`{}`), Replications: ptr(600)})
	if _, err := m.Start(context.Background(), Request{Scenario: []byte(`{}`)}); !errors.Is(err, ErrBusy) {
		t.Fatalf("got %v; want ErrBusy while %s runs", err, first.ID)
	}
	<-first.Done()
}
