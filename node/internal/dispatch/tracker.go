package dispatch

import "sync"

// Status is a task's lifecycle state.
//
//	Pending ──assign──▶ Assigned ──ok──▶ Complete
//	   ▲                   │
//	   └──── retry ◀───────┤ failure, attempts < max
//	                       └──────────▶ Failed (attempts exhausted)
type Status string

const (
	Pending  Status = "pending"
	Assigned Status = "assigned"
	Complete Status = "complete"
	Failed   Status = "failed"
)

// TaskState is the tracked state of one task.
type TaskState struct {
	Task      Task    `json:"task"`
	Status    Status  `json:"status"`
	Attempts  int     `json:"attempts"`
	PeerID    string  `json:"peer_id,omitempty"`
	LastError string  `json:"last_error,omitempty"`
	Result    *Result `json:"result,omitempty"`
}

// Counts summarizes task states. Failed counts only permanently failed tasks;
// FailedAttempts counts every unsuccessful try, including retried ones.
type Counts struct {
	Pending        int `json:"pending"`
	Assigned       int `json:"assigned"`
	Complete       int `json:"complete"`
	Failed         int `json:"failed"`
	FailedAttempts int `json:"failed_attempts"`
}

// Tracker is the mutex-guarded, in-memory task state table for one dispatch run.
type Tracker struct {
	mu             sync.Mutex
	order          []string
	states         map[string]*TaskState
	failedAttempts int
}

func NewTracker(tasks []Task) *Tracker {
	t := &Tracker{states: make(map[string]*TaskState, len(tasks))}
	for _, task := range tasks {
		t.order = append(t.order, task.TaskID)
		t.states[task.TaskID] = &TaskState{Task: task, Status: Pending}
	}
	return t
}

// Tasks returns the tracked tasks in creation order.
func (t *Tracker) Tasks() []Task {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Task, len(t.order))
	for i, id := range t.order {
		out[i] = t.states[id].Task
	}
	return out
}

func (t *Tracker) assign(id, peerID string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[id]
	s.Status = Assigned
	s.PeerID = peerID
	s.Attempts++
	return s.Attempts
}

func (t *Tracker) complete(id string, r Result) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[id]
	s.Status = Complete
	s.Result = &r
}

// fail records an unsuccessful attempt and reports whether the task should be
// requeued (true) or is now permanently failed (false).
func (t *Tracker) fail(id string, err error, maxAttempts int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.failedAttempts++
	s := t.states[id]
	s.LastError = err.Error()
	if s.Attempts >= maxAttempts {
		s.Status = Failed
		return false
	}
	s.Status = Pending
	return true
}

// release returns an assigned task to pending without charging an attempt,
// used when the run itself is cancelled mid-request.
func (t *Tracker) release(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.states[id]
	if s.Status == Assigned {
		s.Status = Pending
		s.Attempts--
	}
}

// failUnfinished marks every task that is not complete or failed as failed.
func (t *Tracker) failUnfinished(reason string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, id := range t.order {
		s := t.states[id]
		if s.Status == Pending || s.Status == Assigned {
			s.Status = Failed
			s.LastError = reason
			n++
		}
	}
	return n
}

func (t *Tracker) Counts() Counts {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := Counts{FailedAttempts: t.failedAttempts}
	for _, s := range t.states {
		switch s.Status {
		case Pending:
			c.Pending++
		case Assigned:
			c.Assigned++
		case Complete:
			c.Complete++
		case Failed:
			c.Failed++
		}
	}
	return c
}

// Results returns completed results in task order.
func (t *Tracker) Results() []Result {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []Result
	for _, id := range t.order {
		if r := t.states[id].Result; r != nil {
			out = append(out, *r)
		}
	}
	return out
}

// FailedTasks returns permanently failed tasks in task order.
func (t *Tracker) FailedTasks() []TaskState {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []TaskState
	for _, id := range t.order {
		if s := t.states[id]; s.Status == Failed {
			out = append(out, *s)
		}
	}
	return out
}

// Get returns a copy of one task's state.
func (t *Tracker) Get(id string) (TaskState, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s, ok := t.states[id]
	if !ok {
		return TaskState{}, false
	}
	return *s, true
}
