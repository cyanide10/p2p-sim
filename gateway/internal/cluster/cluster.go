// Package cluster builds the /api/cluster view: each configured node's
// health as the gateway sees it, plus that node's own /peers view, which
// together form the who-sees-whom matrix.
package cluster

import (
	"context"
	"sync"
	"time"

	"github.com/p2p-sim/gateway/internal/config"
	"github.com/p2p-sim/gateway/internal/nodeclient"
)

const maxConcurrentProbes = 8

// Node is one row. PeersSeen has a key for every configured node; nil means
// this observer did not report it.
type Node struct {
	ID         string           `json:"id"`
	URL        string           `json:"url"`
	Healthy    bool             `json:"healthy"`
	ObserverID *string          `json:"observer_id"`
	LatencyMS  *int64           `json:"latency_ms"`
	PeersSeen  map[string]*bool `json:"peers_seen"`
	Error      string           `json:"error,omitempty"`
}

type Snapshot struct {
	Nodes     []Node    `json:"nodes"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Probe queries every peer concurrently. A failing node only affects its own row.
func Probe(ctx context.Context, c *nodeclient.Client, peers []config.Peer) Snapshot {
	rows := make([]Node, len(peers))
	sem := make(chan struct{}, maxConcurrentProbes)
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func(i int, p config.Peer) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			rows[i] = probeOne(ctx, c, p, peers)
		}(i, p)
	}
	wg.Wait()
	return Snapshot{Nodes: rows, UpdatedAt: time.Now().UTC()}
}

func probeOne(ctx context.Context, c *nodeclient.Client, p config.Peer, all []config.Peer) Node {
	row := Node{ID: p.ID, URL: p.URL, PeersSeen: make(map[string]*bool, len(all))}
	for _, other := range all {
		row.PeersSeen[other.ID] = nil
	}

	start := time.Now()
	if err := c.Health(ctx, p.URL); err != nil {
		row.Error = err.Error()
	} else {
		ms := time.Since(start).Milliseconds()
		row.Healthy, row.LatencyMS = true, &ms
	}

	view, err := c.Peers(ctx, p.URL)
	if err != nil {
		if row.Error == "" {
			row.Error = err.Error()
		}
		return row
	}
	id := p.ID
	row.ObserverID = &id
	for _, ph := range view.Peers {
		if _, configured := row.PeersSeen[ph.ID]; configured {
			healthy := ph.Healthy
			row.PeersSeen[ph.ID] = &healthy
		}
	}
	return row
}
