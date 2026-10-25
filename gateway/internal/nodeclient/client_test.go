package nodeclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/testnode"
)

func kindOf(t *testing.T, err error) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("expected *nodeclient.Error, got %T: %v", err, err)
	}
	return e
}

func TestRunStatusReport(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	c := New(time.Second)
	ctx := context.Background()

	if err := c.Health(ctx, n.URL()); err != nil {
		t.Fatal(err)
	}
	run, err := c.Run(ctx, n.URL(), []byte(`{"replications":40,"base_seed":7}`))
	if err != nil {
		t.Fatal(err)
	}
	if run.BatchID != "batch-node-1-1" || run.Replications != 40 || run.BaseSeed != 7 || run.Coordinator != "node-1" {
		t.Fatalf("unexpected run response: %+v", run)
	}
	status, err := c.Status(ctx, n.URL(), run.BatchID)
	if err != nil || !strings.Contains(string(status), `"state":"complete"`) {
		t.Fatalf("status %s, err %v", status, err)
	}
	report, err := c.Report(ctx, n.URL(), run.BatchID)
	if err != nil || !strings.Contains(string(report), `"verdict":"PASS"`) {
		t.Fatalf("report %s, err %v", report, err)
	}
}

func TestPeers(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.PeerView = map[string]bool{"node-1": true, "node-2": false} })
	p, err := New(time.Second).Peers(context.Background(), n.URL())
	if err != nil {
		t.Fatal(err)
	}
	if p.NodeID != "node-1" || len(p.Peers) != 2 || p.Peers[1].ID != "node-2" || p.Peers[1].Healthy {
		t.Fatalf("unexpected peers: %+v", p)
	}
}

func TestTimeout(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.Delay = time.Second })
	err := New(50*time.Millisecond).Health(context.Background(), n.URL())
	if e := kindOf(t, err); e.Kind != Timeout {
		t.Fatalf("got kind %v", e.Kind)
	}
}

func TestUnreachable(t *testing.T) {
	n := testnode.New("node-1")
	url := n.URL()
	n.Close()
	err := New(time.Second).Health(context.Background(), url)
	if e := kindOf(t, err); e.Kind != Unreachable {
		t.Fatalf("got kind %v", e.Kind)
	}
}

func TestRedirectNotFollowed(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("redirect was followed")
	}))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/health", http.StatusFound)
	}))
	defer srv.Close()
	err := New(time.Second).Health(context.Background(), srv.URL)
	if e := kindOf(t, err); e.Kind != HTTP || e.StatusCode != http.StatusFound {
		t.Fatalf("got %+v", e)
	}
}

func TestOversizedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"x":"` + strings.Repeat("a", 5<<20) + `"}`))
	}))
	defer srv.Close()
	_, err := New(time.Second).Status(context.Background(), srv.URL, "b")
	if e := kindOf(t, err); e.Kind != Decode {
		t.Fatalf("got kind %v", e.Kind)
	}
}

func TestHTTPErrorKeepsMessageAndBody(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	n.Update(func(n *testnode.Node) { n.RunStatus = http.StatusConflict })
	_, err := New(time.Second).Run(context.Background(), n.URL(), []byte(`{}`))
	e := kindOf(t, err)
	if e.Kind != HTTP || e.StatusCode != http.StatusConflict || e.Message != "a batch is already running on this node" {
		t.Fatalf("got %+v", e)
	}
	if !strings.Contains(string(e.Body), `"batch_id"`) {
		t.Fatalf("body not kept: %s", e.Body)
	}
}

func TestNotFound(t *testing.T) {
	n := testnode.New("node-1")
	defer n.Close()
	_, err := New(time.Second).Status(context.Background(), n.URL(), "unknown")
	if !IsNotFound(err) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestNonObjectBodyIsDecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[1,2]`))
	}))
	defer srv.Close()
	_, err := New(time.Second).Report(context.Background(), srv.URL, "b")
	if e := kindOf(t, err); e.Kind != Decode {
		t.Fatalf("got kind %v", e.Kind)
	}
}
