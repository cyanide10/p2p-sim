package sim

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/p2p-sim/node/internal/task"
)

type fakeCmd struct {
	stdout, stderr string
	err            error
	block          bool // wait for ctx cancellation, like a hung process

	gotName string
	gotArgs []string
}

func (f *fakeCmd) Run(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
	f.gotName, f.gotArgs = name, args
	if f.block {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	return []byte(f.stdout), []byte(f.stderr), f.err
}

var testTask = task.Task{
	TaskID: "batch-0007",
	Seed:   42007,
	Params: task.SimParams{Lambda: 0.8, Mu: 1.0, SimTime: 10000, WarmupTime: 1000},
}

func newRunner(cmd CommandRunner) *SimRunner {
	return &SimRunner{Cmd: cmd, Python: "python3", Script: "/app/sim/simulate.py", Timeout: time.Second}
}

const okOutput = `{"seed":42007,"mean_wait_time":4.87,"mean_queue_length":3.91,"utilization":0.79,"packets_served":7213,"runtime_seconds":0.42}` + "\n"

func TestRunSuccess(t *testing.T) {
	cmd := &fakeCmd{stdout: okOutput}
	res, err := newRunner(cmd).Run(context.Background(), testTask)
	if err != nil {
		t.Fatal(err)
	}
	want := task.Result{
		TaskID: "batch-0007", Seed: 42007,
		MeanWaitTime: 4.87, MeanQueueLength: 3.91, Utilization: 0.79,
		PacketsServed: 7213, RuntimeSeconds: 0.42,
	}
	if res != want {
		t.Fatalf("result = %+v\nwant %+v", res, want)
	}
	if cmd.gotName != "python3" {
		t.Errorf("command = %q", cmd.gotName)
	}
	wantArgs := []string{
		"/app/sim/simulate.py", "--seed", "42007", "--lam", "0.8", "--mu", "1",
		"--sim-time", "10000", "--warmup-time", "1000",
	}
	if !reflect.DeepEqual(cmd.gotArgs, wantArgs) {
		t.Errorf("args = %q\nwant %q", cmd.gotArgs, wantArgs)
	}
}

func TestRunNonZeroExitIncludesStderr(t *testing.T) {
	cmd := &fakeCmd{stderr: "invalid parameters: unstable system: rho = 1.2 >= 1\n", err: errors.New("exit status 1")}
	_, err := newRunner(cmd).Run(context.Background(), testTask)
	if err == nil || !strings.Contains(err.Error(), "unstable system") {
		t.Fatalf("err = %v, want stderr content", err)
	}
}

func TestRunTimeout(t *testing.T) {
	r := newRunner(&fakeCmd{block: true})
	r.Timeout = 20 * time.Millisecond
	_, err := r.Run(context.Background(), testTask)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v, want timeout", err)
	}
}

func TestRunSeedMismatch(t *testing.T) {
	out := strings.Replace(okOutput, "42007", "1", 1)
	_, err := newRunner(&fakeCmd{stdout: out}).Run(context.Background(), testTask)
	if err == nil || !strings.Contains(err.Error(), "seed") {
		t.Fatalf("err = %v, want seed mismatch", err)
	}
}

func TestParseOutputErrors(t *testing.T) {
	cases := map[string]string{
		"empty":         "  \n",
		"not json":      "hello\n",
		"multiple line": "debug output\n" + okOutput,
		"missing field": `{"seed":1,"mean_wait_time":1}`,
		"wrong type":    `{"seed":"x","mean_wait_time":1,"mean_queue_length":1,"utilization":1,"packets_served":1,"runtime_seconds":1}`,
	}
	for name, stdout := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseOutput([]byte(stdout)); err == nil {
				t.Fatalf("ParseOutput(%q) should fail", stdout)
			}
		})
	}
}

func TestExecCommandRunnerCapturesStreams(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	stdout, stderr, err := ExecCommandRunner{}.Run(context.Background(), "sh", "-c", "echo out; echo err >&2; exit 3")
	if strings.TrimSpace(string(stdout)) != "out" || strings.TrimSpace(string(stderr)) != "err" {
		t.Fatalf("stdout=%q stderr=%q", stdout, stderr)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 3 {
		t.Fatalf("err = %v, want exit status 3", err)
	}
}

func TestSubprocessEnvIsMinimal(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh not available")
	}
	t.Setenv("SECRET_TOKEN", "do-not-leak")
	stdout, _, err := ExecCommandRunner{}.Run(context.Background(), "sh", "-c", "env")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stdout), "SECRET_TOKEN") {
		t.Fatalf("secret leaked into subprocess env:\n%s", stdout)
	}
	if !strings.Contains(string(stdout), "PYTHONDONTWRITEBYTECODE=1") {
		t.Fatalf("expected minimal env, got:\n%s", stdout)
	}
}

func TestCappedBuffer(t *testing.T) {
	b := &cappedBuffer{max: 4}
	for _, chunk := range []string{"ab", "cdef", "gh"} {
		if n, err := b.Write([]byte(chunk)); n != len(chunk) || err != nil {
			t.Fatalf("Write(%q) = %d, %v", chunk, n, err)
		}
	}
	if got := b.buf.String(); got != "abcd" {
		t.Fatalf("buffer = %q, want %q", got, "abcd")
	}
}
