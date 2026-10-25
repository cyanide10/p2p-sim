package sim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// MaxNetStreamPacketRate mirrors netsim.py's MAX_STREAM_PACKET_RATE.
const MaxNetStreamPacketRate = 150.0

// ScenarioError is an invalid network scenario, as reported by netsim.py.
type ScenarioError struct{ Msg string }

func (e *ScenarioError) Error() string { return e.Msg }

// Summary is netsim.py --validate output.
type Summary struct {
	OK             bool    `json:"ok"`
	Nodes          int     `json:"nodes"`
	Links          int     `json:"links"`
	Flows          int     `json:"flows"`
	OfferedPackets float64 `json:"offered_packets"`
	PeakRate       float64 `json:"peak_rate"`
}

// Network runs sim/netsim.py for validation and live streams. Scenarios
// travel on stdin; only numbers are passed as arguments.
type Network struct {
	Python string
	Script string // path to netsim.py
	// Command builds the subprocess; nil means exec.CommandContext.
	Command func(ctx context.Context, name string, args ...string) *exec.Cmd
}

func (n *Network) command(ctx context.Context, args ...string) *exec.Cmd {
	if n.Command != nil {
		return n.Command(ctx, n.Python, append([]string{n.Script}, args...)...)
	}
	return exec.CommandContext(ctx, n.Python, append([]string{n.Script}, args...)...)
}

// Validate checks a scenario with netsim.py --validate. An invalid scenario
// returns *ScenarioError.
func (n *Network) Validate(ctx context.Context, scenario []byte) (Summary, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var out []byte
	err := pipeLines(ctx, ctx, 15*time.Second, n.command(ctx, "--validate"), scenario, func(line []byte) error {
		out = append([]byte(nil), line...)
		return nil
	})
	if err != nil {
		msg := err.Error()
		if i := strings.Index(msg, "invalid scenario: "); i >= 0 {
			return Summary{}, &ScenarioError{Msg: msg[i+len("invalid scenario: "):]}
		}
		return Summary{}, err
	}
	var s Summary
	if err := json.Unmarshal(out, &s); err != nil || !s.OK {
		return Summary{}, errors.New("network validator returned no result")
	}
	return s, nil
}

// Stream runs one network replication in real time (speed simulated seconds
// per wall-clock second) and passes each JSON event line to onLine.
func (n *Network) Stream(ctx context.Context, scenario []byte, seed int64, speed, start float64, onLine func([]byte) error) error {
	var head struct {
		Duration float64 `json:"duration"`
	}
	if err := json.Unmarshal(scenario, &head); err != nil || !(head.Duration > 0) || !(speed > 0) || math.IsInf(speed, 0) {
		return &ScenarioError{Msg: "scenario duration and speed must be positive"}
	}
	if !(start >= 0 && start < head.Duration) {
		return &ScenarioError{Msg: "start must be within the run"}
	}
	// Fast-forwarding to start takes about as long as a batch replication.
	limit := time.Duration((head.Duration-start)/speed*float64(time.Second)) + 40*time.Second
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	args := []string{"--stream", "--seed", strconv.FormatInt(seed, 10), "--speed", strconv.FormatFloat(speed, 'g', -1, 64),
		"--start", strconv.FormatFloat(start, 'g', -1, 64)}
	return pipeLines(parent, ctx, limit, n.command(ctx, args...), scenario, onLine)
}

// CheckStreamRate rejects playback that would exceed the packet-rate cap.
func CheckStreamRate(s Summary, speed float64) error {
	if !(speed > 0) || math.IsInf(speed, 0) {
		return &ScenarioError{Msg: "speed must be a positive number"}
	}
	if s.PeakRate*speed > MaxNetStreamPacketRate {
		return &ScenarioError{Msg: fmt.Sprintf("%.0f packets per second at this speed exceeds %.0f; lower the speed",
			s.PeakRate*speed, MaxNetStreamPacketRate)}
	}
	return nil
}
