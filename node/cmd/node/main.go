// Command node runs one member of the peer-to-peer simulation pool.
//
// Every node is identical. It executes simulation tasks sent by other nodes
// (POST /task), and it coordinates a batch of its own whenever a client sends
// it POST /run — dispatching tasks to every node in the static peer list,
// including itself (in-process). There is no permanent coordinator.
//
// Configuration (environment variables):
//
//	NODE_ID       this node's id; must appear in the peer list (default: hostname)
//	PEERS_CONFIG  static peer list shared by all nodes (default "/app/config/peers.yaml")
//	NODE_CONFIG   optional YAML: timeouts, retry policy, execution limits, run defaults
//	LOG_LEVEL     debug | info | warn | error (default "info")
//	LISTEN_ADDR, REQUEST_TIMEOUT, HEALTH_TIMEOUT, MAX_ATTEMPTS, BACKOFF_INITIAL,
//	BACKOFF_MAX, PHASE_TIMEOUT, SIM_TIMEOUT, MAX_CONCURRENT_TASKS, PYTHON_BIN,
//	SIM_SCRIPT    override individual settings
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/p2p-sim/node/internal/api"
	"github.com/p2p-sim/node/internal/batch"
	"github.com/p2p-sim/node/internal/config"
	"github.com/p2p-sim/node/internal/dispatch"
	"github.com/p2p-sim/node/internal/netbatch"
	"github.com/p2p-sim/node/internal/peers"
	"github.com/p2p-sim/node/internal/sim"
	"github.com/p2p-sim/node/internal/worker"
)

func main() {
	var level slog.LevelVar
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		_ = level.UnmarshalText([]byte(v))
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: &level}))
	if err := run(logger); err != nil {
		logger.Error("node exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID, _ = os.Hostname()
	}
	cfg, err := config.Load(os.Getenv("NODE_CONFIG"), os.Getenv)
	if err != nil {
		return err
	}
	peersPath := os.Getenv("PEERS_CONFIG")
	if peersPath == "" {
		peersPath = "/app/config/peers.yaml"
	}
	peerList, err := peers.Load(peersPath)
	if err != nil {
		return err
	}
	if !contains(peerList, nodeID) {
		return fmt.Errorf("NODE_ID %q is not listed in %s: every node must appear in the shared peer list", nodeID, peersPath)
	}

	logger = logger.With("node_id", nodeID)
	for _, p := range peerList {
		logger.Info("peer configured", "peer_id", p.ID, "url", p.URL, "self", p.ID == nodeID)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Executing side.
	// netsim.py sits next to simulate.py.
	netScript := filepath.Join(filepath.Dir(cfg.SimScript), "netsim.py")
	runner := &sim.SimRunner{
		Cmd:       sim.ExecCommandRunner{},
		Python:    cfg.PythonBin,
		Script:    cfg.SimScript,
		NetScript: netScript,
		Timeout:   cfg.SimTimeout,
	}
	executor := worker.New(runner, nodeID, cfg.MaxConcurrentTasks, logger)

	// Coordinating side: tasks for this node run in-process, others over HTTP.
	client := dispatch.RoutingClient{
		SelfID: nodeID,
		Local:  dispatch.LocalClient{Exec: executor},
		Remote: dispatch.NewHTTPClient(cfg.RequestTimeout, cfg.HealthTimeout),
	}
	dispatcher := &dispatch.Dispatcher{
		Client: client,
		Config: dispatch.Config{
			MaxAttempts:    cfg.MaxAttempts,
			BackoffInitial: cfg.BackoffInitial,
			BackoffMax:     cfg.BackoffMax,
		},
		Logger: logger,
	}
	manager := batch.NewManager(ctx, dispatcher, peerList, nodeID, cfg.Defaults, cfg.PhaseTimeout, logger)
	netsim := &sim.Network{Python: cfg.PythonBin, Script: netScript}
	netManager := netbatch.NewManager(ctx, dispatcher, peerList, nodeID, netsim, cfg.PhaseTimeout, logger)

	// POST /task can take up to SimTimeout; GET /peers up to HealthTimeout.
	writeTimeout := cfg.SimTimeout + 5*time.Second
	if w := cfg.HealthTimeout + 10*time.Second; w > writeTimeout {
		writeTimeout = w
	}
	// Live traffic streams run on this node and share its simulation slots.
	streamer := &sim.Streamer{Python: cfg.PythonBin, Script: cfg.SimScript}
	routes := http.NewServeMux()
	routes.Handle("GET /stream", api.StreamHandler(streamer, executor, nodeID, logger))
	routes.Handle("/", api.NetworkHandler(netManager, netsim, executor, nodeID, logger,
		api.NewHandler(manager, nodeID, peerList, client, executor, logger)))
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           routes,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("node listening",
			"addr", cfg.ListenAddr,
			"peers", len(peerList),
			"sim_script", cfg.SimScript,
			"sim_timeout", cfg.SimTimeout.String(),
			"max_concurrent_tasks", cfg.MaxConcurrentTasks,
			"request_timeout", cfg.RequestTimeout.String(),
			"max_attempts", cfg.MaxAttempts,
		)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

func contains(list []peers.Peer, id string) bool {
	for _, p := range list {
		if p.ID == id {
			return true
		}
	}
	return false
}
