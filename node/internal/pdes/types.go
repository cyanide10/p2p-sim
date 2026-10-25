package pdes

import (
	"encoding/json"

	"github.com/p2p-sim/node/internal/sim"
)

type Plan = sim.PartitionPlan

type ArrivalRecord struct {
	Flow   string  `json:"flow"`
	Seq    int64   `json:"seq"`
	Born   float64 `json:"born"`
	Link   string  `json:"link"`
	From   string  `json:"from"`
	To     string  `json:"to"`
	Start  float64 `json:"start"`
	Arrive float64 `json:"arrive"`
}

type StepRequest struct {
	Until   float64         `json:"until"`
	Inbound []ArrivalRecord `json:"inbound"`
}

type StepResponse struct {
	Outbound []ArrivalRecord `json:"outbound"`
	ComputeS float64         `json:"compute_s"`
	Events   int             `json:"events"`
}

type OpenRequest struct {
	Scenario json.RawMessage `json:"scenario"`
	Plan     Plan            `json:"plan"`
	Part     int             `json:"part"`
	Seed     int64           `json:"seed"`
}

type FinishResponse struct {
	Metrics json.RawMessage `json:"metrics"`
	State   json.RawMessage `json:"state"`
}
