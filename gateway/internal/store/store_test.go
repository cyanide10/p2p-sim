package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "sub", "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func sample(i int) Run {
	return Run{
		RunID: fmt.Sprintf("run-%02d", i), BatchID: fmt.Sprintf("batch-%d", i), Coordinator: "node-1",
		CreatedAt: time.Date(2026, 10, 4, 12, 0, i, 0, time.UTC),
		Params:    Params{Replications: 100, Lambda: 0.8, Mu: 1, SimTime: 10000, WarmupTime: 1000, TolerancePct: 10, BaseSeed: int64(i)},
		State:     StateRunning,
	}
}

func TestMigrationsAreIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "g.db")
	for range 2 {
		s, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if v, err := s.Version(context.Background()); err != nil || v != len(migrations) {
			t.Fatalf("version %d, %v; want %d", v, err, len(migrations))
		}
		s.Close()
	}
}

func TestCRUD(t *testing.T) {
	s, ctx := open(t), context.Background()
	if err := s.Insert(ctx, sample(1)); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, "run-01")
	if err != nil || got.Params.BaseSeed != 1 || got.Status != nil || got.Report != nil || !got.CreatedAt.Equal(sample(1).CreatedAt) {
		t.Fatalf("Get: %+v, %v", got, err)
	}
	status := json.RawMessage(`{"state":"running","complete":10}`)
	if err := s.Update(ctx, "run-01", StateRunning, status, nil); err != nil {
		t.Fatal(err)
	}
	report := json.RawMessage(`{"verdict":"PASS"}`)
	if err := s.Update(ctx, "run-01", StateComplete, nil, report); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Get(ctx, "run-01")
	if got.State != StateComplete || string(got.Status) != string(status) || string(got.Report) != string(report) {
		t.Fatalf("after updates: %+v", got)
	}
	if _, err := s.Get(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get unknown: %v", err)
	}
	if err := s.Update(ctx, "nope", StateComplete, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update unknown: %v", err)
	}
	running, _ := s.ListByState(ctx, StateRunning)
	if len(running) != 0 {
		t.Fatalf("ListByState(running) = %d; want 0", len(running))
	}
}

func TestListAndPrune(t *testing.T) {
	s, ctx := open(t), context.Background()
	for i := 1; i <= 5; i++ {
		s.Insert(ctx, sample(i))
	}
	page, total, err := s.List(ctx, 2, 1)
	if err != nil || total != 5 || len(page) != 2 || page[0].RunID != "run-04" || page[1].RunID != "run-03" {
		t.Fatalf("List: %v total=%d err=%v; want newest first", ids(page), total, err)
	}
	removed, err := s.Prune(ctx, 3)
	if err != nil || removed != 2 {
		t.Fatalf("Prune removed %d, %v; want 2", removed, err)
	}
	all, _, _ := s.List(ctx, 10, 0)
	if fmt.Sprint(ids(all)) != "[run-05 run-04 run-03]" {
		t.Fatalf("after prune: %v", ids(all))
	}
}

func TestConcurrentWrites(t *testing.T) {
	s, ctx := open(t), context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Insert(ctx, sample(i)); err != nil {
				errs <- err
				return
			}
			errs <- s.Update(ctx, sample(i).RunID, StateRunning, json.RawMessage(`{"n":1}`), nil)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, total, _ := s.List(ctx, 1, 0); total != 20 {
		t.Fatalf("total %d; want 20", total)
	}
}

func ids(runs []Run) []string {
	out := make([]string, len(runs))
	for i, r := range runs {
		out[i] = r.RunID
	}
	return out
}
