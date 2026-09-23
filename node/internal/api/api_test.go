package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/batch"
	"github.com/p2p-sim/node/internal/config"
	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/task"
)

type fakeClient struct{}

func (fakeClient) RunTask(_ context.Context, p peers.Peer, t dispatch.Task) (dispatch.Result, error) {
	return dispatch.Result{TaskID: t.TaskID, PeerID: p.ID, Seed: t.Seed, MeanWaitTime: 5, MeanQueueLength: 4, Utilization: 0.8}, nil
}

func (fakeClient) Health(_ context.Context, p peers.Peer) error {
	if p.ID == "down" {
		return errors.New("connection refused")
	}
	return nil
}

type fakeExec struct {
	res task.Result
	err error
	got task.Task
}

func (f *fakeExec) Execute(_ context.Context, t task.Task) (task.Result, error) {
	f.got = t
	return f.res, f.err
}

func newServer(t *testing.T, exec TaskExecutor) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	list := []peers.Peer{{ID: "p1", URL: "http://p1:8000"}, {ID: "down", URL: "http://down:8000"}}
	d := &dispatch.Dispatcher{
		Client: fakeClient{},
		Config: dispatch.Config{MaxAttempts: 3, BackoffInitial: time.Millisecond, BackoffMax: time.Millisecond},
		Logger: logger,
	}
	m := batch.NewManager(context.Background(), d, list, "p1", config.Default().Defaults, time.Minute, logger)
	srv := httptest.NewServer(NewHandler(m, "p1", list, fakeClient{}, exec, logger))
	t.Cleanup(srv.Close)
	return srv
}

func do(t *testing.T, method, url, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestNoBatchYet(t *testing.T) {
	srv := newServer(t, &fakeExec{})
	for _, path := range []string{"/status", "/report", "/report?batch_id=nope"} {
		if code, _ := do(t, "GET", srv.URL+path, ""); code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, code)
		}
	}
	if code, body := do(t, "GET", srv.URL+"/health", ""); code != 200 || body["status"] != "ok" || body["node_id"] != "p1" {
		t.Errorf("health: %d %v", code, body)
	}
}

func TestRunValidation(t *testing.T) {
	srv := newServer(t, &fakeExec{})
	for _, body := range []string{
		`{"lambda": 1.2, "mu": 1.0}`,
		`{"replications": "many"}`,
		`{"lamda": 0.5}`, // typo: unknown fields are rejected
	} {
		if code, out := do(t, "POST", srv.URL+"/run", body); code != http.StatusBadRequest {
			t.Errorf("%s: status %d (%v), want 400", body, code, out)
		}
	}
}

func TestRunStatusReport(t *testing.T) {
	srv := newServer(t, &fakeExec{})
	code, started := do(t, "POST", srv.URL+"/run",
		`{"replications": 20, "lambda": 0.8, "mu": 1.0, "sim_time": 1000, "warmup_time": 100, "base_seed": 7, "serial_baseline": false}`)
	if code != http.StatusAccepted || started["status"] != "started" || started["coordinator"] != "p1" {
		t.Fatalf("run: %d %v", code, started)
	}
	id := started["batch_id"].(string)

	deadline := time.Now().Add(5 * time.Second)
	for {
		_, status := do(t, "GET", srv.URL+"/status", "")
		if status["state"] == "complete" {
			if status["complete"].(float64) != 20 || status["batch_id"] != id {
				t.Fatalf("status = %v", status)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("batch did not complete: %v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}

	code, report := do(t, "GET", srv.URL+"/report?batch_id="+id, "")
	if code != 200 || report["verdict"] != "PASS" || report["base_seed"].(float64) != 7 || report["coordinator"] != "p1" {
		t.Fatalf("report: %d %v", code, report)
	}
	wait := report["mean_wait_time"].(map[string]any)
	if math.Abs(wait["theoretical"].(float64)-5) > 1e-9 || wait["n"].(float64) != 20 {
		t.Fatalf("mean_wait_time = %v", wait)
	}
}

func TestPeersEndpoint(t *testing.T) {
	srv := newServer(t, &fakeExec{})
	code, body := do(t, "GET", srv.URL+"/peers", "")
	list := body["peers"].([]any)
	if code != 200 || len(list) != 2 {
		t.Fatalf("peers: %d %v", code, body)
	}
	self, down := list[0].(map[string]any), list[1].(map[string]any)
	if self["healthy"] != true || self["self"] != true || down["healthy"] != false || down["self"] != false {
		t.Fatalf("peers = %v", list)
	}
}

const taskJSON = `{"task_id":"b-0001","seed":11,"params":{"lambda":0.8,"mu":1,"sim_time":1000,"warmup_time":100}}`

func TestTaskSuccess(t *testing.T) {
	exec := &fakeExec{res: task.Result{TaskID: "b-0001", PeerID: "p1", Seed: 11, MeanWaitTime: 5, PacketsServed: 700}}
	srv := newServer(t, exec)

	code, body := do(t, "POST", srv.URL+"/task", taskJSON)
	if code != http.StatusOK || body["mean_wait_time"].(float64) != 5 || body["peer_id"] != "p1" {
		t.Fatalf("task: %d %v", code, body)
	}
	want := task.Task{TaskID: "b-0001", Seed: 11, Params: task.SimParams{Lambda: 0.8, Mu: 1, SimTime: 1000, WarmupTime: 100}}
	if exec.got != want {
		t.Fatalf("executor got %+v", exec.got)
	}
}

func TestTaskErrors(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		body   string
		status int
	}{
		{"simulation failure", errors.New("simulation failed (exit status 1): unstable system"), taskJSON, http.StatusBadRequest},
		{"busy", task.ErrBusy, taskJSON, http.StatusServiceUnavailable},
		{"malformed", nil, `{"task_id":`, http.StatusBadRequest},
		{"no task id", nil, `{"seed":1}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := newServer(t, &fakeExec{err: c.err})
			code, body := do(t, "POST", srv.URL+"/task", c.body)
			if code != c.status {
				t.Fatalf("status = %d, want %d (%v)", code, c.status, body)
			}
			if c.err != nil && body["task_id"] != "b-0001" {
				t.Fatalf("error body should echo task_id: %v", body)
			}
		})
	}

	srv := newServer(t, &fakeExec{})
	if code, _ := do(t, "GET", srv.URL+"/task", ""); code != http.StatusMethodNotAllowed {
		t.Errorf("GET /task status = %d, want 405", code)
	}
}
