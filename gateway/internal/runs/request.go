package runs

import (
	"fmt"
	"math"

	"github.com/p2p-sim/gateway/internal/config"
)

// MaxBrowserSeed keeps every task seed exactly representable as a
// JavaScript number.
const MaxBrowserSeed = 1<<53 - 1

// CreateRequest is the POST /api/runs body. Omitted run fields take the
// gateway's defaults; an omitted base seed is left for the node to choose.
type CreateRequest struct {
	Coordinator    string   `json:"coordinator"`
	Replications   *int     `json:"replications"`
	Lambda         *float64 `json:"lambda"`
	Mu             *float64 `json:"mu"`
	SimTime        *float64 `json:"sim_time"`
	WarmupTime     *float64 `json:"warmup_time"`
	TolerancePct   *float64 `json:"tolerance_pct"`
	BaseSeed       *int64   `json:"base_seed"`
	SerialBaseline *bool    `json:"serial_baseline"`
}

// NodeRequest is the resolved body forwarded to the coordinator's POST /run.
type NodeRequest struct {
	Replications   int     `json:"replications"`
	Lambda         float64 `json:"lambda"`
	Mu             float64 `json:"mu"`
	SimTime        float64 `json:"sim_time"`
	WarmupTime     float64 `json:"warmup_time"`
	TolerancePct   float64 `json:"tolerance_pct"`
	BaseSeed       *int64  `json:"base_seed,omitempty"`
	SerialBaseline bool    `json:"serial_baseline"`
}

// Params are a run's effective parameters as stored in its record.
type Params struct {
	Replications   int     `json:"replications"`
	Lambda         float64 `json:"lambda"`
	Mu             float64 `json:"mu"`
	SimTime        float64 `json:"sim_time"`
	WarmupTime     float64 `json:"warmup_time"`
	TolerancePct   float64 `json:"tolerance_pct"`
	BaseSeed       int64   `json:"base_seed"`
	SerialBaseline bool    `json:"serial_baseline"`
}

// Params combines the request with what the node accepted.
func (r NodeRequest) Params(replications int, baseSeed int64) Params {
	return Params{
		Replications:   replications,
		Lambda:         r.Lambda,
		Mu:             r.Mu,
		SimTime:        r.SimTime,
		WarmupTime:     r.WarmupTime,
		TolerancePct:   r.TolerancePct,
		BaseSeed:       baseSeed,
		SerialBaseline: r.SerialBaseline,
	}
}

type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// Resolve applies defaults and the same rules as the node and the web form.
func Resolve(req CreateRequest, d config.Defaults) (NodeRequest, error) {
	r := NodeRequest{
		Replications:   d.Replications,
		Lambda:         d.Lambda,
		Mu:             d.Mu,
		SimTime:        d.SimTime,
		WarmupTime:     d.WarmupTime,
		TolerancePct:   d.TolerancePct,
		BaseSeed:       req.BaseSeed,
		SerialBaseline: d.SerialBaseline,
	}
	if req.Replications != nil {
		r.Replications = *req.Replications
	}
	if req.Lambda != nil {
		r.Lambda = *req.Lambda
	}
	if req.Mu != nil {
		r.Mu = *req.Mu
	}
	if req.SimTime != nil {
		r.SimTime = *req.SimTime
	}
	if req.WarmupTime != nil {
		r.WarmupTime = *req.WarmupTime
	}
	if req.TolerancePct != nil {
		r.TolerancePct = *req.TolerancePct
	}
	if req.SerialBaseline != nil {
		r.SerialBaseline = *req.SerialBaseline
	}

	finite := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
	positive := func(v float64) bool { return finite(v) && v > 0 }
	switch {
	case r.Replications < 2 || r.Replications > 100_000:
		return r, invalid("replications must be between 2 and 100000, got %d", r.Replications)
	case !positive(r.Lambda):
		return r, invalid("lambda must be a positive number")
	case !positive(r.Mu):
		return r, invalid("mu must be a positive number")
	case r.Lambda >= r.Mu:
		return r, invalid("unstable system: rho = lambda/mu = %.4f must be < 1", r.Lambda/r.Mu)
	case !positive(r.SimTime):
		return r, invalid("sim_time must be a positive number")
	case !finite(r.WarmupTime) || r.WarmupTime < 0:
		return r, invalid("warmup_time must be >= 0")
	case r.WarmupTime >= r.SimTime:
		return r, invalid("warmup_time (%v) must be less than sim_time (%v)", r.WarmupTime, r.SimTime)
	case !positive(r.TolerancePct):
		return r, invalid("tolerance_pct must be a positive number")
	case r.BaseSeed != nil && (*r.BaseSeed < 0 || *r.BaseSeed > MaxBrowserSeed-int64(r.Replications)):
		return r, invalid("base_seed must be between 0 and %d for %d replications", MaxBrowserSeed-int64(r.Replications), r.Replications)
	}
	return r, nil
}
