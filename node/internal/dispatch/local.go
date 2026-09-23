package dispatch

import (
	"context"

	"github.com/p2p-sim/node/internal/peers"
)

// Executor runs a task on this node. Implemented by worker.Executor.
type Executor interface {
	Execute(ctx context.Context, t Task) (Result, error)
}

// LocalClient runs tasks assigned to the coordinating node itself in-process,
// skipping HTTP. The node is always healthy from its own point of view.
type LocalClient struct {
	Exec Executor
}

func (c LocalClient) RunTask(ctx context.Context, _ peers.Peer, t Task) (Result, error) {
	return c.Exec.Execute(ctx, t)
}

func (LocalClient) Health(context.Context, peers.Peer) error { return nil }

// RoutingClient sends calls addressed to SelfID to Local and every other
// peer to Remote. This is what lets the coordinating node be one of its own
// workers without any special casing in the dispatcher.
type RoutingClient struct {
	SelfID string
	Local  PeerClient
	Remote PeerClient
}

func (c RoutingClient) pick(p peers.Peer) PeerClient {
	if p.ID == c.SelfID {
		return c.Local
	}
	return c.Remote
}

func (c RoutingClient) RunTask(ctx context.Context, p peers.Peer, t Task) (Result, error) {
	return c.pick(p).RunTask(ctx, p, t)
}

func (c RoutingClient) Health(ctx context.Context, p peers.Peer) error {
	return c.pick(p).Health(ctx, p)
}
