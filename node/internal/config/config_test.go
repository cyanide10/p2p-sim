package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func noEnv(string) string { return "" }

func TestDefaultsAreValid(t *testing.T) {
	cfg, err := Load("", noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg != Default() {
		t.Fatalf("got %+v", cfg)
	}
}

func TestFileAndEnvOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.yaml")
	doc := "request_timeout: 12s\nsim_timeout: 10s\nmax_attempts: 5\ndefaults:\n  lambda: 0.5\n  serial_baseline: true\n"
	if err := os.WriteFile(path, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"MAX_ATTEMPTS": "4", "HEALTH_TIMEOUT": "750ms"}
	cfg, err := Load(path, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RequestTimeout != 12*time.Second {
		t.Errorf("request_timeout = %v", cfg.RequestTimeout)
	}
	if cfg.MaxAttempts != 4 {
		t.Errorf("env should override file: max_attempts = %d", cfg.MaxAttempts)
	}
	if cfg.HealthTimeout != 750*time.Millisecond {
		t.Errorf("health_timeout = %v", cfg.HealthTimeout)
	}
	if cfg.Defaults.Lambda != 0.5 || !cfg.Defaults.SerialBaseline || cfg.Defaults.Mu != 1.0 {
		t.Errorf("defaults = %+v (unset fields must keep built-in values)", cfg.Defaults)
	}
}

func TestInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.yaml")
	for _, doc := range []string{"max_attempts: 0\n", "bogus: 1\n", "request_timeout: soon\n"} {
		_ = os.WriteFile(path, []byte(doc), 0o644)
		if _, err := Load(path, noEnv); err == nil {
			t.Errorf("expected error for %q", doc)
		}
	}
	if _, err := Load("", func(k string) string {
		if k == "REQUEST_TIMEOUT" {
			return "nope"
		}
		return ""
	}); err == nil {
		t.Error("expected error for bad env duration")
	}
}

func TestRepoConfig(t *testing.T) {
	path := filepath.Join("..", "..", "..", "config", "node.yaml")
	if _, err := os.Stat(path); err != nil {
		t.Skip("config/node.yaml not found")
	}
	if _, err := Load(path, noEnv); err != nil {
		t.Fatal(err)
	}
}

func TestSimTimeoutMustBeBelowRequestTimeout(t *testing.T) {
	env := map[string]string{"SIM_TIMEOUT": "30s", "REQUEST_TIMEOUT": "30s"}
	if _, err := Load("", func(k string) string { return env[k] }); err == nil {
		t.Fatal("sim_timeout >= request_timeout should be rejected")
	}
}
