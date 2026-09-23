package peers

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	got, err := Parse([]byte(`
peers:
  - id: peer-1
    url: http://peer-1:8000/
  - id: peer-2
    url: http://peer-2:8000
`))
	if err != nil {
		t.Fatal(err)
	}
	want := []Peer{{"peer-1", "http://peer-1:8000"}, {"peer-2", "http://peer-2:8000"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseInvalid(t *testing.T) {
	cases := map[string]string{
		"empty":         ``,
		"no peers":      `peers: []`,
		"missing id":    "peers:\n  - url: http://a:1\n",
		"bad url":       "peers:\n  - id: a\n    url: peer-1:8000\n",
		"duplicate id":  "peers:\n  - id: a\n    url: http://a:1\n  - id: a\n    url: http://b:1\n",
		"duplicate url": "peers:\n  - id: a\n    url: http://a:1\n  - id: b\n    url: http://a:1\n",
		"unknown field": "peers:\n  - id: a\n    url: http://a:1\n    weight: 3\n",
	}
	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(doc)); err == nil {
				t.Fatalf("expected error for %q", doc)
			}
		})
	}
}

// The repository's shipped configs must stay valid.
func TestRepoConfigs(t *testing.T) {
	for file, n := range map[string]int{"peers.yaml": 3, "peers.4.yaml": 4} {
		list, err := Load(filepath.Join("..", "..", "..", "config", file))
		if os.IsNotExist(err) {
			t.Skipf("%s not found", file)
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != n {
			t.Errorf("%s: %d peers, want %d", file, len(list), n)
		}
	}
}
