package sim

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestNetworkPlan(t *testing.T) {
	output := `{"ok":true,"parts":2,"assignment":{"h1":0,"r1":0},"cut_links":["l1"],"lookahead":0.5,"windows":20,"load":[1,1]}`
	network := &Network{
		Python: "python3",
		Script: "netsim.py",
		Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			return exec.CommandContext(ctx, "sh", "-c", "cat >/dev/null; printf '%s\\n' '"+output+"'")
		},
	}
	plan, err := network.Plan(context.Background(), []byte(`{}`), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.OK || plan.Parts != 2 || plan.Assignment["r1"] != 0 || plan.Lookahead != 0.5 {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestNetworkPlanReturnsScenarioErrors(t *testing.T) {
	network := &Network{
		Python: "python3",
		Script: "netsim.py",
		Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			return exec.CommandContext(ctx, "sh", "-c", "cat >/dev/null; echo 'invalid scenario: too many parts' >&2; exit 1")
		},
	}
	_, err := network.Plan(context.Background(), []byte(`{}`), 2)
	var scenarioErr *ScenarioError
	if !strings.Contains(err.Error(), "too many parts") || !errors.As(err, &scenarioErr) {
		t.Fatalf("err = %v; want ScenarioError", err)
	}
}
