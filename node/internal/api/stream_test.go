package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

type fakeStreamer struct {
	lines []string
	err   error
	got   sim.StreamParams
}

func (f *fakeStreamer) Stream(ctx context.Context, p sim.StreamParams, onLine func([]byte) error) error {
	f.got = p
	for _, l := range f.lines {
		if err := onLine([]byte(l)); err != nil {
			return err
		}
	}
	return f.err
}

type fakeSlots struct {
	busy     bool
	released int
}

func (f *fakeSlots) Acquire() (func(), error) {
	if f.busy {
		return nil, task.ErrBusy
	}
	return func() { f.released++ }, nil
}

func streamRequest(h http.Handler, query string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/stream?"+query, nil))
	return rec
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestStreamWritesServerSentEvents(t *testing.T) {
	streamer := &fakeStreamer{lines: []string{`{"type":"meta"}`, `{"type":"done"}`}}
	slots := &fakeSlots{}
	rec := streamRequest(StreamHandler(streamer, slots, "node-1", quietLogger()), "lambda=0.8&mu=1&speed=20&duration=60&seed=7")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("got %d %v", rec.Code, rec.Header())
	}
	if rec.Body.String() != "data: {\"type\":\"meta\"}\n\ndata: {\"type\":\"done\"}\n\n" {
		t.Fatalf("body %q", rec.Body.String())
	}
	want := sim.StreamParams{Seed: 7, Lambda: 0.8, Mu: 1, Duration: 60, Speed: 20}
	if streamer.got != want || slots.released != 1 {
		t.Fatalf("params %+v released %d", streamer.got, slots.released)
	}
}

func TestStreamRejectsBadParamsAndBusyNode(t *testing.T) {
	h := StreamHandler(&fakeStreamer{}, &fakeSlots{}, "node-1", quietLogger())
	for _, q := range []string{"mu=1", "lambda=x&mu=1", "lambda=3&mu=1", "lambda=0.8&mu=1&speed=1000", "lambda=0.8&mu=1&seed=-1"} {
		if rec := streamRequest(h, q); rec.Code != 400 {
			t.Errorf("%s: %d; want 400", q, rec.Code)
		}
	}
	busy := StreamHandler(&fakeStreamer{}, &fakeSlots{busy: true}, "node-1", quietLogger())
	if rec := streamRequest(busy, "lambda=0.8&mu=1"); rec.Code != 503 {
		t.Fatalf("busy: %d; want 503", rec.Code)
	}
}

func TestStreamReportsFailureAsEvent(t *testing.T) {
	streamer := &fakeStreamer{lines: []string{`{"type":"meta"}`}, err: io.ErrUnexpectedEOF}
	rec := streamRequest(StreamHandler(streamer, &fakeSlots{}, "node-1", quietLogger()), "lambda=0.8&mu=1")
	if !strings.Contains(rec.Body.String(), `"type":"error"`) {
		t.Fatalf("body %q; want an error event", rec.Body.String())
	}
}
