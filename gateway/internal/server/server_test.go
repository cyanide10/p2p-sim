package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
	"github.com/p2p-sim/gateway/internal/testnode"
)

type gateway struct {
	url   string
	store *runs.Store
}

type opts struct {
	timeout      time.Duration
	pollInterval time.Duration
}

func newGateway(t *testing.T, o opts, nodes ...*testnode.Node) *gateway {
	t.Helper()
	if o.timeout == 0 {
		o.timeout = time.Second
	}
	if o.pollInterval == 0 {
		o.pollInterval = 5 * time.Millisecond
	}
	peers := testnode.Peers(nodes...)
	urls := map[string]string{}
	for _, p := range peers {
		urls[p.ID] = p.URL
	}
	ctx, cancel := context.WithCancel(context.Background())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := nodeclient.New(o.timeout)
	store := runs.NewStore(10)
	tracker := runs.NewTracker(ctx, store, client, urls, o.pollInterval, 5, logger)
	srv := httptest.NewServer(New(Deps{
		Peers: peers, Defaults: config.BuiltinDefaults(), Client: client,
		Store: store, Tracker: tracker, Logger: logger, Version: "test",
	}))
	t.Cleanup(func() {
		srv.Close()
		cancel()
		tracker.Wait()
	})
	return &gateway{url: srv.URL, store: store}
}

func (g *gateway) do(t *testing.T, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, g.url+path, strings.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	data, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("%s %s: non-JSON body %q", method, path, data)
	}
	return resp.StatusCode, out
}

func (g *gateway) start(t *testing.T, body string) string {
	t.Helper()
	code, out := g.do(t, http.MethodPost, "/api/runs", body)
	if code != http.StatusAccepted {
		t.Fatalf("start: %d %v", code, out)
	}
	return out["run_id"].(string)
}

func (g *gateway) waitState(t *testing.T, id string, want runs.State) runs.Record {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if r, _ := g.store.Get(id); r.State == want {
			return r
		}
		time.Sleep(5 * time.Millisecond)
	}
	r, _ := g.store.Get(id)
	t.Fatalf("state %q, want %q", r.State, want)
	return r
}

func TestHealthzAndConfig(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)

	if code, out := g.do(t, http.MethodGet, "/healthz", ""); code != 200 || out["status"] != "ok" {
		t.Fatalf("healthz: %d %v", code, out)
	}
	code, out := g.do(t, http.MethodGet, "/api/config", "")
	defaults := out["defaults"].(map[string]any)
	if code != 200 || defaults["replications"] != 100.0 || out["gateway_version"] != "test" {
		t.Fatalf("config: %d %v", code, out)
	}
	if _, has := defaults["base_seed"]; has {
		t.Fatal("defaults must not include base_seed")
	}
	if peers := out["peers"].([]any); len(peers) != 1 {
		t.Fatalf("peers: %v", peers)
	}
}

func TestCluster(t *testing.T) {
	a, b := testnode.New("node-1"), testnode.New("node-2")
	defer a.Close()
	g := newGateway(t, opts{}, a, b)
	b.Close()
	code, out := g.do(t, http.MethodGet, "/api/cluster", "")
	nodes := out["nodes"].([]any)
	if code != 200 || len(nodes) != 2 || nodes[1].(map[string]any)["healthy"] != false {
		t.Fatalf("cluster: %d %v", code, out)
	}
}

func TestRunToReport(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.CompleteAfter = 3 })
	g := newGateway(t, opts{}, n)

	id := g.start(t, `{"coordinator":"node-1","replications":40,"lambda":0.5,"base_seed":7}`)
	coord, batch, err := runs.DecodeID(id)
	if err != nil || coord != "node-1" || batch != "batch-node-1-1" {
		t.Fatalf("run id %q decodes to %q %q %v", id, coord, batch, err)
	}

	var sent map[string]any
	_ = json.Unmarshal(n.RunBodies()[0], &sent)
	if sent["lambda"] != 0.5 || sent["mu"] != 1.0 || sent["base_seed"] != 7.0 || sent["serial_baseline"] != true {
		t.Fatalf("forwarded body: %v", sent)
	}

	rec := g.waitState(t, id, runs.Complete)
	if rec.Params.BaseSeed != 7 || rec.Params.Replications != 40 || rec.Report == nil {
		t.Fatalf("record: %+v", rec)
	}

	code, out := g.do(t, http.MethodGet, "/api/runs/"+id+"/report", "")
	if code != 200 || out["verdict"] != "PASS" || out["stale"] != false {
		t.Fatalf("report: %d %v", code, out)
	}
	code, out = g.do(t, http.MethodGet, "/api/runs/"+id, "")
	if code != 200 || out["state"] != "complete" || out["report"] == nil {
		t.Fatalf("record: %d %v", code, out)
	}
}

func TestOmittedSeedUsesNodeChoice(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)
	id := g.start(t, `{"coordinator":"node-1"}`)
	if bytes.Contains(n.RunBodies()[0], []byte("base_seed")) {
		t.Fatalf("seed forwarded: %s", n.RunBodies()[0])
	}
	if r, _ := g.store.Get(id); r.Params.BaseSeed != 1761300000000 {
		t.Fatalf("stored seed %d", r.Params.BaseSeed)
	}
}

