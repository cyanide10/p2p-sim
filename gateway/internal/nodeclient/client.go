// Package nodeclient calls the p2p-sim node HTTP API. Every call has a
// timeout, redirects are never followed, and response bodies are capped.
package nodeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 4 << 20

type Kind int

const (
	Unreachable Kind = iota + 1
	Timeout
	HTTP
	Decode
)

func (k Kind) String() string {
	switch k {
	case Unreachable:
		return "unreachable"
	case Timeout:
		return "timeout"
	case HTTP:
		return "http"
	case Decode:
		return "decode"
	}
	return "unknown"
}

// Error is every failure this package returns. For Kind HTTP, StatusCode is
// the node's status, Message its "error" field when present, and Body the
// raw response so callers can pass it through unchanged.
type Error struct {
	Kind       Kind
	URL        string
	StatusCode int
	Message    string
	Body       []byte
}

func (e *Error) Error() string {
	switch e.Kind {
	case HTTP:
		return fmt.Sprintf("%s returned HTTP %d: %s", e.URL, e.StatusCode, e.Message)
	case Timeout:
		return fmt.Sprintf("%s timed out: %s", e.URL, e.Message)
	case Unreachable:
		return fmt.Sprintf("%s unreachable: %s", e.URL, e.Message)
	default:
		return fmt.Sprintf("invalid response from %s: %s", e.URL, e.Message)
	}
}

// IsNotFound reports whether err is a node 404, which means the node does
// not (or no longer) hold the batch.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Kind == HTTP && e.StatusCode == http.StatusNotFound
}

type Client struct {
	http    *http.Client
	timeout time.Duration
}

func New(timeout time.Duration) *Client {
	return &Client{
		http: &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		timeout: timeout,
	}
}

type PeerHealth struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	Self    bool   `json:"self"`
	Healthy bool   `json:"healthy"`
	Error   string `json:"error,omitempty"`
}

type PeersResponse struct {
	NodeID string       `json:"node_id"`
	Peers  []PeerHealth `json:"peers"`
}

// RunResponse is the node's 202 body for POST /run.
type RunResponse struct {
	BatchID      string `json:"batch_id"`
	Status       string `json:"status"`
	Coordinator  string `json:"coordinator"`
	Replications int    `json:"replications"`
	BaseSeed     int64  `json:"base_seed"`
	Peers        int    `json:"peers"`
}

func (c *Client) Health(ctx context.Context, base string) error {
	_, err := c.do(ctx, http.MethodGet, base+"/health", nil)
	return err
}

func (c *Client) Peers(ctx context.Context, base string) (PeersResponse, error) {
	var p PeersResponse
	u := base + "/peers"
	data, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, &Error{Kind: Decode, URL: u, Message: err.Error()}
	}
	return p, nil
}

// Run forwards body to POST /run. Node 400 and 409 come back as Kind HTTP
// errors carrying the node's body.
func (c *Client) Run(ctx context.Context, base string, body []byte) (RunResponse, error) {
	var r RunResponse
	u := base + "/run"
	data, err := c.do(ctx, http.MethodPost, u, body)
	if err != nil {
		return r, err
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return r, &Error{Kind: Decode, URL: u, Message: err.Error()}
	}
	if r.BatchID == "" {
		return r, &Error{Kind: Decode, URL: u, Message: "response has no batch_id"}
	}
	return r, nil
}

// Status returns the node's /status JSON object for batchID unchanged.
func (c *Client) Status(ctx context.Context, base, batchID string) (json.RawMessage, error) {
	return c.object(ctx, base+"/status?batch_id="+url.QueryEscape(batchID))
}

// Report returns the node's /report JSON object for batchID unchanged.
func (c *Client) Report(ctx context.Context, base, batchID string) (json.RawMessage, error) {
	return c.object(ctx, base+"/report?batch_id="+url.QueryEscape(batchID))
}

func (c *Client) object(ctx context.Context, u string) (json.RawMessage, error) {
	data, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, &Error{Kind: Decode, URL: u, Message: "expected a JSON object: " + err.Error()}
	}
	return json.RawMessage(bytes.TrimSpace(data)), nil
}

func (c *Client) do(ctx context.Context, method, u string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, &Error{Kind: Unreachable, URL: u, Message: err.Error()}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, transportError(ctx, u, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, transportError(ctx, u, err)
	}
	if len(data) > maxResponseBytes {
		return nil, &Error{Kind: Decode, URL: u, StatusCode: resp.StatusCode, Message: "response exceeds 4 MiB"}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := strings.TrimSpace(string(data))
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return nil, &Error{Kind: HTTP, URL: u, StatusCode: resp.StatusCode, Message: msg, Body: data}
	}
	return data, nil
}

func transportError(ctx context.Context, u string, err error) error {
	var ne net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return &Error{Kind: Timeout, URL: u, Message: err.Error()}
	}
	return &Error{Kind: Unreachable, URL: u, Message: err.Error()}
}
