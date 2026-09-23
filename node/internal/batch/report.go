package batch

import (
	"fmt"
	"time"

	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/stats"
)

// StatusView is the GET /status body.
type StatusView struct {
	BatchID      string `json:"batch_id"`
	Coordinator  string `json:"coordinator"`
	State        string `json:"state"` // running | complete
	Phase        Phase  `json:"phase"`
	Replications int    `json:"replications"`
	dispatch.Counts
	ElapsedSeconds float64          `json:"elapsed_seconds"`
	SerialBaseline *dispatch.Counts `json:"serial_baseline,omitempty"`
}

func (b *Batch) Status() StatusView {
	b.mu.Lock()
	phase, finishedAt, serial := b.phase, b.finishedAt, b.serial
	b.mu.Unlock()

	v := StatusView{
		BatchID:      b.ID,
		Coordinator:  b.Coordinator,
		State:        state(phase),
		Phase:        phase,
		Replications: b.Spec.Replications,
		Counts:       b.distributed.Counts(),
	}
	end := time.Now()
	if !finishedAt.IsZero() {
		end = finishedAt
	}
	v.ElapsedSeconds = end.Sub(b.StartedAt).Seconds()
	if serial != nil {
		c := serial.Counts()
		v.SerialBaseline = &c
	}
	return v
}

func state(p Phase) string {
	if p == PhaseComplete {
		return "complete"
	}
	return "running"
}

// Report is the GET /report body.
type Report struct {
	BatchID       string `json:"batch_id"`
	Coordinator   string `json:"coordinator"`
	State         string `json:"state"`
	Phase         Phase  `json:"phase"`
	Verdict       string `json:"verdict"` // PASS | FAIL | PENDING
	VerdictDetail string `json:"verdict_detail"`

	Params       dispatch.SimParams `json:"params"`
	Replications int                `json:"replications_requested"`
	BaseSeed     int64              `json:"base_seed"`
	SeedScheme   string             `json:"seed_scheme"`
	TolerancePct float64            `json:"tolerance_pct"`
	CIMethod     string             `json:"ci_method"`

	Tasks        dispatch.Counts `json:"tasks"`
	TasksPerPeer map[string]int  `json:"tasks_per_peer"`
	FailedTasks  []FailedTask    `json:"failed_tasks"`

	Theoretical     stats.MM1Theory   `json:"theoretical"`
	MeanWaitTime    *stats.Comparison `json:"mean_wait_time"`    // vs W
	MeanQueueLength *stats.Comparison `json:"mean_queue_length"` // vs L
	Utilization     *stats.Comparison `json:"utilization"`       // vs rho (informational)

	Timing Timing `json:"timing"`
}

type FailedTask struct {
	TaskID   string `json:"task_id"`
	Seed     int64  `json:"seed"`
	Attempts int    `json:"attempts"`
	Error    string `json:"error"`
}

type Timing struct {
	DistributedWallSeconds float64 `json:"distributed_wall_clock_seconds"`
	DistributedPeers       int     `json:"distributed_peers"`
	// Sum of per-replication simulation runtimes as measured inside the peers.
	ReplicationRuntimeSeconds float64 `json:"sum_replication_runtime_seconds"`

	SerialPeer         string   `json:"serial_peer,omitempty"`
	SerialWallSeconds  *float64 `json:"serial_wall_clock_seconds"`
	Speedup            *float64 `json:"speedup"` // serial / distributed wall clock
	SerialResultsMatch *bool    `json:"serial_results_match_distributed,omitempty"`
	SerialNote         string   `json:"serial_note,omitempty"`
}