func TestRunRequestErrors(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)

	cases := map[string]string{
		"invalid params":      `{"coordinator":"node-1","lambda":2}`,
		"missing coordinator": `{"replications":10}`,
		"unknown coordinator": `{"coordinator":"node-9"}`,
		"unknown field":       `{"coordinator":"node-1","color":"blue"}`,
		"malformed":           `{"coordinator":`,
		"too large":           `{"coordinator":"node-1","x":"` + strings.Repeat("a", 2<<20) + `"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			code, out := g.do(t, http.MethodPost, "/api/runs", body)
			if code != http.StatusBadRequest || out["error"] == "" {
				t.Fatalf("%d %v", code, out)
			}
		})
	}
	if len(n.RunBodies()) != 0 {
		t.Fatal("invalid requests must not reach the node")
	}
}

func TestConflictPassthrough(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.RunStatus = http.StatusConflict })
	g := newGateway(t, opts{}, n)
	code, out := g.do(t, http.MethodPost, "/api/runs", `{"coordinator":"node-1"}`)
	if code != http.StatusConflict || out["error"] != "a batch is already running on this node" {
		t.Fatalf("%d %v", code, out)
	}
	if _, has := out["batch_id"]; !has {
		t.Fatalf("node body not passed through: %v", out)
	}
}

func TestNodeDownAndSlow(t *testing.T) {
	down := testnode.New("node-1")
	slow := testnode.New("node-2")
	defer slow.Close()
	slow.Update(func(n *testnode.Node) { n.Delay = time.Second })
	g := newGateway(t, opts{timeout: 50 * time.Millisecond}, down, slow)
	down.Close()

	if code, _ := g.do(t, http.MethodPost, "/api/runs", `{"coordinator":"node-1"}`); code != http.StatusBadGateway {
		t.Fatalf("down node: %d", code)
	}
	if code, _ := g.do(t, http.MethodPost, "/api/runs", `{"coordinator":"node-2"}`); code != http.StatusGatewayTimeout {
		t.Fatalf("slow node: %d", code)
	}
}

func TestStatusFallsBackToStoredCopy(t *testing.T) {
	n := testnode.New("node-1")
	n.Update(func(n *testnode.Node) { n.CompleteAfter = 1_000_000 })
	g := newGateway(t, opts{pollInterval: time.Hour}, n)
	id := g.start(t, `{"coordinator":"node-1"}`)

	code, out := g.do(t, http.MethodGet, "/api/runs/"+id+"/status", "")
	if code != 200 || out["stale"] != false || out["state"] != "running" {
		t.Fatalf("live status: %d %v", code, out)
	}
	n.Close()
	code, out = g.do(t, http.MethodGet, "/api/runs/"+id+"/status", "")
	if code != 200 || out["stale"] != true || out["state"] != "running" {
		t.Fatalf("stale status: %d %v", code, out)
	}
}

func TestReportFallbackAfterNodeForgets(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)
	id := g.start(t, `{"coordinator":"node-1"}`)
	g.waitState(t, id, runs.Complete)

	n.Update(func(n *testnode.Node) { n.Lost = true })
	code, out := g.do(t, http.MethodGet, "/api/runs/"+id+"/report", "")
	if code != 200 || out["stale"] != true || out["verdict"] != "PASS" {
		t.Fatalf("%d %v", code, out)
	}
}

func TestNoStoredCopyAfterNodeForgets(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.CompleteAfter = 1_000_000 })
	g := newGateway(t, opts{pollInterval: time.Hour}, n)
	id := g.start(t, `{"coordinator":"node-1"}`)
	g.waitState(t, id, runs.Running)
	n.Update(func(n *testnode.Node) { n.Lost = true })

	code, out := g.do(t, http.MethodGet, "/api/runs/"+id+"/report", "")
	if code != http.StatusNotFound || out["error"] != "coordinator no longer holds this batch" {
		t.Fatalf("%d %v", code, out)
	}
}

func TestProvisionalReportIsNotStored(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.CompleteAfter = 1_000_000 })
	g := newGateway(t, opts{pollInterval: time.Hour}, n)
	id := g.start(t, `{"coordinator":"node-1"}`)

	code, out := g.do(t, http.MethodGet, "/api/runs/"+id+"/report", "")
	if code != 200 || out["verdict"] != "PENDING" {
		t.Fatalf("%d %v", code, out)
	}
	if r, _ := g.store.Get(id); r.Report != nil {
		t.Fatalf("provisional report was stored: %s", r.Report)
	}
}

func TestUnknownRuns(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)
	for _, id := range []string{"not-base64!", runs.EncodeID("node-1", "batch-never")} {
		for _, suffix := range []string{"", "/status", "/report"} {
			if code, _ := g.do(t, http.MethodGet, "/api/runs/"+id+suffix, ""); code != http.StatusNotFound {
				t.Fatalf("%s%s: %d", id, suffix, code)
			}
		}
	}
	if code, _ := g.do(t, http.MethodGet, "/api/nothing", ""); code != http.StatusNotFound {
		t.Fatalf("unknown route: %d", code)
	}
}

func TestListRuns(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	g := newGateway(t, opts{}, n)
	first := g.start(t, `{"coordinator":"node-1"}`)
	second := g.start(t, `{"coordinator":"node-1"}`)

	code, out := g.do(t, http.MethodGet, "/api/runs?limit=1", "")
	list := out["runs"].([]any)
	if code != 200 || out["total"] != 2.0 || len(list) != 1 || list[0].(map[string]any)["run_id"] != second {
		t.Fatalf("%d %v", code, out)
	}
	_, out = g.do(t, http.MethodGet, "/api/runs?limit=1&offset=1", "")
	if out["runs"].([]any)[0].(map[string]any)["run_id"] != first {
		t.Fatalf("second page: %v", out)
	}
	_, out = g.do(t, http.MethodGet, "/api/runs?limit=999", "")
	if out["limit"] != 200.0 {
		t.Fatalf("limit not clamped: %v", out)
	}
	for _, q := range []string{"limit=-1", "offset=x", "limit=1.5"} {
		if code, _ := g.do(t, http.MethodGet, "/api/runs?"+q, ""); code != http.StatusBadRequest {
			t.Fatalf("%s: %d", q, code)
		}
	}
}
