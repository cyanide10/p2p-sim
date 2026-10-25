// Package config loads gateway settings from the environment, the shared
// peers file (re-read when it changes) and the run defaults from the shared
// node config file.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type Settings struct {
	Listen         string
	PeersPath      string
	NodeConfigPath string
	DBPath         string
	Token          string
	NodeTimeout    time.Duration
	HistoryLimit   int
	LogLevel       slog.Level
	PollInterval   time.Duration
	LostAfter      int // consecutive status failures before coordinator_lost
	MaxTrackers    int
}

// LoadSettings reads settings through getenv, applying defaults.
func LoadSettings(getenv func(string) string) (Settings, error) {
	s := Settings{
		Listen:         "127.0.0.1:8080",
		PeersPath:      "config/peers.yaml",
		NodeConfigPath: "config/node.yaml",
		DBPath:         "./data/gateway.db",
		NodeTimeout:    5 * time.Second,
		HistoryLimit:   500,
		LogLevel:       slog.LevelInfo,
		PollInterval:   time.Second,
		LostAfter:      5,
		MaxTrackers:    64,
	}
	str := func(key string, dst *string) {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			*dst = v
		}
	}
	str("GATEWAY_LISTEN", &s.Listen)
	str("PEERS_CONFIG", &s.PeersPath)
	str("NODE_CONFIG", &s.NodeConfigPath)
	str("GATEWAY_DB", &s.DBPath)
	s.Token = getenv("GATEWAY_TOKEN")

	var errs []error
	duration := func(key string, dst *time.Duration) {
		if v := getenv(key); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil || d <= 0 {
				errs = append(errs, fmt.Errorf("%s: want a positive duration, got %q", key, v))
				return
			}
			*dst = d
		}
	}
	integer := func(key string, dst *int) {
		if v := getenv(key); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				errs = append(errs, fmt.Errorf("%s: want a positive integer, got %q", key, v))
				return
			}
			*dst = n
		}
	}
	duration("NODE_REQUEST_TIMEOUT", &s.NodeTimeout)
	duration("POLL_INTERVAL", &s.PollInterval)
	integer("HISTORY_LIMIT", &s.HistoryLimit)
	integer("LOST_AFTER_FAILURES", &s.LostAfter)
	integer("MAX_TRACKERS", &s.MaxTrackers)
	if v := getenv("LOG_LEVEL"); v != "" {
		if err := s.LogLevel.UnmarshalText([]byte(v)); err != nil {
			errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
		}
	}
	return s, errors.Join(errs...)
}

type Peer struct {
	ID  string `yaml:"id" json:"id"`
	URL string `yaml:"url" json:"url"`
}

// ParsePeers parses and validates a peers file: at least one peer, unique
// non-empty ids, absolute http(s) URLs.
func ParsePeers(data []byte) ([]Peer, error) {
	var file struct {
		Peers []Peer `yaml:"peers"`
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&file); err != nil {
		return nil, fmt.Errorf("parse peers: %w", err)
	}
	if len(file.Peers) == 0 {
		return nil, errors.New("peers: list is empty")
	}
	seen := make(map[string]bool, len(file.Peers))
	for i, p := range file.Peers {
		if p.ID == "" {
			return nil, fmt.Errorf("peers[%d]: id is empty", i)
		}
		if seen[p.ID] {
			return nil, fmt.Errorf("peers[%d]: duplicate id %q", i, p.ID)
		}
		seen[p.ID] = true
		u, err := url.Parse(p.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("peers[%d] (%s): url must be an absolute http(s) URL, got %q", i, p.ID, p.URL)
		}
		file.Peers[i].URL = strings.TrimRight(p.URL, "/")
	}
	return file.Peers, nil
}

// PeerSource serves the current peer list and re-reads the file when its
// modification time or size changes. An invalid edit is logged and the
// previous list is kept.
type PeerSource struct {
	path string
	log  *slog.Logger

	mu         sync.Mutex
	peers      []Peer
	modTime    time.Time
	size       int64
	badMod     time.Time // mtime of the last rejected edit, so it is logged once
	unreadable bool
	lastStat   time.Time
	minCheck   time.Duration
}

