package cluster

import (
	"context"
	"testing"
	"time"

	"github.com/p2p-sim/gateway/internal/nodeclient"
	"github.com/p2p-sim/gateway/internal/testnode"
)

func seen(v bool) *bool { return &v }

func view(ids ...string) map[string]bool {
	m := map[string]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func TestProbeAllHealthy(t *testing.T) {
	a, b := testnode.New("node-1"), testnode.New("node-2")
	defer a.Close()
	defer b.Close()
	for _, n := range []*testnode.Node{a, b} {
		n.Update(func(n *testnode.Node) { n.PeerView = view("node-1", "node-2") })
	}
	snap := Probe(context.Background(), nodeclient.New(time.Second), testnode.Peers(a, b))
	if len(snap.Nodes) != 2 || snap.UpdatedAt.IsZero() {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
	for _, n := range snap.Nodes {
		if !n.Healthy || n.ObserverID == nil || *n.ObserverID != n.ID || n.LatencyMS == nil || n.Error != "" {
			t.Fatalf("unexpected row: %+v", n)
		}
		if got := n.PeersSeen["node-2"]; got == nil || !*got {
			t.Fatalf("row %s does not see node-2 healthy", n.ID)
		}
	}
}

func TestProbeOneDown(t *testing.T) {
	a, b, c := testnode.New("node-1"), testnode.New("node-2"), testnode.New("node-3")
	defer a.Close()
	defer c.Close()
	peers := testnode.Peers(a, b, c)
	b.Close()
	a.Update(func(n *testnode.Node) { n.PeerView = map[string]bool{"node-1": true, "node-2": false, "node-3": true} })

	snap := Probe(context.Background(), nodeclient.New(time.Second), peers)
	down := snap.Nodes[1]
	if down.ID != "node-2" || down.Healthy || down.Error == "" || down.ObserverID != nil || down.LatencyMS != nil {
		t.Fatalf("unexpected down row: %+v", down)
	}
	for _, v := range down.PeersSeen {
		if v != nil {
			t.Fatalf("down node must not report peers: %+v", down.PeersSeen)
		}
	}
	if got := snap.Nodes[0].PeersSeen["node-2"]; got == nil || *got {
		t.Fatalf("node-1 should see node-2 down, got %v", got)
	}
	if !snap.Nodes[2].Healthy {
		t.Fatal("node-3 should be healthy")
	}
}

func TestProbeDisagreementAndUnknown(t *testing.T) {
	a, b := testnode.New("node-1"), testnode.New("node-2")
	defer a.Close()
	defer b.Close()
	a.Update(func(n *testnode.Node) { n.PeerView = map[string]bool{"node-1": true, "node-2": false} })
	b.Update(func(n *testnode.Node) { n.PeerView = map[string]bool{"node-2": true} })

	snap := Probe(context.Background(), nodeclient.New(time.Second), testnode.Peers(a, b))
	want := map[string]map[string]*bool{
		"node-1": {"node-1": seen(true), "node-2": seen(false)},
		"node-2": {"node-1": nil, "node-2": seen(true)},
	}
	for _, n := range snap.Nodes {
		for id, w := range want[n.ID] {
			g := n.PeersSeen[id]
			if (g == nil) != (w == nil) || (g != nil && *g != *w) {
				t.Fatalf("%s sees %s as %v, want %v", n.ID, id, g, w)
			}
		}
	}
}

func TestProbeFourNodes(t *testing.T) {
	var nodes []*testnode.Node
	for _, id := range []string{"node-1", "node-2", "node-3", "node-4"} {
		n := testnode.New(id)
		defer n.Close()
		nodes = append(nodes, n)
	}
	snap := Probe(context.Background(), nodeclient.New(time.Second), testnode.Peers(nodes...))
	if len(snap.Nodes) != 4 || snap.Nodes[3].ID != "node-4" || len(snap.Nodes[3].PeersSeen) != 4 {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
}

func TestUnhealthyNodeStillReportsItsView(t *testing.T) {
	a := testnode.New("node-1")
	defer a.Close()
	a.Update(func(n *testnode.Node) { n.Healthy = false })
	snap := Probe(context.Background(), nodeclient.New(time.Second), testnode.Peers(a))
	row := snap.Nodes[0]
	if row.Healthy || row.Error == "" || row.ObserverID == nil {
		t.Fatalf("unexpected row: %+v", row)
	}
}
