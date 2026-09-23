#!/usr/bin/env bash
# ─────────────────────────────────────────────
# Generic Agentic Dev Layout
# Usage: ./dev-agent.sh [project-dir]
# ─────────────────────────────────────────────

DIR="${1:-$(pwd)}"
SESSION="$(basename "$DIR")"

tmux kill-session -t "$SESSION" 2>/dev/null

# ── Window 1: agent ──────────────────────────
tmux new-session -d -s "$SESSION" -n agent -x 220 -y 50

# Left pane (65%) | Right top (35%) / Right bottom
tmux split-window -h -p 35 -t "$SESSION:agent"
tmux split-window -v -p 40 -t "$SESSION:agent"

tmux select-pane -t "$SESSION:agent.1"

# ── Window 2: server ─────────────────────────
tmux new-window -t "$SESSION" -n server

# Left pane (62%) | Right top / Right bottom
tmux split-window -h -p 38 -t "$SESSION:server"
tmux split-window -v -p 50 -t "$SESSION:server"

tmux select-pane -t "$SESSION:server.1"

# ── Window 3: git ────────────────────────────
tmux new-window -t "$SESSION" -n git

# Left top (70%) / Left bottom | Right (40%)
tmux split-window -h -p 40 -t "$SESSION:git"
tmux split-window -v -p 30 -t "$SESSION:git.1"

tmux select-pane -t "$SESSION:git.1"

# ── Start at window 1 ────────────────────────
tmux select-window -t "$SESSION:agent"
tmux attach -t "$SESSION"

mux attach -t "$SESSION"
