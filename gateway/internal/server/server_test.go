package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
	"github.com/p2p-sim/gateway/internal/store"
	"github.com/p2p-sim/gateway/internal/testnode"
)

var bundle = fstest.MapFS{
	"index.html":       {Data: []byte("<!doctype html><title>p2p-sim</title>")},
	"assets/app-1.js":  {Data: []byte("console.log(1)")},
	"assets/style.css": {Data: []byte("body{}")},
}

type env struct {
	nodes   []*testnode.Node
	handler http.Handler
	runs    *runs.Manager
	store   *store.Store
}

func setup(t *testing.T, token string, static fstest.MapFS) *env {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	nodes, peers := testnode.Pool(t, 3)
	content := "peers:\n"
	for _, p := range peers {
		content += "  - id: " + p.ID + "\n    url: " + p.URL + "\n"
	}
	path := filepath.Join(t.TempDir(), "peers.yaml")
	os.WriteFile(path, []byte(content), 0o600)
	src, err := config.NewPeerSource(path, log)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	client := nodeclient.New(300 * time.Millisecond)
	manager := runs.New(runs.Options{Store: db, Nodes: client, Peers: src, Defaults: config.BuiltinDefaults(),
		PollInterval: 5 * time.Millisecond, LostAfter: 3, HistoryLimit: 100, MaxTrackers: 8, Log: log})
	t.Cleanup(func() { manager.Shutdown(context.Background()) })
	h := Handler(Options{Peers: src, Nodes: client, Runs: manager, Defaults: config.BuiltinDefaults(),
		Token: token, Version: "test", Static: static, Log: log})
	return &env{nodes: nodes, handler: h, runs: manager, store: db}
}

