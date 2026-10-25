// Command gateway serves the p2p-sim web app's API. It forwards run
// requests to the chosen coordinating node, tracks each run until its report
// is available, and keeps the results in memory so the browser that started
// a run can always read them back.
//
// Configuration (environment variables):
//
//	GATEWAY_LISTEN        bind address (default "127.0.0.1:8090")
//	PEERS_CONFIG          node ids and host-reachable URLs (default "config/peers.gateway.yaml")
//	NODE_CONFIG           node config whose defaults block fills omitted run fields (default "config/node.yaml")
//	NODE_REQUEST_TIMEOUT  per node call (default "5s")
//	LOG_LEVEL             debug | info | warn | error (default "info")
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
	"github.com/p2p-sim/gateway/internal/server"
)

const (
	historyCapacity = 200
	pollInterval    = time.Second
	maxPollFailures = 5
)

func main() {
	if err := run(); err != nil {
		slog.Error("gateway exited", "error", err)
		os.Exit(1)
	}
}

func run() error {
	settings, err := config.LoadSettings(os.Getenv)
	if err != nil {
		return err
	}
	var level slog.LevelVar
	if err := level.UnmarshalText([]byte(settings.LogLevel)); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: &level}))

	peers, err := config.LoadPeers(settings.PeersPath)
	if err != nil {
		return err
	}
	defaults, err := config.LoadDefaults(settings.NodeConfigPath)
	if err != nil {
		return err
	}
	peerURLs := make(map[string]string, len(peers))
	for _, p := range peers {
		peerURLs[p.ID] = p.URL
		logger.Info("node configured", "peer_id", p.ID, "url", p.URL)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := nodeclient.New(settings.RequestTimeout)
	store := runs.NewStore(historyCapacity)
	tracker := runs.NewTracker(ctx, store, client, peerURLs, pollInterval, maxPollFailures, logger)

	srv := &http.Server{
		Addr: settings.Listen,
		Handler: server.New(server.Deps{
			Peers: peers, Defaults: defaults, Client: client,
			Store: store, Tracker: tracker, Logger: logger, Version: "dev",
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("gateway listening", "addr", settings.Listen, "nodes", len(peers))
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
	err = srv.Shutdown(shutdownCtx)
	tracker.Wait()
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}
