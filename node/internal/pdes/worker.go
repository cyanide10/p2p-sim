package pdes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	maxMessageBytes = 8 << 20
	maxReplyBytes   = 64 << 20
)

type Worker interface {
	Open(context.Context, OpenRequest) error
	Step(context.Context, StepRequest) (StepResponse, error)
	Finish(context.Context) (FinishResponse, error)
	Close() error
}

type WorkerFactory func() Worker

type ProcessFactory struct {
	Python string
	Script string
}

func (f ProcessFactory) New() Worker {
	return &ProcessWorker{Python: f.Python, Script: f.Script}
}

type ProcessWorker struct {
	Python string
	Script string

	mu      sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	scanner *bufio.Scanner
	stderr  *limitedBuffer
	closed  bool
}

func (w *ProcessWorker) Open(ctx context.Context, req OpenRequest) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cmd != nil {
		return errors.New("partition worker is already open")
	}
	w.cmd = exec.Command(w.Python, w.Script, "--partition")
	w.cmd.Env = safePythonEnv()
	w.cmd.WaitDelay = 2 * time.Second
	stdout, err := w.cmd.StdoutPipe()
	if err != nil {
		return err
	}
	w.stdin, err = w.cmd.StdinPipe()
	if err != nil {
		return err
	}
	w.stderr = &limitedBuffer{limit: 4 << 10}
	w.cmd.Stderr = w.stderr
	if err := w.cmd.Start(); err != nil {
		return fmt.Errorf("start partition worker: %w", err)
	}
	w.scanner = bufio.NewScanner(stdout)
	w.scanner.Buffer(make([]byte, 4096), maxReplyBytes)
	var reply struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := w.exchange(ctx, map[string]any{
		"op": "open", "scenario": req.Scenario, "plan": req.Plan, "part": req.Part, "seed": req.Seed,
	}, &reply); err != nil {
		w.stopLocked()
		return err
	}
	if !reply.OK {
		w.stopLocked()
		return errors.New("partition worker did not acknowledge open")
	}
	return nil
}

func (w *ProcessWorker) Step(ctx context.Context, req StepRequest) (StepResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var reply StepResponse
	if err := w.exchange(ctx, map[string]any{
		"op": "step", "until": req.Until, "inbound": req.Inbound,
	}, &reply); err != nil {
		w.stopLocked()
		return StepResponse{}, err
	}
	return reply, nil
}

func (w *ProcessWorker) Finish(ctx context.Context) (FinishResponse, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var reply FinishResponse
	err := w.exchange(ctx, map[string]any{"op": "finish"}, &reply)
	w.stopLocked()
	return reply, err
}

func (w *ProcessWorker) exchange(ctx context.Context, request, response any) error {
	if w.closed || w.stdin == nil || w.scanner == nil {
		return errors.New("partition worker is not running")
	}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if len(data) > maxMessageBytes {
		return fmt.Errorf("partition request exceeds %d bytes", maxMessageBytes)
	}
	if _, err := w.stdin.Write(append(data, '\n')); err != nil {
		return w.processError("write partition request", err)
	}
	type scanResult struct {
		line []byte
		err  error
	}
	result := make(chan scanResult, 1)
	go func() {
		if w.scanner.Scan() {
			result <- scanResult{line: append([]byte(nil), w.scanner.Bytes()...)}
			return
		}
		if err := w.scanner.Err(); err != nil {
			result <- scanResult{err: err}
			return
		}
		result <- scanResult{err: io.EOF}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case got := <-result:
		if got.err != nil {
			return w.processError("read partition response", got.err)
		}
		var envelope struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(got.line, &envelope); err != nil {
			return fmt.Errorf("invalid partition worker JSON: %w", err)
		}
		if envelope.Error != "" {
			return errors.New(envelope.Error)
		}
		if err := json.Unmarshal(got.line, response); err != nil {
			return fmt.Errorf("invalid partition worker response: %w", err)
		}
		return nil
	}
}

func (w *ProcessWorker) processError(action string, err error) error {
	if w.cmd != nil && w.cmd.ProcessState != nil {
		return fmt.Errorf("%s: %w: %s", action, err, strings.TrimSpace(w.stderr.String()))
	}
	return fmt.Errorf("%s: %w", action, err)
}

func (w *ProcessWorker) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopLocked()
}

func (w *ProcessWorker) stopLocked() error {
	if w.closed {
		return nil
	}
	w.closed = true
	if w.stdin != nil {
		_ = w.stdin.Close()
	}
	if w.cmd == nil || w.cmd.Process == nil {
		return nil
	}
	killed := false
	if w.cmd.ProcessState == nil {
		if err := w.cmd.Process.Kill(); err == nil {
			killed = true
		}
	}
	err := w.cmd.Wait()
	if err != nil && !killed && w.cmd.ProcessState != nil && w.cmd.ProcessState.ExitCode() != 0 {
		return fmt.Errorf("partition worker exited: %w: %s", err, strings.TrimSpace(w.stderr.String()))
	}
	return nil
}

func safePythonEnv() []string {
	env := []string{"PYTHONDONTWRITEBYTECODE=1"}
	for _, key := range []string{"PATH", "LANG"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

type limitedBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			_, _ = b.buf.Write(p[:room])
		} else {
			_, _ = b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
