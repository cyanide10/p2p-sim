// Package task defines the wire types exchanged between nodes. Every node runs
// the same binary, so these types are shared by the coordinating side
// (dispatch, batch) and the executing side (worker, sim).
package task

import (
	"encoding/json"
	"errors"
)

type SimParams struct {
	Lambda     float64 `json:"lambda"`
	Mu         float64 `json:"mu"`
	SimTime    float64 `json:"sim_time"`
	WarmupTime float64 `json:"warmup_time"`
}

type Task struct {
	TaskID string    `json:"task_id"`
	Seed   int64     `json:"seed"`
	Params SimParams `json:"params"`
	// Network, when set, is a network scenario (sim/netsim.py) to simulate
	// instead of the single M/M/1 queue described by Params.
	Network RawJSON `json:"network,omitempty"`
}

// RawJSON carries a JSON value through unchanged. It is a string so the wire
// types stay comparable; the empty string means "absent".
type RawJSON string

func (r RawJSON) MarshalJSON() ([]byte, error) {
	if r == "" {
		return []byte("null"), nil
	}
	return []byte(r), nil
}

func (r *RawJSON) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*r = ""
		return nil
	}
	if !json.Valid(data) {
		return errors.New("invalid JSON value")
	}
	*r = RawJSON(data)
	return nil
}

type Result struct {
	TaskID          string  `json:"task_id"`
	PeerID          string  `json:"peer_id"`
	Seed            int64   `json:"seed"`
	MeanWaitTime    float64 `json:"mean_wait_time"`
	MeanQueueLength float64 `json:"mean_queue_length"`
	Utilization     float64 `json:"utilization"`
	PacketsServed   int64   `json:"packets_served"`
	RuntimeSeconds  float64 `json:"runtime_seconds"`
	// Network holds the per-replication metrics of a network task.
	Network RawJSON `json:"network,omitempty"`
}

// ErrBusy means a node refused a task because it is at its concurrent-task
// limit. Nothing was executed, so the task should be requeued without
// charging a retry attempt.
var ErrBusy = errors.New("node busy: concurrent task limit reached")
