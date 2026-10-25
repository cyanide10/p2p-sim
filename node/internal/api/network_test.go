package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/netbatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

type fakeNetSim struct{ peak float64 }

func (f fakeNetSim) Validate(_ context.Context, scenario []byte) (sim.Summary, error) {
	if strings.Contains(string(scenario), "bad") {
		return sim.Summary{}, &sim.ScenarioError{Msg: "add at least one flow"}
	}
	return sim.Summary{OK: true, Nodes: 2, Flows: 1, PeakRate: f.peak}, nil
}

func (fakeNetSim) Stream(_ context.Context, _ []byte, seed int64, _, _ float64, onLine func([]byte) error) error {
	for _, l := range []string{`{"type":"meta"}`, `{"type":"done"}`} {
		if err := onLine([]byte(l)); err != nil {
			return err
		}
	}
	return nil
}

type okPool struct{}

func (okPool) RunTask(_ context.Context, p peers.Peer, t dispatch.Task) (dispatch.Result, error) {
	return dispatch.Result{TaskID: t.TaskID, PeerID: p.ID, Seed: t.Seed, Network: task.RawJSON(`{"flows":{"f":{"sent":1}}}`)}, nil
}
func (okPool) Health(context.Context, peers.Peer) error { return nil }

func networkHandler(t *testing.T) (http.Handler, *netbatch.Manager) {
	d := &dispatch.Dispatcher{Client: okPool{}, Config: dispatch.Config{MaxAttempts: 2, BackoffInitial: time.Millisecond, BackoffMax: time.Millisecond}, Logger: quietLogger()}
	m := netbatch.NewManager(context.Background(), d, []peers.Peer{{ID: "node-1"}, {ID: "node-2"}}, "node-1", fakeNetSim{peak: 10}, time.Minute, quietLogger())
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) })
	return NetworkHandler(m, fakeNetSim{peak: 10}, &fakeSlots{}, "node-1", quietLogger(), next), m
}

func netDo(h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, strings.NewReader(body)))
	return rec
}

func TestNetrunAndStatusReport(t *testing.T) {
	h, m := networkHandler(t)
	rec := netDo(h, "POST", "/netrun", `{"scenario":{"duration":10},"replications":4,"base_seed":5}`)
	if rec.Code != 202 {
		t.Fatalf("netrun %d %s", rec.Code, rec.Body)
	}
	var started struct {
		BatchID string `json:"batch_id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &started)
	b, _ := m.Get(started.BatchID)
	<-b.Done()
	if rec := netDo(h, "GET", "/status?batch_id="+started.BatchID, ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"kind": "network"`) {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if rec := netDo(h, "GET", "/report?batch_id="+started.BatchID, ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"verdict": "COMPLETE"`) {
		t.Fatalf("report %d %s", rec.Code, rec.Body)
	}
	// Other batches and routes fall through to the M/M/1 handler.
	for _, target := range []string{"/status?batch_id=batch-x", "/status", "/report", "/health"} {
		if rec := netDo(h, "GET", target, ""); rec.Code != 299 {
			t.Errorf("%s: %d; want passthrough", target, rec.Code)
		}
	}
	if rec := netDo(h, "POST", "/netrun", `{"scenario":"bad"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "flow") {
		t.Fatalf("invalid scenario: %d %s", rec.Code, rec.Body)
	}
	if rec := netDo(h, "POST", "/netrun", `{"scenario":{},"extra":1}`); rec.Code != 400 {
		t.Fatalf("unknown field: %d", rec.Code)
	}
}

func TestNetstream(t *testing.T) {
	h, _ := networkHandler(t)
	rec := netDo(h, "POST", "/netstream", `{"scenario":{"duration":10},"speed":2,"seed":1}`)
	if rec.Code != 200 || rec.Body.String() != "data: {\"type\":\"meta\"}\n\ndata: {\"type\":\"done\"}\n\n" {
		t.Fatalf("stream %d %q", rec.Code, rec.Body)
	}
	if rec := netDo(h, "POST", "/netstream", `{"scenario":{"duration":10},"speed":50}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "lower the speed") {
		t.Fatalf("too fast: %d %s", rec.Code, rec.Body)
	}
	if rec := netDo(h, "POST", "/netstream", `{"scenario":{"duration":10},"speed":1,"start":-1}`); rec.Code != 400 {
		t.Fatalf("negative start: %d", rec.Code)
	}
	if rec := netDo(h, "POST", "/netstream", `{"speed":1}`); rec.Code != 400 {
		t.Fatalf("no scenario: %d", rec.Code)
	}
}
