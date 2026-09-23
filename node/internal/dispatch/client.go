package dispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/task"
)

// PeerClient talks to peers. The HTTP implementation is used in production;
// tests substitute a fake so no network is needed.
type PeerClient interface {
	RunTask(ctx context.Context, p peers.Peer, t Task) (Result, error)
	Health(ctx context.Context, p peers.Peer) error
}

// HTTPClient is the net/http PeerClient. Every call carries an explicit
// context timeout; the zero-timeout default http.Client is never relied upon.
type HTTPClient struct {
	HTTP           *http.Client
	RequestTimeout time.Duration
	HealthTimeout  time.Duration
}

func NewHTTPClient(requestTimeout, healthTimeout time.Duration) *HTTPClient {
	hc := &http.Client{
		// Peers are addressed only by the URLs in peers.yaml. Never follow a
		// redirect, which would let a peer (or anything spoofing one) steer
		// task requests to arbitrary hosts.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &HTTPClient{HTTP: hc, RequestTimeout: requestTimeout, HealthTimeout: healthTimeout}
}

// Unwrap lets errors.Is(err, task.ErrBusy) match a 503 from a node at its
// concurrent-task limit.
func (e *PeerError) Unwrap() error {
	if e.StatusCode == http.StatusServiceUnavailable {
		return task.ErrBusy
	}
	return nil
}

// PeerError is a non-2xx response from a peer.
type PeerError struct {
	StatusCode int
	Message    string
}

func (e *PeerError) Error() string {
	return fmt.Sprintf("peer returned HTTP %d: %s", e.StatusCode, e.Message)
}

const maxResponseBytes = 1 << 20

func (c *HTTPClient) RunTask(ctx context.Context, p peers.Peer, t Task) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, c.RequestTimeout)
	defer cancel()

	body, err := json.Marshal(t)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL+"/task", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Result{}, fmt.Errorf("request to %s timed out after %s", p.ID, c.RequestTimeout)
		}
		return Result{}, fmt.Errorf("request to %s failed: %w", p.ID, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Result{}, fmt.Errorf("request to %s timed out after %s", p.ID, c.RequestTimeout)
		}
		return Result{}, fmt.Errorf("reading response from %s: %w", p.ID, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(data))
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		return Result{}, &PeerError{StatusCode: resp.StatusCode, Message: msg}
	}

	var r Result
	if err := json.Unmarshal(data, &r); err != nil {
		return Result{}, fmt.Errorf("invalid result JSON from %s: %w", p.ID, err)
	}
	if r.TaskID != t.TaskID || r.Seed != t.Seed {
		return Result{}, fmt.Errorf("peer %s answered for task %q seed %d, expected %q seed %d",
			p.ID, r.TaskID, r.Seed, t.TaskID, t.Seed)
	}
	if r.PeerID == "" {
		r.PeerID = p.ID
	}
	return r, nil
}

func (c *HTTPClient) Health(ctx context.Context, p peers.Peer) error {
	ctx, cancel := context.WithTimeout(ctx, c.HealthTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("health check of %s failed: %w", p.ID, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check of %s returned HTTP %d", p.ID, resp.StatusCode)
	}
	return nil
}
