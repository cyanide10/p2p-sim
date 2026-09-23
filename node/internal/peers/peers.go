// Package peers loads the coordinator's static peer list. There is no
// discovery: the set of peers is fixed at startup by config/peers.yaml, and
// adding a peer is purely a configuration change.
package peers

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Peer is one worker node reachable over HTTP.
type Peer struct {
	ID  string `yaml:"id" json:"id"`
	URL string `yaml:"url" json:"url"`
}

type file struct {
	Peers []Peer `yaml:"peers"`
}

// Load reads and validates a peers YAML file.
func Load(path string) ([]Peer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read peer list: %w", err)
	}
	list, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return list, nil
}

// Parse decodes and validates peer list YAML.
func Parse(data []byte) ([]Peer, error) {
	var f file
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("parse peer list: %w", err)
	}
	if len(f.Peers) == 0 {
		return nil, errors.New("peer list is empty")
	}

	ids := make(map[string]bool)
	urls := make(map[string]bool)
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