// Report aggregates the batch's completed replications. It can be called at
// any time; while the distributed phase is running the statistics are
// provisional and the verdict is PENDING.
func (b *Batch) Report() Report {
	b.mu.Lock()
	phase := b.phase
	distributedDone, distributedWall := b.distributedDone, b.distributedWall
	serial, serialPeer, serialStart, serialWall, serialNote := b.serial, b.serialPeer, b.serialStart, b.serialWall, b.serialNote
	b.mu.Unlock()

	r := Report{
		BatchID:      b.ID,
		Coordinator:  b.Coordinator,
		State:        state(phase),
		Phase:        phase,
		Params:       b.Spec.Params,
		Replications: b.Spec.Replications,
		BaseSeed:     b.Spec.BaseSeed,
		SeedScheme:   dispatch.SeedScheme,
		TolerancePct: b.Spec.TolerancePct,
		CIMethod:     stats.CIMethod,
		Tasks:        b.distributed.Counts(),
		TasksPerPeer: make(map[string]int),
		FailedTasks:  []FailedTask{},
		Theoretical:  b.theory,
	}

	results := b.distributed.Results()
	waits := make([]float64, 0, len(results))
	lengths := make([]float64, 0, len(results))
	utils := make([]float64, 0, len(results))
	for _, res := range results {
		waits = append(waits, res.MeanWaitTime)
		lengths = append(lengths, res.MeanQueueLength)
		utils = append(utils, res.Utilization)
		r.TasksPerPeer[res.PeerID]++
		r.Timing.ReplicationRuntimeSeconds += res.RuntimeSeconds
	}
	for _, f := range b.distributed.FailedTasks() {
		r.FailedTasks = append(r.FailedTasks, FailedTask{
			TaskID: f.Task.TaskID, Seed: f.Task.Seed, Attempts: f.Attempts, Error: f.LastError,
		})
	}

	tol := b.Spec.TolerancePct
	if s, err := stats.Summarize(waits); err == nil {
		c := stats.Compare(s, b.theory.W, tol)
		r.MeanWaitTime = &c
	}
	if s, err := stats.Summarize(lengths); err == nil {
		c := stats.Compare(s, b.theory.L, tol)
		r.MeanQueueLength = &c
	}
	if s, err := stats.Summarize(utils); err == nil {
		c := stats.Compare(s, b.theory.Rho, tol)
		r.Utilization = &c
	}

	r.Timing.DistributedPeers = len(b.Peers)
	if distributedDone {
		r.Timing.DistributedWallSeconds = distributedWall.Seconds()
	} else {
		r.Timing.DistributedWallSeconds = time.Since(b.StartedAt).Seconds()
	}

	r.Timing.SerialNote = serialNote
	if serial != nil {
		r.Timing.SerialPeer = serialPeer
		var secs float64
		if serialWall > 0 {
			secs = serialWall.Seconds()
			if distributedWall > 0 {
				speedup := serialWall.Seconds() / distributedWall.Seconds()
				r.Timing.Speedup = &speedup
			}
			if match, ok := resultsMatch(results, serial.Results()); ok {
				r.Timing.SerialResultsMatch = &match
			}
		} else {
			secs = time.Since(serialStart).Seconds()
			r.Timing.SerialNote = "serial baseline in progress"
		}
		r.Timing.SerialWallSeconds = &secs
	}

	r.Verdict, r.VerdictDetail = verdict(distributedDone, r)
	return r
}

func verdict(distributedDone bool, r Report) (string, string) {
	w, l := r.MeanWaitTime, r.MeanQueueLength
	var v, detail string
	switch {
	case !distributedDone:
		return "PENDING", "distributed phase still running; statistics are provisional"
	case w == nil || l == nil:
		v, detail = "FAIL", "fewer than 2 replications completed"
	default:
		v = "FAIL"
		if w.WithinTolerance && l.WithinTolerance {
			v = "PASS"
		}
		detail = fmt.Sprintf("W rel. error %.2f%%, L rel. error %.2f%% (tolerance %.2f%%); theoretical W in CI: %t, L in CI: %t",
			w.RelErrorPct, l.RelErrorPct, r.TolerancePct, w.TheoreticalInCI, l.TheoreticalInCI)
	}
	if n := len(r.FailedTasks); n > 0 {
		detail += fmt.Sprintf("; %d task(s) permanently failed", n)
	}
	return v, detail
}

// resultsMatch reports whether every seed present in both result sets
// produced identical statistics. ok is false if no seeds overlap.
func resultsMatch(a, b []dispatch.Result) (match, ok bool) {
	bySeed := make(map[int64]dispatch.Result, len(a))
	for _, r := range a {
		bySeed[r.Seed] = r
	}
	compared := 0
	for _, r := range b {
		o, found := bySeed[r.Seed]
		if !found {
			continue
		}
		compared++
		if o.MeanWaitTime != r.MeanWaitTime || o.MeanQueueLength != r.MeanQueueLength ||
			o.Utilization != r.Utilization || o.PacketsServed != r.PacketsServed {
			return false, true
		}
	}
	return true, compared > 0
}
