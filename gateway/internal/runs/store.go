package runs

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type State string

const (
	Running         State = "running"
	Complete        State = "complete"
	CoordinatorLost State = "coordinator_lost"
)

// Record is one run as the gateway knows it. Status and Report are the
// node's JSON unchanged; they marshal as null until captured. The report's
// verdict never affects State.
type Record struct {
	RunID       string          `json:"run_id"`
	BatchID     string          `json:"batch_id"`
	Coordinator string          `json:"coordinator"`
	CreatedAt   time.Time       `json:"created_at"`
	Params      Params          `json:"params"`
	State       State           `json:"state"`
	Status      json.RawMessage `json:"status"`
	Report      json.RawMessage `json:"report"`
}

var ErrFull = errors.New("run history is full of running batches")

// Store keeps up to capacity records in memory. History is lost on restart.
type Store struct {
	mu       sync.Mutex
	capacity int
	order    []string // oldest first
	records  map[string]*Record
}

func NewStore(capacity int) *Store {
	return &Store{capacity: capacity, records: make(map[string]*Record)}
}

// HasRoom reports whether Add would currently succeed.
func (s *Store) HasRoom() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.order) < s.capacity || s.evictableLocked() >= 0
}

// Add stores rec, evicting the oldest finished record when full.
func (s *Store) Add(rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.records[rec.RunID]; exists {
		s.records[rec.RunID] = &rec
		return nil
	}
	if len(s.order) >= s.capacity {
		i := s.evictableLocked()
		if i < 0 {
			return ErrFull
		}
		delete(s.records, s.order[i])
		s.order = append(s.order[:i], s.order[i+1:]...)
	}
	s.records[rec.RunID] = &rec
	s.order = append(s.order, rec.RunID)
	return nil
}

// evictableLocked returns the index of the oldest non-running record, or -1.
func (s *Store) evictableLocked() int {
	for i, id := range s.order {
		if s.records[id].State != Running {
			return i
		}
	}
	return -1
}

func (s *Store) Get(id string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[id]
	if !ok {
		return Record{}, false
	}
	return *r, true
}

// List returns records newest first, and the total count.
func (s *Store) List(limit, offset int) ([]Record, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := len(s.order)
	out := []Record{}
	for i := total - 1 - offset; i >= 0 && len(out) < limit; i-- {
		out = append(out, *s.records[s.order[i]])
	}
	return out, total
}

func (s *Store) update(id string, fn func(*Record)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.records[id]; ok {
		fn(r)
	}
}

func (s *Store) SetStatus(id string, status json.RawMessage) {
	s.update(id, func(r *Record) { r.Status = status })
}

func (s *Store) SetReport(id string, report json.RawMessage) {
	s.update(id, func(r *Record) { r.Report = report })
}

func (s *Store) SetState(id string, state State) {
	s.update(id, func(r *Record) { r.State = state })
}
