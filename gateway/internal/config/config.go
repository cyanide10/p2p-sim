// Package config loads the gateway's settings, the peer list it probes, and
// the run defaults it applies to omitted POST /api/runs fields.
//
// The gateway reads its own peers file because it runs on the host and needs
// host-reachable URLs; the ids must match the nodes' NODE_IDs. Everything is
// read once at startup.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Settings struct {
	Listen         string
	PeersPath      string
	NodeConfigPath string
	RequestTimeout time.Duration
	LogLevel       string
}

// LoadSettings reads GATEWAY_LISTEN, PEERS_CONFIG, NODE_CONFIG,
// NODE_REQUEST_TIMEOUT and LOG_LEVEL through getenv, falling back to defaults.
func LoadSettings(getenv func(string) string) (Settings, error) {
	s := Settings{
		Listen:         "127.0.0.1:8090",
		PeersPath:      "config/peers.gateway.yaml",
		NodeConfigPath: "config/node.yaml",
		RequestTimeout: 5 * time.Second,
		LogLevel:       "info",
	}
	for key, dst := range map[string]*string{
		"GATEWAY_LISTEN": &s.Listen,
		"PEERS_CONFIG":   &s.PeersPath,
		"NODE_CONFIG":    &s.NodeConfigPath,
		"LOG_LEVEL":      &s.LogLevel,
	} {
		if v := getenv(key); v != "" {
			*dst = v
		}
	}
	if v := getenv("NODE_REQUEST_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return s, fmt.Errorf("invalid NODE_REQUEST_TIMEOUT %q: must be a positive duration", v)
		}
		s.RequestTimeout = d
	}
	return s, nil
}

// Peer is one node the gateway can reach.
type Peer struct {
	ID  string `yaml:"id" json:"id"`
	URL string `yaml:"url" json:"url"`
}

func LoadPeers(path string) ([]Peer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read peer list: %w", err)
	}
	peers, err := ParsePeers(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return peers, nil
}

// ParsePeers applies the same rules as the nodes: non-empty unique ids and
// unique absolute http(s) URLs.
func ParsePeers(data []byte) ([]Peer, error) {
	var f struct {
		Peers []Peer `yaml:"peers"`
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("parse peer list: %w", err)
	}
	if len(f.Peers) == 0 {
		return nil, errors.New("peer list is empty")
	}
	ids, urls := map[string]bool{}, map[string]bool{}
	for i := range f.Peers {
		p := &f.Peers[i]
		p.ID = strings.TrimSpace(p.ID)
		p.URL = strings.TrimRight(strings.TrimSpace(p.URL), "/")
		if p.ID == "" {
			return nil, fmt.Errorf("peer #%d: id is required", i+1)
		}
		u, err := url.Parse(p.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("peer %q: url must be an absolute http(s) URL, got %q", p.ID, p.URL)
		}
		if ids[p.ID] {
			return nil, fmt.Errorf("duplicate peer id %q", p.ID)
		}
		if urls[p.URL] {
			return nil, fmt.Errorf("duplicate peer url %q", p.URL)
		}
		ids[p.ID], urls[p.URL] = true, true
	}
	return f.Peers, nil
}

// Defaults fill omitted run fields. There is deliberately no base seed: when
// the client omits it, the coordinating node chooses one.
type Defaults struct {
	Replications   int     `yaml:"replications" json:"replications"`
	Lambda         float64 `yaml:"lambda" json:"lambda"`
	Mu             float64 `yaml:"mu" json:"mu"`
	SimTime        float64 `yaml:"sim_time" json:"sim_time"`
	WarmupTime     float64 `yaml:"warmup_time" json:"warmup_time"`
	TolerancePct   float64 `yaml:"tolerance_pct" json:"tolerance_pct"`
	SerialBaseline bool    `yaml:"serial_baseline" json:"serial_baseline"`
}

// BuiltinDefaults equal the values in the repository's config/node.yaml.
func BuiltinDefaults() Defaults {
	return Defaults{
		Replications:   100,
		Lambda:         0.8,
		Mu:             1.0,
		SimTime:        10000,
		WarmupTime:     1000,
		TolerancePct:   10,
		SerialBaseline: true,
	}
}

// LoadDefaults reads only the defaults block of a node config file. Fields
// the file omits keep their built-in values; a missing file yields the
// built-ins.
func LoadDefaults(path string) (Defaults, error) {
	d := BuiltinDefaults()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return d, nil
	}
	if err != nil {
		return d, fmt.Errorf("read node config: %w", err)
	}
	f := struct {
		Defaults *Defaults `yaml:"defaults"`
	}{Defaults: &d}
	if err := yaml.Unmarshal(data, &f); err != nil {
		return d, fmt.Errorf("parse %s: %w", path, err)
	}
	return d, nil
}
