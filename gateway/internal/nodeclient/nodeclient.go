// Package nodeclient calls the p2p-sim node HTTP API (docs/node-api-observed.md).
// Status and report bodies are returned as raw JSON so the gateway passes the
// node's real shape through unchanged.
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
	"time"
)

// MaxBody caps how much of a node response is read.
const MaxBody = 4 << 20

type Kind int

const (
	KindUnreachable Kind = iota // connection failed, refused redirect, etc.
	KindTimeout                 // the per-call deadline passed
	KindStatus                  // node answered with a non-2xx status
	KindDecode                  // the body was not the expected JSON, or too large
)

// Error describes a failed node call.
type Error struct {
	Kind    Kind
	Status  int             // for KindStatus
	Message string          // node's "error" field for KindStatus, else a description
	Body    json.RawMessage // raw node error body for KindStatus, if JSON
	Err     error
}

func (e *Error) Error() string {
	switch e.Kind {
	case KindStatus:
		return fmt.Sprintf("node returned %d: %s", e.Status, e.Message)
	case KindTimeout:
		return "node request timed out: " + e.Message
	case KindDecode:
		return "invalid node response: " + e.Message
	default:
		return "node unreachable: " + e.Message
	}
}

func (e *Error) Unwrap() error { return e.Err }

// IsStatus reports whether err is a node response with this HTTP status.
func IsStatus(err error, status int) bool {
	var ne *Error
	return errors.As(err, &ne) && ne.Kind == KindStatus && ne.Status == status
}

var errRedirect = errors.New("redirects are not followed")

type Client struct {
	http    *http.Client
	stream  *http.Client // no overall deadline: live streams last minutes
	timeout time.Duration
}

func New(timeout time.Duration) *Client {
	refuseRedirect := func(*http.Request, []*http.Request) error { return errRedirect }
	return &Client{
		timeout: timeout,
		http: &http.Client{
			CheckRedirect: refuseRedirect,
			Transport: &http.Transport{
				Proxy:               nil,
				DialContext:         (&net.Dialer{Timeout: timeout}).DialContext,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
		stream: &http.Client{
			CheckRedirect: refuseRedirect,
			Transport: &http.Transport{
				Proxy:                 nil,
				DialContext:           (&net.Dialer{Timeout: timeout}).DialContext,
				ResponseHeaderTimeout: timeout,
				DisableCompression:    true,
			},
		},
	}
}

// OpenStream opens a node's GET /stream (Server-Sent Events). The caller
// reads and closes the body; cancelling ctx ends the stream on the node too.
func (c *Client) OpenStream(ctx context.Context, base string, query url.Values) (io.ReadCloser, error) {
	return c.openSSE(ctx, http.MethodGet, base+"/stream?"+query.Encode(), nil)
}

// OpenNetStream opens a node's POST /netstream with a JSON body
// {scenario, speed, seed}. Same contract as OpenStream.
func (c *Client) OpenNetStream(ctx context.Context, base string, body []byte) (io.ReadCloser, error) {
	return c.openSSE(ctx, http.MethodPost, base+"/netstream", body)
}

func (c *Client) openSSE(ctx context.Context, method, target string, payload []byte) (io.ReadCloser, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, &Error{Kind: KindUnreachable, Message: err.Error(), Err: err}
	}
	req.Header.Set("Accept", "text/event-stream")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return nil, classify(ctx, err)
	}
	if resp.StatusCode == http.StatusOK {
		return resp.Body, nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	e := &Error{Kind: KindStatus, Status: resp.StatusCode, Message: http.StatusText(resp.StatusCode)}
	var nodeErr struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &nodeErr) == nil {
		e.Body = body
		if nodeErr.Error != "" {
			e.Message = nodeErr.Error
		}
	}
	return nil, e
}

type Health struct {
	Status string `json:"status"`
	NodeID string `json:"node_id"`
	Peers  int    `json:"peers"`
}

type PeerView struct {
	NodeID string `json:"node_id"`
	Peers  []struct {
		ID      string `json:"id"`
		URL     string `json:"url"`
		Self    bool   `json:"self"`
		Healthy bool   `json:"healthy"`
		Error   string `json:"error,omitempty"`
	} `json:"peers"`
}

// RunRequest is the node's POST /run body; nil fields are omitted.
type RunRequest struct {
	Replications   *int     `json:"replications,omitempty"`
	Lambda         *float64 `json:"lambda,omitempty"`
	Mu             *float64 `json:"mu,omitempty"`
	SimTime        *float64 `json:"sim_time,omitempty"`
	WarmupTime     *float64 `json:"warmup_time,omitempty"`
	TolerancePct   *float64 `json:"tolerance_pct,omitempty"`
	BaseSeed       *int64   `json:"base_seed,omitempty"`
	SerialBaseline *bool    `json:"serial_baseline,omitempty"`
}

