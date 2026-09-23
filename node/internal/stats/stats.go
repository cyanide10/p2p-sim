// Package stats aggregates per-replication results into sample statistics and
// compares them against closed-form M/M/1 queueing theory.
//
// Confidence intervals use the normal approximation
//
//	mean ± 1.96 · s / sqrt(n)
//
// which is accurate for a reasonably large number of replications (n ≥ 30).
// For small n it is too narrow; a Student-t critical value would be the
// correct replacement (see the stretch goals in the PRD).
package stats

import (
	"errors"
	"fmt"
	"math"
)

// Z95 is the two-sided 95% critical value of the standard normal distribution.
const Z95 = 1.959963984540054

// CIMethod describes how confidence intervals are computed, for reports.
const CIMethod = "normal approximation: mean ± 1.96·s/√n (valid for n ≥ 30)"

// Mean returns the arithmetic mean of xs, or NaN if xs is empty.
func Mean(xs []float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	var sum float64
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

// StdDev returns the sample standard deviation (n-1 denominator) of xs.
// It returns NaN for fewer than two samples.
func StdDev(xs []float64) float64 {
	if len(xs) < 2 {
		return math.NaN()
	}
	m := Mean(xs)
	var ss float64
	for _, x := range xs {
		d := x - m
		ss += d * d
	}
	return math.Sqrt(ss / float64(len(xs)-1))
}

// Summary holds sample statistics for one metric across replications.
type Summary struct {
	N         int     `json:"n"`
	Mean      float64 `json:"mean"`
	StdDev    float64 `json:"stddev"`
	CI95Low   float64 `json:"ci95_low"`
	CI95High  float64 `json:"ci95_high"`
	HalfWidth float64 `json:"ci95_half_width"`
}

// Summarize computes mean, sample standard deviation and a 95% confidence
// interval (normal approximation). At least two samples are required.
func Summarize(xs []float64) (Summary, error) {
	if len(xs) < 2 {
		return Summary{N: len(xs)}, fmt.Errorf("need at least 2 samples, got %d", len(xs))
	}
	m := Mean(xs)
	s := StdDev(xs)
	hw := Z95 * s / math.Sqrt(float64(len(xs)))
	return Summary{
		N:         len(xs),
		Mean:      m,
		StdDev:    s,
		CI95Low:   m - hw,
		CI95High:  m + hw,
		HalfWidth: hw,
	}, nil
}

// Contains reports whether v lies within the summary's 95% confidence interval.
func (s Summary) Contains(v float64) bool {
	return v >= s.CI95Low && v <= s.CI95High
}

// MM1Theory holds closed-form steady-state values for an M/M/1 queue.
type MM1Theory struct {
	Rho float64 `json:"rho"` // server utilization λ/μ
	L   float64 `json:"L"`   // expected number in system ρ/(1-ρ)
	W   float64 `json:"W"`   // expected time in system 1/(μ-λ)
}

// ErrUnstable is returned when λ ≥ μ, for which no steady state exists.
var ErrUnstable = errors.New("unstable queue: rho = lambda/mu must be < 1")

// MM1 computes the theoretical M/M/1 values for arrival rate lambda and
// service rate mu.
func MM1(lambda, mu float64) (MM1Theory, error) {
	if !(lambda > 0) || !(mu > 0) || math.IsInf(lambda, 0) || math.IsInf(mu, 0) {
		return MM1Theory{}, fmt.Errorf("lambda and mu must be positive finite numbers (lambda=%v, mu=%v)", lambda, mu)
	}
	if lambda >= mu {
		return MM1Theory{}, ErrUnstable
	}
	rho := lambda / mu
	return MM1Theory{
		Rho: rho,
		L:   rho / (1 - rho),
		W:   1 / (mu - lambda),
	}, nil
}

// Comparison relates a simulated metric to its theoretical value.
type Comparison struct {
	Summary
	Theoretical     float64 `json:"theoretical"`
	RelErrorPct     float64 `json:"rel_error_pct"`
	TolerancePct    float64 `json:"tolerance_pct"`
	WithinTolerance bool    `json:"within_tolerance"`
	TheoreticalInCI bool    `json:"theoretical_in_ci"`
}

// RelativeErrorPct returns |simulated - theoretical| / |theoretical| · 100.
func RelativeErrorPct(simulated, theoretical float64) float64 {
	if theoretical == 0 {
		if simulated == 0 {
			return 0
		}
		return math.Inf(1)
	}
	return math.Abs(simulated-theoretical) / math.Abs(theoretical) * 100
}

// Compare evaluates a simulated summary against a theoretical value using a
// relative-error tolerance expressed in percent.
func Compare(sim Summary, theoretical, tolerancePct float64) Comparison {
	relErr := RelativeErrorPct(sim.Mean, theoretical)
	return Comparison{
		Summary:         sim,
		Theoretical:     theoretical,
		RelErrorPct:     relErr,
		TolerancePct:    tolerancePct,
		WithinTolerance: relErr <= tolerancePct,
		TheoreticalInCI: sim.Contains(theoretical),
	}
}
