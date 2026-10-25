package netbatch

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/stats"
)

// metrics is one replication's output from netsim.py. Values are numbers or
// null (for example mean_delay when nothing was delivered).
type metrics struct {
	Duration float64                        `json:"duration"`
	Flows    map[string]map[string]*float64 `json:"flows"`
	Links    map[string]map[string]*float64 `json:"links"`
	Routers  map[string]map[string]*float64 `json:"routers"`
	Totals   map[string]*float64            `json:"totals"`
	Series   struct {
		BinWidth      float64               `json:"bin_width"`
		DeliveredRate []*float64            `json:"delivered_rate"`
		DroppedRate   []*float64            `json:"dropped_rate"`
		MeanDelay     []*float64            `json:"mean_delay"`
		Flows         map[string][]*float64 `json:"flows"`
	} `json:"series"`
}

// Estimate is a metric across replications: mean and 95% CI over the
// replications where it was defined.
type Estimate struct {
	N         int     `json:"n"`
	Mean      float64 `json:"mean"`
	StdDev    float64 `json:"stddev"`
	CI95Low   float64 `json:"ci95_low"`
	CI95High  float64 `json:"ci95_high"`
	HalfWidth float64 `json:"ci95_half_width"`
}

func estimate(xs []float64) *Estimate {
	switch len(xs) {
	case 0:
		return nil
	case 1:
		return &Estimate{N: 1, Mean: xs[0], CI95Low: xs[0], CI95High: xs[0]}
	}
	s, _ := stats.Summarize(xs)
	return &Estimate{N: s.N, Mean: s.Mean, StdDev: s.StdDev, CI95Low: s.CI95Low, CI95High: s.CI95High, HalfWidth: s.HalfWidth}
}

// Band is a time series across replications: per-bin mean and 95% CI.
type Band struct {
	Mean []*float64 `json:"mean"`
	Low  []*float64 `json:"low"`
	High []*float64 `json:"high"`
}

func band(series [][]*float64) Band {
	n := 0
	for _, s := range series {
		n = max(n, len(s))
	}
	b := Band{Mean: make([]*float64, n), Low: make([]*float64, n), High: make([]*float64, n)}
	for i := range n {
		var xs []float64
		for _, s := range series {
			if i < len(s) && s[i] != nil {
				xs = append(xs, *s[i])
			}
		}
		if e := estimate(xs); e != nil {
			mean, low, high := e.Mean, e.CI95Low, e.CI95High
			b.Mean[i], b.Low[i], b.High[i] = &mean, &low, &high
		}
	}
	return b
}

type Report struct {
	Kind                  string                          `json:"kind"`
	BatchID               string                          `json:"batch_id"`
	Coordinator           string                          `json:"coordinator"`
	State                 string                          `json:"state"`
	Phase                 string                          `json:"phase"`
	Verdict               string                          `json:"verdict"` // PENDING | COMPLETE | FAIL
	VerdictDetail         string                          `json:"verdict_detail"`
	ReplicationsRequested int                             `json:"replications_requested"`
	BaseSeed              int64                           `json:"base_seed"`
	SeedScheme            string                          `json:"seed_scheme"`
	CIMethod              string                          `json:"ci_method"`
	Scenario              json.RawMessage                 `json:"scenario"`
	Tasks                 dispatch.Counts                 `json:"tasks"`
	TasksPerPeer          map[string]int                  `json:"tasks_per_peer"`
	FailedTasks           []FailedTask                    `json:"failed_tasks"`
	Flows                 map[string]map[string]*Estimate `json:"flows"`
	Links                 map[string]map[string]*Estimate `json:"links"`
	Routers               map[string]map[string]*Estimate `json:"routers"`
	Totals                map[string]*Estimate            `json:"totals"`
	Series                struct {
		BinWidth      float64         `json:"bin_width"`
		DeliveredRate Band            `json:"delivered_rate"`
		DroppedRate   Band            `json:"dropped_rate"`
		MeanDelay     Band            `json:"mean_delay"`
		Flows         map[string]Band `json:"flows"`
	} `json:"series"`
	Timing struct {
		DistributedWallSeconds    float64 `json:"distributed_wall_clock_seconds"`
		DistributedPeers          int     `json:"distributed_peers"`
		ReplicationRuntimeSeconds float64 `json:"sum_replication_runtime_seconds"`
		// Sum of replication runtimes divided by wall clock: how many
		// replications ran at once on average across the pool.
		Parallelism *float64 `json:"parallelism"`
	} `json:"timing"`
}

type FailedTask struct {
	TaskID   string `json:"task_id"`
	Seed     int64  `json:"seed"`
	Attempts int    `json:"attempts"`
	Error    string `json:"error"`
}

