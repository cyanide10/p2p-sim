package config

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const validPeers = `peers:
  - id: node-1
    url: http://node-1:8000/
  - id: node-2
    url: http://node-2:8000
`

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestParsePeers(t *testing.T) {
	peers, err := ParsePeers([]byte(validPeers))
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 2 || peers[0].URL != "http://node-1:8000" {
		t.Fatalf("got %+v; want 2 peers with trailing slash trimmed", peers)
	}
	bad := map[string]string{
		"duplicate id": "peers:\n  - {id: a, url: http://a}\n  - {id: a, url: http://b}\n",
		"bad scheme":   "peers:\n  - {id: a, url: ftp://a}\n",
		"relative url": "peers:\n  - {id: a, url: node-1:8000}\n",
		"empty id":     "peers:\n  - {id: '', url: http://a}\n",
		"empty list":   "peers: []\n",
		"unknown key":  "peers:\n  - {id: a, url: http://a, port: 1}\n",
	}
	for name, input := range bad {
		if _, err := ParsePeers([]byte(input)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestPeerSourceReloadsAndKeepsPreviousOnBadEdit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.yaml")
	write := func(content string, mtime time.Time) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Now().Add(-time.Hour)
	write(validPeers, base)
	src, err := NewPeerSource(path, quietLog())
	if err != nil {
		t.Fatal(err)
	}
	src.minCheck = 0

	write(validPeers+"  - id: node-3\n    url: http://node-3:8000\n", base.Add(time.Minute))
	if got := len(src.Peers()); got != 3 {
		t.Fatalf("after valid edit: %d peers, want 3", got)
	}
	write("peers:\n  - {id: x, url: not a url}\n", base.Add(2*time.Minute))
	if got := len(src.Peers()); got != 3 {
		t.Fatalf("after invalid edit: %d peers, want the previous 3", got)
	}
	if _, ok := src.Lookup("node-3"); !ok {
		t.Fatal("Lookup(node-3) failed")
	}
}

func TestNewPeerSourceRejectsInvalidFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.yaml")
	os.WriteFile(path, []byte("peers: []\n"), 0o600)
	if _, err := NewPeerSource(path, quietLog()); err == nil {
		t.Fatal("expected an error for an empty peer list")
	}
}

func TestLoadDefaults(t *testing.T) {
	d, err := LoadDefaults(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil || d != BuiltinDefaults() {
		t.Fatalf("missing file: got %+v, %v; want built-ins", d, err)
	}
	path := filepath.Join(t.TempDir(), "node.yaml")
	os.WriteFile(path, []byte("listen_addr: ':8000'\ndefaults:\n  replications: 50\n  serial_baseline: true\n"), 0o600)
	d, err = LoadDefaults(path)
	if err != nil || d.Replications != 50 || !d.SerialBaseline || d.Lambda != 0.8 {
		t.Fatalf("got %+v, %v; want replications 50 layered over built-ins", d, err)
	}
	os.WriteFile(path, []byte("defaults:\n  lambda: 2\n  mu: 1\n"), 0o600)
	if _, err := LoadDefaults(path); err == nil {
		t.Fatal("expected an error for unstable defaults")
	}
}

func TestLoadSettings(t *testing.T) {
	env := map[string]string{"GATEWAY_LISTEN": ":9000", "NODE_REQUEST_TIMEOUT": "2s", "HISTORY_LIMIT": "7", "LOG_LEVEL": "debug"}
	s, err := LoadSettings(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if s.Listen != ":9000" || s.NodeTimeout != 2*time.Second || s.HistoryLimit != 7 || s.LogLevel != slog.LevelDebug {
		t.Fatalf("unexpected settings %+v", s)
	}
	env = map[string]string{"HISTORY_LIMIT": "0", "NODE_REQUEST_TIMEOUT": "soon"}
	_, err = LoadSettings(func(k string) string { return env[k] })
	if err == nil || !strings.Contains(err.Error(), "HISTORY_LIMIT") || !strings.Contains(err.Error(), "NODE_REQUEST_TIMEOUT") {
		t.Fatalf("got %v; want errors for both bad values", err)
	}
}
