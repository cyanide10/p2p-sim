package runs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/store"
	"github.com/p2p-sim/gateway/internal/testnode"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func peerSource(t *testing.T, peers []config.Peer) *config.PeerSource {
	t.Helper()
	content := "peers:\n"
	for _, p := range peers {
		content += "  - id: " + p.ID + "\n    url: " + p.URL + "\n"
	}
	path := filepath.Join(t.TempDir(), "peers.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := config.NewPeerSource(path, quiet())
	if err != nil {
		t.Fatal(err)
	}
	return src
}

type fixture struct {
	nodes []*testnode.Node
	store *store.Store
	opts  Options
	dbDir string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	nodes, peers := testnode.Pool(t, 3)
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "g.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return &fixture{nodes: nodes, store: db, dbDir: dir, opts: Options{
		Store: db, Nodes: nodeclient.New(time.Second), Peers: peerSource(t, peers),
		Defaults: config.BuiltinDefaults(), PollInterval: 5 * time.Millisecond, LostAfter: 3,
		HistoryLimit: 100, MaxTrackers: 8, Log: quiet(),
	}}
}

func (f *fixture) manager(t *testing.T) *Manager {
	m := New(f.opts)
	t.Cleanup(func() { m.Shutdown(context.Background()) })
	return m
}