func (b *Batch) Report() Report {
	b.mu.Lock()
	wall := b.wall
	b.mu.Unlock()
	finished := b.finished()
	if !finished {
		wall = time.Since(b.StartedAt)
	}
	st := b.Status()
	r := Report{
		Kind: "network", BatchID: b.ID, Coordinator: b.Coordinator, State: st.State, Phase: st.Phase,
		ReplicationsRequested: b.Replications, BaseSeed: b.BaseSeed, SeedScheme: dispatch.SeedScheme,
		CIMethod: stats.CIMethod, Scenario: b.Scenario, Tasks: st.Counts,
		TasksPerPeer: map[string]int{}, FailedTasks: []FailedTask{},
	}
	var reps []metrics
	for _, res := range b.tracker.Results() {
		var m metrics
		if err := json.Unmarshal([]byte(res.Network), &m); err != nil {
			continue
		}
		reps = append(reps, m)
		r.TasksPerPeer[res.PeerID]++
		r.Timing.ReplicationRuntimeSeconds += res.RuntimeSeconds
	}
	for _, f := range b.tracker.FailedTasks() {
		r.FailedTasks = append(r.FailedTasks, FailedTask{TaskID: f.Task.TaskID, Seed: f.Task.Seed, Attempts: f.Attempts, Error: f.LastError})
	}

	r.Flows = table(reps, func(m metrics) map[string]map[string]*float64 { return m.Flows })
	r.Links = table(reps, func(m metrics) map[string]map[string]*float64 { return m.Links })
	r.Routers = table(reps, func(m metrics) map[string]map[string]*float64 { return m.Routers })
	r.Totals = map[string]*Estimate{}
	for _, field := range fieldNames(reps, func(m metrics) map[string]*float64 { return m.Totals }) {
		r.Totals[field] = estimate(values(reps, func(m metrics) *float64 { return m.Totals[field] }))
	}
	collect := func(get func(m metrics) []*float64) Band {
		series := make([][]*float64, 0, len(reps))
		for _, m := range reps {
			series = append(series, get(m))
		}
		return band(series)
	}
	if len(reps) > 0 {
		r.Series.BinWidth = reps[0].Series.BinWidth
	}
	r.Series.DeliveredRate = collect(func(m metrics) []*float64 { return m.Series.DeliveredRate })
	r.Series.DroppedRate = collect(func(m metrics) []*float64 { return m.Series.DroppedRate })
	r.Series.MeanDelay = collect(func(m metrics) []*float64 { return m.Series.MeanDelay })
	r.Series.Flows = map[string]Band{}
	for _, fid := range keys(reps, func(m metrics) []string { return mapKeys(m.Series.Flows) }) {
		r.Series.Flows[fid] = collect(func(m metrics) []*float64 { return m.Series.Flows[fid] })
	}

	r.Timing.DistributedWallSeconds = wall.Seconds()
	r.Timing.DistributedPeers = len(b.Peers)
	if wall > 0 && r.Timing.ReplicationRuntimeSeconds > 0 {
		p := r.Timing.ReplicationRuntimeSeconds / wall.Seconds()
		r.Timing.Parallelism = &p
	}

	switch {
	case !finished:
		r.Verdict, r.VerdictDetail = "PENDING", fmt.Sprintf("%d of %d replications complete; estimates are provisional", st.Complete, b.Replications)
	case len(reps) == 0:
		r.Verdict, r.VerdictDetail = "FAIL", "no replication completed"
	default:
		r.Verdict, r.VerdictDetail = "COMPLETE", fmt.Sprintf("%d of %d replications complete", len(reps), b.Replications)
		if n := len(r.FailedTasks); n > 0 {
			r.VerdictDetail += fmt.Sprintf("; %d permanently failed", n)
		}
	}
	return r
}

// table aggregates id -> field -> value across replications.
func table(reps []metrics, get func(metrics) map[string]map[string]*float64) map[string]map[string]*Estimate {
	out := map[string]map[string]*Estimate{}
	for _, id := range keys(reps, func(m metrics) []string { return mapKeys(get(m)) }) {
		row := map[string]*Estimate{}
		for _, field := range fieldNames(reps, func(m metrics) map[string]*float64 { return get(m)[id] }) {
			row[field] = estimate(values(reps, func(m metrics) *float64 { return get(m)[id][field] }))
		}
		out[id] = row
	}
	return out
}

func values(reps []metrics, get func(metrics) *float64) []float64 {
	var xs []float64
	for _, m := range reps {
		if v := get(m); v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) {
			xs = append(xs, *v)
		}
	}
	return xs
}

func fieldNames(reps []metrics, get func(metrics) map[string]*float64) []string {
	return keys(reps, func(m metrics) []string { return mapKeys(get(m)) })
}

func keys(reps []metrics, get func(metrics) []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range reps {
		for _, k := range get(m) {
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out
}

func mapKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
