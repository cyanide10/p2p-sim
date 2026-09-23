// Package dispatch distributes independent simulation replications across the
// nodes in the static peer list and tracks each task through its lifecycle.
// Whichever node receives POST /run uses this package to coordinate that
// batch; it treats itself as one of the workers.
//
// Why this is simple: replications are independent (embarrassingly parallel),
// so there is no causality or rollback logic as in PDES, and executing a task
// twice is harmless because a seed fully determines its result. A dead or
// slow node only costs the reassignment of its one in-flight task, never the
// correctness of the batch.
package dispatch

import (
	"fmt"

	"github.com/p2p-sim/node/internal/task"
)

// The wire types live in package task, shared with the executing side.
type (
	SimParams = task.SimParams
	Task      = task.Task
	Result    = task.Result
)

// SeedScheme documents how per-task seeds are derived.
const SeedScheme = "seed = base_seed + task_index (task_index = 0..replications-1)"

// GenerateTasks creates n tasks with seeds base_seed+0 … base_seed+n-1. Given
// the same base seed and parameters, the task set is identical, which makes a
// whole batch reproducible — on any coordinating node.
func GenerateTasks(batchID string, n int, baseSeed int64, p SimParams) []Task {
	tasks := make([]Task, n)
	for i := range tasks {
		tasks[i] = Task{
			TaskID: fmt.Sprintf("%s-%04d", batchID, i),
			Seed:   baseSeed + int64(i),
			Params: p,
		}
	}
	return tasks
}