func waitState(t *testing.T, s *store.Store, runID, want string) store.Run {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		run, err := s.Get(context.Background(), runID)
		if err == nil && run.State == want {
			return run
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s state %q (err %v); want %q", runID, run.State, err, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func ptr[T any](v T) *T { return &v }

func TestCreateTracksToCompletionAndStoresReport(t *testing.T) {
	f := setup(t)
	m := f.manager(t)
	created, err := m.Create(context.Background(), CreateRequest{Coordinator: "node-2", Replications: ptr(40), BaseSeed: ptr(int64(42))})
	if err != nil {
		t.Fatal(err)
	}
	if created.RunID != EncodeRunID("node-2", created.BatchID) || created.BaseSeed != 42 {
		t.Fatalf("created %+v", created)
	}
	sent := f.nodes[1].RunRequests()
	if len(sent) != 1 || sent[0]["replications"] != float64(40) || sent[0]["lambda"] != 0.8 || sent[0]["serial_baseline"] != false {
		t.Fatalf("node received %v; want resolved parameters", sent)
	}
	run := waitState(t, f.store, created.RunID, store.StateComplete)
	var report struct{ Verdict string }
	if json.Unmarshal(run.Report, &report); report.Verdict != "PASS" {
		t.Fatalf("stored report %s", run.Report)
	}
	if run.Params.Replications != 40 || run.Params.BaseSeed != 42 {
		t.Fatalf("stored params %+v", run.Params)
	}
}

func TestOmittedSeedIsTakenFromTheNode(t *testing.T) {
	f := setup(t)
	created, err := f.manager(t).Create(context.Background(), CreateRequest{Coordinator: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, has := f.nodes[0].RunRequests()[0]["base_seed"]; has {
		t.Fatal("gateway sent a seed the client did not choose")
	}
	run, _ := f.store.Get(context.Background(), created.RunID)
	if run.Params.BaseSeed != created.BaseSeed || created.BaseSeed == 0 {
		t.Fatalf("stored seed %d, node seed %d", run.Params.BaseSeed, created.BaseSeed)
	}
}

func TestValidation(t *testing.T) {
	f := setup(t)
	m := f.manager(t)
	cases := map[string]CreateRequest{
		"unknown coordinator": {Coordinator: "node-9"},
		"unstable":            {Coordinator: "node-1", Lambda: ptr(1.0), Mu: ptr(1.0)},
		"warmup":              {Coordinator: "node-1", WarmupTime: ptr(20000.0)},
		"replications":        {Coordinator: "node-1", Replications: ptr(1)},
		"seed":                {Coordinator: "node-1", BaseSeed: ptr(int64(-1))},
	}
	for name, req := range cases {
		var v *ValidationError
		if _, err := m.Create(context.Background(), req); !errors.As(err, &v) {
			t.Errorf("%s: got %v; want ValidationError", name, err)
		}
	}
	for _, n := range f.nodes {
		if len(n.RunRequests()) != 0 {
			t.Fatal("an invalid request reached a node")
		}
	}
}

func TestBusyCoordinatorPassesThrough409(t *testing.T) {
	f := setup(t)
	f.nodes[0].SetBusy(true)
	_, err := f.manager(t).Create(context.Background(), CreateRequest{Coordinator: "node-1"})
	if !nodeclient.IsStatus(err, 409) {
		t.Fatalf("got %v; want node 409", err)
	}
	if _, total, _ := f.store.List(context.Background(), 10, 0); total != 0 {
		t.Fatal("a rejected run was recorded")
	}
}

func TestCoordinatorDiesMidBatch(t *testing.T) {
	f := setup(t)
	f.nodes[0].SetSteps(1000)
	m := f.manager(t)
	created, err := m.Create(context.Background(), CreateRequest{Coordinator: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return f.nodes[0].StatusCalls() >= 2 })
	f.nodes[0].SetDown(true)
	run := waitState(t, f.store, created.RunID, store.StateCoordinatorLost)
	if run.Status == nil {
		t.Fatal("no status snapshot was kept")
	}
	// Status now serves the stored snapshot marked stale.
	body, err := m.Status(context.Background(), created.RunID)
	if err != nil || !stale(body) {
		t.Fatalf("Status: %s, %v; want stale snapshot", body, err)
	}
	waitFor(t, func() bool { return m.Tracking() == 0 })
}

func TestForgottenBatchIsLostImmediately(t *testing.T) {
	f := setup(t)
	f.nodes[2].SetSteps(1000)
	f.nodes[2].Forget()
	created, _ := f.manager(t).Create(context.Background(), CreateRequest{Coordinator: "node-3"})
	waitState(t, f.store, created.RunID, store.StateCoordinatorLost)
}

func TestResumeAfterRestart(t *testing.T) {
	f := setup(t)
	f.nodes[0].SetSteps(1000)
	first := New(f.opts)
	created, err := first.Create(context.Background(), CreateRequest{Coordinator: "node-1"})
	if err != nil {
		t.Fatal(err)
	}
	first.Shutdown(context.Background())
	if first.Tracking() != 0 {
		t.Fatal("trackers survived shutdown")
	}
	f.nodes[0].SetSteps(1) // completes on the next poll
	second := f.manager(t)
	if err := second.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, f.store, created.RunID, store.StateComplete)
}

func TestShutdownStopsTrackers(t *testing.T) {
	f := setup(t)
	for _, n := range f.nodes {
		n.SetSteps(1000)
	}
	m := New(f.opts)
	for _, id := range []string{"node-1", "node-2", "node-3"} {
		if _, err := m.Create(context.Background(), CreateRequest{Coordinator: id}); err != nil {
			t.Fatal(err)
		}
	}
	if m.Tracking() != 3 {
		t.Fatalf("tracking %d; want 3", m.Tracking())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if m.Tracking() != 0 {
		t.Fatalf("tracking %d after shutdown; want 0", m.Tracking())
	}
}

func TestCompletedRunServesStoredDataAfterEviction(t *testing.T) {
	f := setup(t)
	m := f.manager(t)
	created, _ := m.Create(context.Background(), CreateRequest{Coordinator: "node-1"})
	waitState(t, f.store, created.RunID, store.StateComplete)
	f.nodes[0].Forget() // node evicted the batch
	for _, get := range []func(context.Context, string) (json.RawMessage, error){m.Status, m.Report} {
		body, err := get(context.Background(), created.RunID)
		if err != nil || stale(body) {
			t.Fatalf("got %s, %v; want the stored final data, not stale", body, err)
		}
	}
	if run, _ := f.store.Get(context.Background(), created.RunID); run.State != store.StateComplete {
		t.Fatalf("state %s; a completed run must stay complete", run.State)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stale(body json.RawMessage) bool {
	var v struct{ Stale bool }
	json.Unmarshal(body, &v)
	return v.Stale
}

func TestNetworkRunIsForwardedAndTracked(t *testing.T) {
	f := setup(t)
	m := f.manager(t)
	scenario := json.RawMessage(`{"duration":60,"nodes":[],"links":[],"flows":[]}`)
	created, err := m.Create(context.Background(), CreateRequest{Coordinator: "node-2", Kind: "network", Scenario: scenario, Replications: ptr(12)})
	if err != nil {
		t.Fatal(err)
	}
	sent := f.nodes[1].RunRequests()
	if len(sent) != 1 || sent[0]["replications"] != float64(12) || sent[0]["scenario"] == nil {
		t.Fatalf("node received %v", sent)
	}
	run := waitState(t, f.store, created.RunID, store.StateComplete)
	if run.Params.Kind != "network" || string(run.Params.Scenario) != string(scenario) || run.Params.BaseSeed != 99 {
		t.Fatalf("stored params %+v", run.Params)
	}
	for name, req := range map[string]CreateRequest{
		"no scenario":  {Coordinator: "node-1", Kind: "network"},
		"replications": {Coordinator: "node-1", Kind: "network", Scenario: scenario, Replications: ptr(1)},
		"unknown kind": {Coordinator: "node-1", Kind: "tcp"},
	} {
		var v *ValidationError
		if _, err := m.Create(context.Background(), req); !errors.As(err, &v) {
			t.Errorf("%s: got %v; want ValidationError", name, err)
		}
	}
}