func NewPeerSource(path string, log *slog.Logger) (*PeerSource, error) {
	s := &PeerSource{path: path, log: log, minCheck: time.Second}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("peers file: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("peers file: %w", err)
	}
	peers, err := ParsePeers(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	s.peers, s.modTime, s.size = peers, info.ModTime(), info.Size()
	return s, nil
}

// Peers returns a copy of the current list, reloading the file if it changed.
func (s *PeerSource) Peers() []Peer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now := time.Now(); now.Sub(s.lastStat) >= s.minCheck {
		s.lastStat = now
		s.reloadLocked()
	}
	return append([]Peer(nil), s.peers...)
}

// Lookup returns the peer with this id from the current list.
func (s *PeerSource) Lookup(id string) (Peer, bool) {
	for _, p := range s.Peers() {
		if p.ID == id {
			return p, true
		}
	}
	return Peer{}, false
}

func (s *PeerSource) reloadLocked() {
	info, err := os.Stat(s.path)
	if err != nil {
		if !s.unreadable {
			s.log.Error("peers file unreadable; keeping previous list", "path", s.path, "err", err)
			s.unreadable = true
		}
		return
	}
	s.unreadable = false
	if info.ModTime().Equal(s.modTime) && info.Size() == s.size {
		return
	}
	if info.ModTime().Equal(s.badMod) {
		return
	}
	data, err := os.ReadFile(s.path)
	if err == nil {
		var peers []Peer
		if peers, err = ParsePeers(data); err == nil {
			s.peers, s.modTime, s.size, s.badMod = peers, info.ModTime(), info.Size(), time.Time{}
			s.log.Info("peers file reloaded", "path", s.path, "peers", len(peers))
			return
		}
	}
	s.badMod = info.ModTime()
	s.log.Error("invalid peers file edit; keeping previous list", "path", s.path, "err", err)
}

// RunDefaults are the values applied to fields a run request omits. They
// mirror the `defaults` section of the shared node config.
type RunDefaults struct {
	Replications   int     `yaml:"replications" json:"replications"`
	Lambda         float64 `yaml:"lambda" json:"lambda"`
	Mu             float64 `yaml:"mu" json:"mu"`
	SimTime        float64 `yaml:"sim_time" json:"sim_time"`
	WarmupTime     float64 `yaml:"warmup_time" json:"warmup_time"`
	TolerancePct   float64 `yaml:"tolerance_pct" json:"tolerance_pct"`
	SerialBaseline bool    `yaml:"serial_baseline" json:"serial_baseline"`
}

// BuiltinDefaults match the node's built-in defaults (node/internal/config).
func BuiltinDefaults() RunDefaults {
	return RunDefaults{Replications: 100, Lambda: 0.8, Mu: 1.0, SimTime: 10000, WarmupTime: 1000, TolerancePct: 10}
}

// LoadDefaults reads the `defaults` section of the node config at path,
// layered over the built-in defaults. A missing file yields the built-ins.
func LoadDefaults(path string) (RunDefaults, error) {
	d := BuiltinDefaults()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return d, nil
	}
	if err != nil {
		return d, fmt.Errorf("node config: %w", err)
	}
	var file struct {
		Defaults RunDefaults `yaml:"defaults"`
	}
	file.Defaults = d
	if err := yaml.Unmarshal(data, &file); err != nil {
		return d, fmt.Errorf("node config %s: %w", path, err)
	}
	d = file.Defaults
	if d.Replications < 2 || !(d.Lambda > 0) || !(d.Mu > d.Lambda) || !(d.SimTime > d.WarmupTime) ||
		d.WarmupTime < 0 || !(d.TolerancePct > 0) || math.IsInf(d.Mu, 0) || math.IsInf(d.SimTime, 0) {
		return BuiltinDefaults(), fmt.Errorf("node config %s: invalid defaults %+v", path, d)
	}
	return d, nil
}
