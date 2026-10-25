package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParsePeers(t *testing.T) {
	peers, err := ParsePeers([]byte("peers:\n  - id: node-1\n    url: http://127.0.0.1:8081/\n  - id: node-2\n    url: http://127.0.0.1:8082\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 2 || peers[0].URL != "http://127.0.0.1:8081" || peers[1].ID != "node-2" {
		t.Fatalf("unexpected peers: %+v", peers)
	}
}

func TestParsePeersRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"empty":         "peers: []\n",
		"missing id":    "peers:\n  - url: http://a:1\n",
		"duplicate id":  "peers:\n  - {id: a, url: http://a:1}\n  - {id: a, url: http://b:1}\n",
		"duplicate url": "peers:\n  - {id: a, url: http://a:1}\n  - {id: b, url: http://a:1/}\n",
		"bad scheme":    "peers:\n  - {id: a, url: ftp://a:1}\n",
		"no host":       "peers:\n  - {id: a, url: /relative}\n",
		"unknown field": "peers:\n  - {id: a, url: http://a:1, port: 3}\n",
	}
	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParsePeers([]byte(doc)); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestLoadDefaultsOverlaysBuiltins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.yaml")
	doc := "request_timeout: 30s\ndefaults:\n  replications: 40\n  serial_baseline: false\n"
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDefaults(path)
	if err != nil {
		t.Fatal(err)
	}
	want := BuiltinDefaults()
	want.Replications = 40
	want.SerialBaseline = false
	if d != want {
		t.Fatalf("got %+v, want %+v", d, want)
	}
}

func TestLoadDefaultsMissingFileUsesBuiltins(t *testing.T) {
	d, err := LoadDefaults(filepath.Join(t.TempDir(), "absent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if d != BuiltinDefaults() {
		t.Fatalf("got %+v", d)
	}
}

func TestLoadSettings(t *testing.T) {
	s, err := LoadSettings(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if s.Listen != "127.0.0.1:8090" || s.PeersPath != "config/peers.gateway.yaml" ||
		s.NodeConfigPath != "config/node.yaml" || s.RequestTimeout != 5*time.Second || s.LogLevel != "info" {
		t.Fatalf("unexpected defaults: %+v", s)
	}

	env := map[string]string{"GATEWAY_LISTEN": ":9999", "NODE_REQUEST_TIMEOUT": "750ms"}
	s, err = LoadSettings(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if s.Listen != ":9999" || s.RequestTimeout != 750*time.Millisecond {
		t.Fatalf("overrides not applied: %+v", s)
	}

	_, err = LoadSettings(func(k string) string {
		if k == "NODE_REQUEST_TIMEOUT" {
			return "soon"
		}
		return ""
	})
	if err == nil || !strings.Contains(err.Error(), "NODE_REQUEST_TIMEOUT") {
		t.Fatalf("expected a duration error, got %v", err)
	}
}