func (e *env) do(method, target, body string, header ...string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func TestConfigClusterHealthz(t *testing.T) {
	e := setup(t, "", bundle)
	if rec := e.do("GET", "/healthz", ""); rec.Code != 200 {
		t.Fatalf("healthz %d", rec.Code)
	}
	var cfg struct {
		Defaults config.RunDefaults
		Peers    []config.Peer
		Features map[string]bool
	}
	decode(t, e.do("GET", "/api/config", ""), &cfg)
	if len(cfg.Peers) != 3 || cfg.Defaults.Replications != 100 || cfg.Features["task_grid"] {
		t.Fatalf("config %+v", cfg)
	}
	e.nodes[2].SetDown(true)
	var cluster struct {
		Nodes []struct {
			ID      string
			Healthy bool
		}
	}
	rec := e.do("GET", "/api/cluster", "")
	decode(t, rec, &cluster)
	if rec.Code != 200 || len(cluster.Nodes) != 3 || !cluster.Nodes[0].Healthy || cluster.Nodes[2].Healthy {
		t.Fatalf("cluster %d %+v", rec.Code, cluster)
	}
}

func TestRunLifecycleOverHTTP(t *testing.T) {
	e := setup(t, "", bundle)
	rec := e.do("POST", "/api/runs", `{"coordinator":"node-1","replications":30,"base_seed":7}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create %d %s", rec.Code, rec.Body)
	}
	var created struct {
		RunID string `json:"run_id"`
	}
	decode(t, rec, &created)
	deadline := time.Now().Add(3 * time.Second)
	for {
		var run struct{ State string }
		decode(t, e.do("GET", "/api/runs/"+created.RunID, ""), &run)
		if run.State == "complete" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run state %q", run.State)
		}
		time.Sleep(5 * time.Millisecond)
	}
	var report struct {
		Verdict string
		Stale   *bool
	}
	decode(t, e.do("GET", "/api/runs/"+created.RunID+"/report", ""), &report)
	if report.Verdict != "PASS" || report.Stale == nil || *report.Stale {
		t.Fatalf("report %+v", report)
	}
	var list struct {
		Runs  []json.RawMessage
		Total int
		Limit int
	}
	decode(t, e.do("GET", "/api/runs?limit=500", ""), &list)
	if list.Total != 1 || len(list.Runs) != 1 || list.Limit != maxListLimit {
		t.Fatalf("list %+v", list)
	}
}

func TestErrorMapping(t *testing.T) {
	e := setup(t, "", bundle)
	e.nodes[0].SetBusy(true)
	e.nodes[1].SetDown(true)
	e.nodes[2].SetDelay(time.Second)
	cases := []struct {
		name, method, target, body string
		want                       int
		contains                   string
	}{
		{"busy passthrough", "POST", "/api/runs", `{"coordinator":"node-1"}`, 409, "batch-existing"},
		{"unreachable", "POST", "/api/runs", `{"coordinator":"node-2"}`, 502, "unreachable"},
		{"timeout", "POST", "/api/runs", `{"coordinator":"node-3"}`, 504, "timed out"},
		{"validation", "POST", "/api/runs", `{"coordinator":"node-1","lambda":2}`, 400, "lambda"},
		{"unknown field", "POST", "/api/runs", `{"coordinator":"node-1","lamda":0.5}`, 400, "unknown field"},
		{"trailing data", "POST", "/api/runs", `{"coordinator":"node-1"} {}`, 400, "unexpected data"},
		{"body too large", "POST", "/api/runs", `{"coordinator":"` + strings.Repeat("x", 1<<20) + `"}`, 413, "1 MiB"},
		{"unknown run", "GET", "/api/runs/nope", "", 404, "not found"},
		{"unknown run status", "GET", "/api/runs/nope/status", "", 404, "not found"},
		{"bad limit", "GET", "/api/runs?limit=-1", "", 400, "limit"},
		{"bad offset", "GET", "/api/runs?offset=x", "", 400, "offset"},
		{"unknown endpoint", "GET", "/api/nope", "", 404, "no such"},
		{"wrong method", "DELETE", "/api/runs", "", 405, "method"},
	}
	for _, c := range cases {
		rec := e.do(c.method, c.target, c.body)
		if rec.Code != c.want || !strings.Contains(rec.Body.String(), c.contains) {
			t.Errorf("%s: %d %s; want %d containing %q", c.name, rec.Code, rec.Body, c.want, c.contains)
		}
	}
}

func TestStaleStatusWhenCoordinatorDown(t *testing.T) {
	e := setup(t, "", bundle)
	e.nodes[0].SetSteps(1000)
	var created struct {
		RunID string `json:"run_id"`
	}
	decode(t, e.do("POST", "/api/runs", `{"coordinator":"node-1"}`), &created)
	deadline := time.Now().Add(3 * time.Second)
	for e.nodes[0].StatusCalls() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("tracker never polled")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.nodes[0].SetDown(true)
	var status struct {
		State string
		Stale bool
	}
	rec := e.do("GET", "/api/runs/"+created.RunID+"/status", "")
	decode(t, rec, &status)
	if rec.Code != 200 || !status.Stale || status.State != "running" {
		t.Fatalf("status %d %s; want stored snapshot marked stale", rec.Code, rec.Body)
	}
}

func TestAuth(t *testing.T) {
	e := setup(t, "s3cret", bundle)
	if rec := e.do("GET", "/api/config", ""); rec.Code != 401 {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := e.do("GET", "/api/config", "", "Authorization", "Bearer wrong"); rec.Code != 401 {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	if rec := e.do("GET", "/api/config", "", "Authorization", "Bearer s3cret"); rec.Code != 200 {
		t.Fatalf("right token: %d", rec.Code)
	}
	for _, open := range []string{"/healthz", "/", "/assets/app-1.js"} {
		if rec := e.do("GET", open, ""); rec.Code != 200 {
			t.Fatalf("%s needs no token, got %d", open, rec.Code)
		}
	}
}

func TestStaticServing(t *testing.T) {
	e := setup(t, "", bundle)
	rec := e.do("GET", "/", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<title>p2p-sim") || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'self'") {
		t.Fatalf("CSP %q", csp)
	}
	rec = e.do("GET", "/assets/app-1.js", "")
	if rec.Code != 200 || rec.Body.String() != "console.log(1)" || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	// Client routes and traversal attempts get the index (or the router's
	// redirect to the cleaned path); nothing outside the bundle is served.
	for _, path := range []string{"/live/abc", "/../../etc/passwd", "/assets/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets"} {
		rec := e.do("GET", path, "")
		switch {
		case rec.Code == 200 && strings.Contains(rec.Body.String(), "<title>p2p-sim"):
		case rec.Code == http.StatusTemporaryRedirect && !strings.Contains(rec.Header().Get("Location"), ".."):
		default:
			t.Errorf("%s: %d %q; want the index fallback or a redirect to a clean path", path, rec.Code, rec.Body)
		}
	}
	if rec := e.do("POST", "/", "x"); rec.Code != 405 {
		t.Fatalf("POST /: %d", rec.Code)
	}
}

func TestStaticWithoutBundle(t *testing.T) {
	e := setup(t, "", fstest.MapFS{".placeholder": {Data: []byte("x")}})
	rec := e.do("GET", "/", "")
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "not embedded") {
		t.Fatalf("got %d %q; want the not-built page", rec.Code, rec.Body)
	}
}

func TestLiveStreamRelay(t *testing.T) {
	e := setup(t, "", bundle)
	srv := httptest.NewServer(e.handler)
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/api/stream?node=node-2&lambda=0.8&mu=1&speed=10&duration=10&seed=1&evil=1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("got %d %v", resp.StatusCode, resp.Header)
	}
	if strings.Count(string(body), "data: ") != 3 || !strings.Contains(string(body), `"type":"done"`) {
		t.Fatalf("body %q", body)
	}
	queries := e.nodes[1].StreamQueries()
	if len(queries) != 1 || strings.Contains(queries[0], "evil") || !strings.Contains(queries[0], "seed=1") {
		t.Fatalf("node received %v; want only the stream parameters", queries)
	}

	e.nodes[0].SetStreamBusy(true)
	for target, want := range map[string]int{
		"/api/stream?node=node-1&lambda=0.8&mu=1": 503,
		"/api/stream?node=node-9&lambda=0.8&mu=1": 400,
		"/api/stream?node=node-3&mu=1":            400,
	} {
		if rec := e.do("GET", target, ""); rec.Code != want {
			t.Errorf("%s: %d %s; want %d", target, rec.Code, rec.Body, want)
		}
	}
}

func TestNetStreamRelay(t *testing.T) {
	e := setup(t, "", bundle)
	srv := httptest.NewServer(e.handler)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/api/netstream", "application/json",
		strings.NewReader(`{"node":"node-3","scenario":{"duration":30},"speed":2,"seed":4}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"speed":2`) || !strings.Contains(string(body), `"duration":30`) ||
		strings.Contains(string(body), `"node"`) {
		t.Fatalf("got %d %s; want the node to receive {scenario, speed, seed} only", resp.StatusCode, body)
	}
	if rec := e.do("POST", "/api/netstream", `{"node":"node-9","scenario":{},"speed":1}`); rec.Code != 400 {
		t.Fatalf("unknown node: %d", rec.Code)
	}
	if rec := e.do("POST", "/api/netstream", `{"node":"node-1","speed":1}`); rec.Code != 400 {
		t.Fatalf("missing scenario passes through the node's 400, got %d", rec.Code)
	}
}
