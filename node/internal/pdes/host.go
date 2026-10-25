package pdes

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/p2p-sim/node/internal/task"
)

var ErrBusy = task.ErrBusy

type SlotAcquirer interface {
	Acquire() (func(), error)
}

type hostSession struct {
	worker     Worker
	release    func()
	lastActive time.Time
	mu         sync.Mutex
}

// Host owns long-lived partition subprocesses and accounts for their slots.
type Host struct {
	factory     WorkerFactory
	slots       SlotAcquirer
	idleTimeout time.Duration

	mu       sync.Mutex
	sessions map[string]*hostSession
	closed   bool
	cancel   context.CancelFunc
	done     chan struct{}
}

func NewHost(ctx context.Context, factory WorkerFactory, slots SlotAcquirer, idleTimeout time.Duration) *Host {
	if idleTimeout <= 0 {
		idleTimeout = 60 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	h := &Host{
		factory: factory, slots: slots, idleTimeout: idleTimeout,
		sessions: make(map[string]*hostSession), cancel: cancel, done: make(chan struct{}),
	}
	go h.reap(ctx)
	return h
}

func (h *Host) Open(ctx context.Context, run string, req OpenRequest) error {
	if run == "" {
		return errors.New("run id is required")
	}
	if h.factory == nil || h.slots == nil {
		return errors.New("partition host is not configured")
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return errors.New("partition host is closed")
	}
	if _, exists := h.sessions[run]; exists {
		h.mu.Unlock()
		return fmt.Errorf("partition run %q is already open", run)
	}
	session := &hostSession{lastActive: time.Now()}
	h.sessions[run] = session
	h.mu.Unlock()

	release, err := h.slots.Acquire()
	if err != nil {
		h.remove(run, session)
		return err
	}
	worker := h.factory()
	session.mu.Lock()
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		session.mu.Unlock()
		release()
		h.remove(run, session)
		return errors.New("partition host is closed")
	}
	session.worker, session.release = worker, release
	err = worker.Open(ctx, req)
	if err != nil {
		_ = worker.Close()
		session.worker, session.release = nil, nil
		release()
		session.mu.Unlock()
		h.remove(run, session)
		return err
	}
	session.mu.Unlock()
	return nil
}

func (h *Host) Step(ctx context.Context, run string, req StepRequest) (StepResponse, error) {
	session, err := h.get(run)
	if err != nil {
		return StepResponse{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.worker == nil {
		return StepResponse{}, errors.New("partition run is still opening")
	}
	response, err := session.worker.Step(ctx, req)
	if err == nil {
		h.mu.Lock()
		if h.sessions[run] == session {
			session.lastActive = time.Now()
		}
		h.mu.Unlock()
	}
	return response, err
}

func (h *Host) Finish(ctx context.Context, run string) (FinishResponse, error) {
	session, err := h.get(run)
	if err != nil {
		return FinishResponse{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.worker == nil {
		return FinishResponse{}, errors.New("partition run is still opening")
	}
	response, finishErr := session.worker.Finish(ctx)
	h.closeSession(session)
	h.remove(run, session)
	return response, finishErr
}

func (h *Host) Delete(run string) error {
	session, err := h.get(run)
	if err != nil {
		return err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	h.closeSession(session)
	h.remove(run, session)
	return nil
}

func (h *Host) get(run string) (*hostSession, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	session, ok := h.sessions[run]
	if !ok {
		return nil, fmt.Errorf("partition run %q is not open", run)
	}
	session.lastActive = time.Now()
	return session, nil
}

func (h *Host) remove(run string, expected *hostSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[run] == expected {
		delete(h.sessions, run)
	}
}

func (h *Host) closeSession(session *hostSession) {
	if session.worker != nil {
		_ = session.worker.Close()
		session.worker = nil
	}
	if session.release != nil {
		session.release()
		session.release = nil
	}
}

func (h *Host) reap(ctx context.Context) {
	defer close(h.done)
	interval := h.idleTimeout / 4
	if interval > time.Second {
		interval = time.Second
	}
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			h.mu.Lock()
			idle := make([]struct {
				run     string
				session *hostSession
			}, 0)
			for run, session := range h.sessions {
				if now.Sub(session.lastActive) >= h.idleTimeout {
					idle = append(idle, struct {
						run     string
						session *hostSession
					}{run, session})
				}
			}
			h.mu.Unlock()
			for _, entry := range idle {
				entry.session.mu.Lock()
				h.closeSession(entry.session)
				entry.session.mu.Unlock()
				h.remove(entry.run, entry.session)
			}
		}
	}
}

func (h *Host) Close() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	h.cancel()
	sessions := h.sessions
	h.sessions = make(map[string]*hostSession)
	h.mu.Unlock()

	<-h.done
	var errs []error
	for _, session := range sessions {
		session.mu.Lock()
		if session.worker != nil {
			if err := session.worker.Close(); err != nil {
				errs = append(errs, err)
			}
			session.worker = nil
		}
		if session.release != nil {
			session.release()
			session.release = nil
		}
		session.mu.Unlock()
	}
	return errors.Join(errs...)
}