type RunStarted struct {
	BatchID      string `json:"batch_id"`
	Status       string `json:"status"`
	Coordinator  string `json:"coordinator"`
	Replications int    `json:"replications"`
	BaseSeed     int64  `json:"base_seed"`
	Peers        int    `json:"peers"`
}

func (c *Client) Health(ctx context.Context, base string) (Health, error) {
	var h Health
	body, err := c.do(ctx, http.MethodGet, base+"/health", nil)
	if err == nil {
		err = decode(body, &h)
	}
	return h, err
}

func (c *Client) Peers(ctx context.Context, base string) (PeerView, error) {
	var v PeerView
	body, err := c.do(ctx, http.MethodGet, base+"/peers", nil)
	if err == nil {
		err = decode(body, &v)
	}
	return v, err
}

func (c *Client) Run(ctx context.Context, base string, req RunRequest) (RunStarted, error) {
	var started RunStarted
	payload, err := json.Marshal(req)
	if err != nil {
		return started, err
	}
	body, err := c.do(ctx, http.MethodPost, base+"/run", payload)
	if err == nil {
		err = decode(body, &started)
	}
	if err == nil && started.BatchID == "" {
		err = &Error{Kind: KindDecode, Message: "run response has no batch_id"}
	}
	return started, err
}

// NetRunRequest is the node's POST /netrun body.
type NetRunRequest struct {
	Scenario     json.RawMessage `json:"scenario"`
	Replications *int            `json:"replications,omitempty"`
	BaseSeed     *int64          `json:"base_seed,omitempty"`
}

// NetRun starts a network-scenario batch on the node at base.
func (c *Client) NetRun(ctx context.Context, base string, req NetRunRequest) (RunStarted, error) {
	var started RunStarted
	payload, err := json.Marshal(req)
	if err != nil {
		return started, err
	}
	// The node validates the scenario with a subprocess first: allow it more time.
	body, err := c.doTimeout(ctx, http.MethodPost, base+"/netrun", payload, c.timeout+15*time.Second)
	if err == nil {
		err = decode(body, &started)
	}
	if err == nil && started.BatchID == "" {
		err = &Error{Kind: KindDecode, Message: "netrun response has no batch_id"}
	}
	return started, err
}

// Status returns the raw GET /status body for a batch.
func (c *Client) Status(ctx context.Context, base, batchID string) (json.RawMessage, error) {
	return c.object(ctx, base+"/status?batch_id="+url.QueryEscape(batchID))
}

// Report returns the raw GET /report body for a batch.
func (c *Client) Report(ctx context.Context, base, batchID string) (json.RawMessage, error) {
	return c.object(ctx, base+"/report?batch_id="+url.QueryEscape(batchID))
}

func (c *Client) object(ctx context.Context, target string) (json.RawMessage, error) {
	body, err := c.do(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	var obj map[string]json.RawMessage
	if err := decode(body, &obj); err != nil {
		return nil, err
	}
	return body, nil
}

func (c *Client) do(ctx context.Context, method, target string, payload []byte) ([]byte, error) {
	return c.doTimeout(ctx, method, target, payload, c.timeout)
}

func (c *Client) doTimeout(ctx context.Context, method, target string, payload []byte, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, &Error{Kind: KindUnreachable, Message: err.Error(), Err: err}
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, classify(ctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBody+1))
	if err != nil {
		return nil, classify(ctx, err)
	}
	if len(body) > MaxBody {
		return nil, &Error{Kind: KindDecode, Message: "response body exceeds 4 MiB"}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &Error{Kind: KindStatus, Status: resp.StatusCode, Message: http.StatusText(resp.StatusCode)}
		var nodeErr struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &nodeErr) == nil {
			e.Body = body
			if nodeErr.Error != "" {
				e.Message = nodeErr.Error
			}
		}
		return nil, e
	}
	return body, nil
}

func classify(ctx context.Context, err error) error {
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded ||
		(errors.As(err, &netErr) && netErr.Timeout()) {
		return &Error{Kind: KindTimeout, Message: err.Error(), Err: err}
	}
	return &Error{Kind: KindUnreachable, Message: err.Error(), Err: err}
}

func decode(body []byte, dst any) error {
	if err := json.Unmarshal(body, dst); err != nil {
		return &Error{Kind: KindDecode, Message: err.Error(), Err: err}
	}
	return nil
}
