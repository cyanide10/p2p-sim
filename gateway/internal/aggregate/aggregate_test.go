package aggregate

import (
	"context"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/testnode"
)

func TestClusterHealthy(t *testing.T) {
	_, peers := testnode.Pool(t, 4)
	snap := Cluster(context.Background(), nodeclient.New(time.Second), peers, 2)
	if len(snap.Nodes) != 4 {
		t.Fatalf("%d nodes; want 4", len(snap.Nodes))
	}
	for i, n := range snap.Nodes {
		if n.ID != peers[i].ID || !n.Healthy || n.ObserverID == nil || *n.ObserverID != n.ID || n.LatencyMS == nil {
			t.Fatalf("node %d: %+v", i, n)
		}
		if len(n.PeersSeen) != 4 || !n.PeersSeen["node-4"] {
			t.Fatalf("node %d peers_seen %v", i, n.PeersSeen)
		}
	}
}

func TestClusterNodeDownAndDisagreement(t *testing.T) {
	nodes, peers := testnode.Pool(t, 3)
	nodes[1].SetDown(true)
	nodes[0].SetSees("node-2", true) // node-1 still thinks node-2 is up
	nodes[2].SetSees("node-2", false)
	snap := Cluster(context.Background(), nodeclient.New(time.Second), peers, 8)
	down := snap.Nodes[1]
	if down.Healthy || down.Error == "" || down.ObserverID != nil || down.LatencyMS != nil {
		t.Fatalf("down node row: %+v", down)
	}
	if !snap.Nodes[0].PeersSeen["node-2"] || snap.Nodes[2].PeersSeen["node-2"] {
		t.Fatal("observer views were not reported per observer")
	}
}

func TestClusterAllDown(t *testing.T) {
	nodes, peers := testnode.Pool(t, 2)
	for _, n := range nodes {
		n.SetDown(true)
	}
	snap := Cluster(context.Background(), nodeclient.New(time.Second), peers, 8)
	for _, n := range snap.Nodes {
		if n.Healthy {
			t.Fatalf("%s reported healthy", n.ID)
		}
	}
}
