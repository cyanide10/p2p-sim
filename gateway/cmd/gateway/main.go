// Command gateway serves the p2p-sim GUI and its API: it aggregates node
// health, submits batches to a chosen coordinator, and keeps run history.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/runs"
	"github.com/p2p-sim/gateway/internal/server"
	"github.com/p2p-sim/gateway/internal/store"
	"github.com/p2p-sim/gateway/webui"
)

var version = "dev"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the local /healthz and exit 0 if healthy (for container health checks)")
	flag.Parse()

	settings, err := config.LoadSettings(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gateway:", err)
		os.Exit(2)
	}
	if *healthcheck {
		os.Exit(probe(settings.Listen))
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: settings.LogLevel}))
	if err := run(settings, log); err != nil {
		log.Error("gateway stopped", "err", err)
		os.Exit(1)
	}
}

func run(settings config.Settings, log *slog.Logger) error {
	peers, err := config.NewPeerSource(settings.PeersPath, log)
	if err != nil {
		return err
	}
	defaults, err := config.LoadDefaults(settings.NodeConfigPath)
	if err != nil {
		log.Warn("using built-in run defaults", "err", err)
	}
	db, err := store.Open(settings.DBPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()

	nodes := nodeclient.New(settings.NodeTimeout)
	manager := runs.New(runs.Options{
		Store: db, Nodes: nodes, Peers: peers, Defaults: defaults,
		PollInterval: settings.PollInterval, LostAfter: settings.LostAfter,
		HistoryLimit: settings.HistoryLimit, MaxTrackers: settings.MaxTrackers, Log: log,
	})
	if err := manager.Resume(context.Background()); err != nil {
		return fmt.Errorf("resume tracking: %w", err)
	}

	srv := &http.Server{
		Addr: settings.Listen,
		Handler: server.Handler(server.Options{
			Peers: peers, Nodes: nodes, Runs: manager, Defaults: defaults,
			Token: settings.Token, Version: version, Static: webui.FS(), Log: log,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		log.Info("gateway listening", "addr", settings.Listen, "peers", len(peers.Peers()), "auth", settings.Token != "")
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		manager.Shutdown(context.Background())
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = srv.Shutdown(shutdownCtx)
	if trackErr := manager.Shutdown(shutdownCtx); trackErr != nil {
		err = errors.Join(err, trackErr)
	}
	return err
}

// probe checks the gateway's own /healthz over loopback.
func probe(listen string) int {
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
