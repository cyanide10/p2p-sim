package stats

import (
	"errors"
	"math"
	"testing"
)

const eps = 1e-9

func approx(a, b float64) bool { return math.Abs(a-b) <= eps*math.Max(1, math.Abs(b)) }

func TestMeanAndStdDev(t *testing.T) {
	xs := []float64{2, 4, 4, 4, 5, 5, 7, 9}
	if got := Mean(xs); !approx(got, 5) {
		t.Fatalf("Mean = %v, want 5", got)
	}
	// Sample variance = 32/7.
	if got, want := StdDev(xs), math.Sqrt(32.0/7.0); !approx(got, want) {
		t.Fatalf("StdDev = %v, want %v", got, want)
	}
}

func TestDegenerateInputs(t *testing.T) {
	if !math.IsNaN(Mean(nil)) {
		t.Error("Mean(nil) should be NaN")
	}
	if !math.IsNaN(StdDev([]float64{1})) {
		t.Error("StdDev of one sample should be NaN")
	}
	if _, err := Summarize([]float64{1}); err == nil {
		t.Error("Summarize of one sample should fail")
	}
}

func TestSummarizeCI(t *testing.T) {
	xs := []float64{4.8, 5.1, 5.3, 4.9, 5.0, 4.7, 5.2, 5.0}
	s, err := Summarize(xs)
	if err != nil {
		t.Fatal(err)
	}
	wantHW := Z95 * StdDev(xs) / math.Sqrt(8)
	if !approx(s.HalfWidth, wantHW) {
		t.Fatalf("half width = %v, want %v", s.HalfWidth, wantHW)
	}
	if !approx(s.CI95Low, s.Mean-wantHW) || !approx(s.CI95High, s.Mean+wantHW) {
		t.Fatalf("CI = [%v, %v], want mean ± %v", s.CI95Low, s.CI95High, wantHW)
	}
	if !s.Contains(s.Mean) || s.Contains(s.CI95High+1) {
		t.Fatal("Contains misbehaves")
	}
	if s.N != 8 {
		t.Fatalf("N = %d", s.N)
	}
}

func TestZeroVarianceCI(t *testing.T) {
	s, err := Summarize([]float64{3, 3, 3})
	if err != nil {
		t.Fatal(err)
	}
	if s.StdDev != 0 || s.CI95Low != 3 || s.CI95High != 3 {
		t.Fatalf("unexpected summary %+v", s)
	}
}

func TestMM1(t *testing.T) {
	th, err := MM1(0.8, 1.0)
	if err != nil {
		t.Fatal(err)
	}
	if !approx(th.Rho, 0.8) || !approx(th.L, 4) || !approx(th.W, 5) {
		t.Fatalf("MM1(0.8,1) = %+v, want rho=0.8 L=4 W=5", th)
	}
	// Little's law: L = λW.
	if !approx(th.L, 0.8*th.W) {
		t.Fatal("Little's law violated")
	}
}

func TestMM1Invalid(t *testing.T) {
	if _, err := MM1(1, 1); !errors.Is(err, ErrUnstable) {
		t.Errorf("rho=1: err = %v, want ErrUnstable", err)
	}
	if _, err := MM1(2, 1); !errors.Is(err, ErrUnstable) {
		t.Errorf("rho=2: err = %v, want ErrUnstable", err)
	}
	for _, c := range [][2]float64{{0, 1}, {-1, 1}, {0.5, 0}, {math.NaN(), 1}, {0.5, math.Inf(1)}} {
		if _, err := MM1(c[0], c[1]); err == nil {
			t.Errorf("MM1(%v, %v) should fail", c[0], c[1])
		}
	}
}

func TestCompare(t *testing.T) {
	sim := Summary{N: 100, Mean: 5.2, StdDev: 1, CI95Low: 5.0, CI95High: 5.4}
	c := Compare(sim, 5.0, 10)
	if !approx(c.RelErrorPct, 4) {
		t.Fatalf("rel err = %v, want 4", c.RelErrorPct)
	}
	if !c.WithinTolerance {
		t.Error("4% should be within 10% tolerance")
	}
	if !c.TheoreticalInCI {
		t.Error("5.0 lies in [5.0, 5.4]")
	}

	c = Compare(sim, 4.0, 10)
	if c.WithinTolerance || c.TheoreticalInCI {
		t.Errorf("30%% error should fail: %+v", c)
	}
}

func TestRelativeErrorZeroTheory(t *testing.T) {
	if RelativeErrorPct(0, 0) != 0 {
		t.Error("0 vs 0 should be 0%")
	}
	if !math.IsInf(RelativeErrorPct(1, 0), 1) {
		t.Error("1 vs 0 should be +Inf")
	}
}
