package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/task"
)

// TrafficStreamer runs one live replication. Implemented by sim.Streamer.
type TrafficStreamer interface {
	Stream(ctx context.Context, p sim.StreamParams, onLine func([]byte) error) error
}

// SlotAcquirer hands out simulation slots. Implemented by worker.Executor,
// so live streams share the node's concurrency limit with batch tasks.
type SlotAcquirer interface {
	Acquire() (release func(), err error)
}

// StreamHandler serves GET /stream: one M/M/1 replication run in real time on
// this node, streamed as Server-Sent Events with one JSON packet event per
// message (see simulate.py --stream).
//
//	?lambda=0.8&mu=1&duration=300&speed=10&seed=42   (seed optional)
func StreamHandler(streamer TrafficStreamer, slots SlotAcquirer, nodeID string, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := parseStreamParams(r)
		if err == nil {
			err = p.Validate()
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
			return
		}
		release, err := slots.Acquire()
		if errors.Is(err, task.ErrBusy) {
			writeJSON(w, http.StatusServiceUnavailable, errorBody{Error: err.Error()})
			return
		}
		defer release()

		// The stream outlives the server's WriteTimeout, which is sized for tasks.
		rc := http.NewResponseController(w)
		if err := rc.SetWriteDeadline(time.Time{}); err != nil {
			logger.Warn("live stream: cannot clear write deadline", "error", err)
		}
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Accel-Buffering", "no")
		h.Set("X-Node-Id", nodeID)
		w.WriteHeader(http.StatusOK)
		rc.Flush()

		log := logger.With("seed", p.Seed, "lambda", p.Lambda, "mu", p.Mu, "speed", p.Speed)
		log.Info("live stream started", "duration", p.Duration)
		err = streamer.Stream(r.Context(), p, func(line []byte) error {
			if _, err := fmt.Fprintf(w, "data: %s\n\n", line); err != nil {
				return err
			}
			return rc.Flush()
		})
		switch {
		case r.Context().Err() != nil:
			log.Info("live stream closed by viewer")
		case err != nil:
			log.Warn("live stream failed", "error", err)
			fmt.Fprintf(w, "data: {\"type\":\"error\",\"message\":%q}\n\n", err.Error())
			rc.Flush()
		default:
			log.Info("live stream finished")
		}
	})
}

func parseStreamParams(r *http.Request) (sim.StreamParams, error) {
	q := r.URL.Query()
	p := sim.StreamParams{Seed: time.Now().UnixMilli(), Duration: 300, Speed: 10}
	float := func(name string, dst *float64, required bool) error {
		v := q.Get(name)
		if v == "" {
			if required {
				return fmt.Errorf("%s is required", name)
			}
			return nil
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return fmt.Errorf("%s must be a number, got %q", name, v)
		}
		*dst = f
		return nil
	}
	if err := errors.Join(
		float("lambda", &p.Lambda, true),
		float("mu", &p.Mu, true),
		float("duration", &p.Duration, false),
		float("speed", &p.Speed, false),
	); err != nil {
		return p, err
	}
	if v := q.Get("seed"); v != "" {
		seed, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return p, fmt.Errorf("seed must be an integer, got %q", v)
		}
		p.Seed = seed
	}
	return p, nil
}
