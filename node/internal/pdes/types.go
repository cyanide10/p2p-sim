package pdes

import (
	"encoding/json"
	"strings"

	"github.com/p2p-sim/node/internal/sim"
)

type Plan = sim.PartitionPlan

// Options let the same coordinator serve different partitioned models. The
// network lab uses the defaults; the attack lab sets Kind "attack", a distinct
// run-ID prefix, peer endpoint prefix and start path.
type Options struct {
	Kind           string // status/report "kind" (default "pdes")
	RunPrefix      string // run-ID prefix (default "pdes")
	EndpointPrefix string // peer routes, e.g. "/pdes" (default "/pdes")
	StartPath      string // coordinator start route (default "/pdesrun")
}

func NetworkOptions() Options {
	return Options{Kind: "pdes", RunPrefix: "pdes", EndpointPrefix: "/pdes", StartPath: "/pdesrun"}
}

func (o Options) normalized() Options {
	defaults := NetworkOptions()
	if o.Kind == "" {
		o.Kind = defaults.Kind
	}
	if o.RunPrefix == "" {
		o.RunPrefix = defaults.RunPrefix
	}
	if o.EndpointPrefix == "" {
		o.EndpointPrefix = defaults.EndpointPrefix
	}
	if !strings.HasPrefix(o.EndpointPrefix, "/") {
		o.EndpointPrefix = "/" + o.EndpointPrefix
	}
	if o.StartPath == "" {
		o.StartPath = defaults.StartPath
	}
	if !strings.HasPrefix(o.StartPath, "/") {
		o.StartPath = "/" + o.StartPath
	}
	return o
}

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
