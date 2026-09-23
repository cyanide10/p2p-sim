package dispatch

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/task"
)

type recordingExec struct{ calls int }

func (e *recordingExec) Execute(_ context.Context, t Task) (Result, error) {
	e.calls++
	return okResult(t), nil
}

func TestRoutingClientSendsSelfToLocal(t *testing.T) {
	local := &recordingExec{}
	remote := newFake()
	c := RoutingClient{SelfID: "p1", Local: LocalClient{Exec: local}, Remote: remote}

	tr := NewTracker(GenerateTasks("b", 30, 1, testParams))
	runWithTimeout(t, newDispatcher(c), peerList("p1", "p2", "p3"), tr)

	if got := tr.Counts().Complete; got != 30 {
		t.Fatalf("complete = %d", got)
	}
	if local.calls == 0 {
		t.Error("coordinating node should execute some tasks itself")
	}
	if remote.calls["p1"] != 0 {
		t.Error("self must never be called over HTTP")
	}
	if local.calls+remote.calls["p2"]+remote.calls["p3"] != 30 {
		t.Errorf("calls local=%d remote=%v", local.calls, remote.calls)
	}
}

func TestBusyNodeDoesNotConsumeAttempts(t *testing.T) {
	f := newFake()
	f.run["p1"] = func(t Task, call int) (Result, error) {
		if call <= 5 {
			return Result{}, task.ErrBusy
		}
		return okResult(t), nil
	}
	d := newDispatcher(f)
	d.Config.MaxAttempts = 1 // a charged attempt would fail the task outright

	tr := NewTracker(GenerateTasks("b", 3, 1, testParams))
	runWithTimeout(t, d, peerList("p1"), tr)

	c := tr.Counts()
	if c.Complete != 3 || c.Failed != 0 || c.FailedAttempts != 0 {
		t.Fatalf("counts = %+v", c)
	}
	for _, tk := range tr.Tasks() {
		if s, _ := tr.Get(tk.TaskID); s.Attempts != 1 {
			t.Errorf("%s attempts = %d, want 1", tk.TaskID, s.Attempts)
		}
	}
}

func TestHTTPClientMaps503ToBusy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "node busy"})
	}))
	defer srv.Close()

	c := NewHTTPClient(time.Second, time.Second)
	_, err := c.RunTask(context.Background(), peers.Peer{ID: "p", URL: srv.URL}, Task{TaskID: "x"})
	if !errors.Is(err, task.ErrBusy) {
		t.Fatalf("err = %v, want task.ErrBusy", err)
	}
}

func TestHTTPClientDoesNotFollowRedirects(t *testing.T) {
	var redirected bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	c := NewHTTPClient(time.Second, time.Second)
	if _, err := c.RunTask(context.Background(), peers.Peer{ID: "p", URL: srv.URL}, Task{TaskID: "x"}); err == nil {
		t.Fatal("redirect response should be an error")
	}
	if redirected {
		t.Fatal("client followed a redirect")
	}
}
