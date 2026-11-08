package pdes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/peers"
)

type fakePlanner struct{}

func (fakePlanner) Plan(_ context.Context, _ []byte, parts int) (Plan, error) {
	return Plan{
		OK: true, Parts: parts, Assignment: map[string]int{"h1": 0, "r1": 1},
		CutLinks: []string{"l1"}, Lookahead: 0.5, Windows: 2, Load: []int{1, 1},
	}, nil
}

func (fakePlanner) Merge(_ context.Context, _ []byte, _ []json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`{"totals":{"delivered":1}}`), nil
}

type healthyChecker struct{}

func (healthyChecker) Health(context.Context, peers.Peer) error { return nil }

type coordinatedWorker struct {
	part     int
	steps    int
	received chan ArrivalRecord
	failStep bool
	mu       sync.Mutex
}

func (w *coordinatedWorker) Open(_ context.Context, req OpenRequest) error {
	w.part = req.Part
	return nil
}

func (w *coordinatedWorker) Step(_ context.Context, req StepRequest) (StepResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.steps++
	if w.failStep {
		return StepResponse{}, errors.New("simulated worker failure")
	}
	for _, record := range req.Inbound {
		w.received <- record
	}
	response := StepResponse{Outbound: []ArrivalRecord{}, ComputeS: 0.002, Events: 1,
		Totals: PacketTotals{Sent: int64(2 * w.steps), Delivered: int64(w.steps)}}
	if req.Stats {
		// Each partition owns one station whose busy time grows with every step.
		if w.part == 0 {
			response.Links = map[string]map[string]StationLoad{"l1": {"h1": {Busy: 0.25 * float64(w.steps), Queue: 1}}}
		} else {
			response.Routers = map[string]StationLoad{"r1": {Busy: 0.1 * float64(w.steps), Queue: 2}}
		}
	}
	if w.part == 0 && w.steps == 1 {
		response.Outbound = []ArrivalRecord{{
			Flow: "f", Seq: 3, Born: 0.1, Link: "l1", From: "h1", To: "r1",
			Start: 0.25, Arrive: 0.75,
		}}
	}
	return response, nil
}

func (w *coordinatedWorker) Finish(context.Context) (FinishResponse, error) {
	return FinishResponse{Metrics: json.RawMessage(`{"part":true}`), State: json.RawMessage(`{}`)}, nil
}

func (w *coordinatedWorker) Close() error { return nil }

func TestCoordinatorRoutesInboundAndCompletes(t *testing.T) {
	received := make(chan ArrivalRecord, 1)
	newHost := func() *Host {
		return NewHost(context.Background(), func() Worker { return &coordinatedWorker{received: received} },
			newFakeSlots(4), time.Minute)
	}
	remoteHost := newHost()
	defer remoteHost.Close()
	server := httptest.NewServer(NewHandler(remoteHost, nil, nil))
	defer server.Close()
	localHost := newHost()
	defer localHost.Close()

	peerList := []peers.Peer{{ID: "self"}, {ID: "remote", URL: server.URL}}
	manager := NewManager(context.Background(), fakePlanner{}, localHost, peerList, "self", healthyChecker{},
		NewPeerClient(time.Second), time.Second, time.Minute)
	baseline := false
	run, err := manager.Start(context.Background(), RunRequest{
		Scenario: json.RawMessage(`{"duration":1}`), Parts: intPtr(2), BaseSeed: int64Ptr(9), Baseline: &baseline,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-run.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("coordinator did not finish")
	}
	select {
	case record := <-received:
		if record.Flow != "f" || record.Seq != 3 || record.Arrive != 0.75 {
			t.Fatalf("inbound record = %+v", record)
		}
	case <-time.After(time.Second):
		t.Fatal("remote partition did not receive outbound record")
	}
	if status := run.Status(); status.State != "complete" || status.WindowsDone != 2 {
		t.Fatalf("status = %+v", status)
	}
	if report := run.Report(); string(report.Metrics) != `{"totals":{"delivered":1}}` {
		t.Fatalf("report = %+v", report)
	}
	status := run.Status()
	if len(status.Participants) != 2 || status.Participants[0] != "self" || status.Participants[1] != "remote" {
		t.Fatalf("participants = %v; partition 0 must be the coordinator", status.Participants)
	}
	if status.Totals != (PacketTotals{Sent: 8, Delivered: 4}) {
		t.Fatalf("totals = %+v; want the sum of both partitions' last totals", status.Totals)
	}
	if status.CutTraffic["l1"] != 1 || status.Partitions["self"].Messages != 1 || status.Partitions["remote"].Messages != 1 {
		t.Fatalf("cut traffic = %v, partitions = %+v", status.CutTraffic, status.Partitions)
	}
	if status.Partitions["self"].Events != 2 {
		t.Fatalf("events = %d; want one per step", status.Partitions["self"].Events)
	}
	// The last window always samples load: over [0.5, 1] the link was busy 0.25 s and the router 0.1 s.
	if status.Live == nil || status.Live.SimulatedTime != 1 {
		t.Fatalf("live = %+v", status.Live)
	}
	if link := status.Live.Links["l1"]; link.Util != 0.5 || link.Queue != 1 {
		t.Fatalf("live link = %+v", link)
	}
	if router := status.Live.Routers["r1"]; router.Util < 0.199 || router.Util > 0.201 || router.Queue != 2 {
		t.Fatalf("live router = %+v", router)
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(299) })
	handler := NewHandler(localHost, manager, next)
	statusRec := httptest.NewRecorder()
	handler.ServeHTTP(statusRec, httptest.NewRequest(http.MethodGet, "/status?batch_id="+run.ID, nil))
	if statusRec.Code != http.StatusOK || !strings.Contains(statusRec.Body.String(), `"kind":"pdes"`) {
		t.Fatalf("status route = %d %s", statusRec.Code, statusRec.Body)
	}
	reportRec := httptest.NewRecorder()
	handler.ServeHTTP(reportRec, httptest.NewRequest(http.MethodGet, "/report?batch_id="+run.ID, nil))
	if reportRec.Code != http.StatusOK || !strings.Contains(reportRec.Body.String(), `"totals":{"delivered":1}`) {
		t.Fatalf("report route = %d %s", reportRec.Code, reportRec.Body)
	}
	fallthroughRec := httptest.NewRecorder()
	handler.ServeHTTP(fallthroughRec, httptest.NewRequest(http.MethodGet, "/status?batch_id=other", nil))
	if fallthroughRec.Code != 299 {
		t.Fatalf("unknown status route = %d; want passthrough", fallthroughRec.Code)
	}
}

func intPtr(value int) *int       { return &value }
func int64Ptr(value int64) *int64 { return &value }
