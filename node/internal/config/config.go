// Package config holds node settings: coordination timeouts and retry policy,
// task-execution limits, and the default simulation parameters applied to
// fields omitted from POST /run. The same file is shared by every node;
// per-node identity comes from NODE_ID, not from here.
//
// Values come from built-in defaults, overridden by an optional YAML file
// (NODE_CONFIG), overridden by individual environment variables.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	ListenAddr string `yaml:"listen_addr"`

	// Coordinating a batch.
	RequestTimeout time.Duration `yaml:"request_timeout"` // per node→node POST /task
	HealthTimeout  time.Duration `yaml:"health_timeout"`  // per GET /health probe
	MaxAttempts    int           `yaml:"max_attempts"`    // total tries per task before it is marked failed
	BackoffInitial time.Duration `yaml:"backoff_initial"` // first pause after a node failure
	BackoffMax     time.Duration `yaml:"backoff_max"`     // cap for exponential backoff
	PhaseTimeout   time.Duration `yaml:"phase_timeout"`   // upper bound for one dispatch phase of a batch

	// Executing tasks.
	SimTimeout         time.Duration `yaml:"sim_timeout"`          // per-subprocess limit; must be < request_timeout
	MaxConcurrentTasks int           `yaml:"max_concurrent_tasks"` // simulations this node runs at once
	PythonBin          string        `yaml:"python_bin"`
	SimScript          string        `yaml:"sim_script"`

	Defaults RunDefaults `yaml:"defaults"`
}

// RunDefaults fill in any field a POST /run request leaves out.
type RunDefaults struct {
	Replications   int     `yaml:"replications"`
	Lambda         float64 `yaml:"lambda"`
	Mu             float64 `yaml:"mu"`
	SimTime        float64 `yaml:"sim_time"`
	WarmupTime     float64 `yaml:"warmup_time"`
	TolerancePct   float64 `yaml:"tolerance_pct"`
	SerialBaseline bool    `yaml:"serial_baseline"`
}

// Default returns the built-in configuration.
func Default() Config {
	return Config{
		ListenAddr:         ":8000",
		RequestTimeout:     30 * time.Second,
		HealthTimeout:      2 * time.Second,
		MaxAttempts:        3,
		BackoffInitial:     500 * time.Millisecond,
		BackoffMax:         10 * time.Second,
		PhaseTimeout:       time.Hour,
		SimTimeout:         25 * time.Second,
		MaxConcurrentTasks: 2,
		PythonBin:          "python3",
		SimScript:          "/app/sim/simulate.py",
		Defaults: RunDefaults{
			Replications: 100,
			Lambda:       0.8,
			Mu:           1.0,
			SimTime:      10000,
			WarmupTime:   1000,
			TolerancePct: 10,
		},
	}
}

// Load builds the configuration from defaults, the YAML file at path (skipped
// when path is empty) and environment variables read through getenv.
func Load(path string, getenv func(string) string) (Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return cfg, fmt.Errorf("read node config: %w", err)
		}
		dec := yaml.NewDecoder(bytes.NewReader(data))
		dec.KnownFields(true)
		if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
			return cfg, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	if err := cfg.applyEnv(getenv); err != nil {
		return cfg, err
	}
	return cfg, cfg.Validate()
}

func (c *Config) applyEnv(getenv func(string) string) error {
	strs := map[string]*string{
		"LISTEN_ADDR": &c.ListenAddr,
		"PYTHON_BIN":  &c.PythonBin,
		"SIM_SCRIPT":  &c.SimScript,
	}
	for key, dst := range strs {
		if v := getenv(key); v != "" {
			*dst = v
		}
	}
	durations := map[string]*time.Duration{
		"REQUEST_TIMEOUT": &c.RequestTimeout,
		"HEALTH_TIMEOUT":  &c.HealthTimeout,
		"BACKOFF_INITIAL": &c.BackoffInitial,
		"BACKOFF_MAX":     &c.BackoffMax,
		"PHASE_TIMEOUT":   &c.PhaseTimeout,
		"SIM_TIMEOUT":     &c.SimTimeout,
	}
	for key, dst := range durations {
		if v := getenv(key); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil {
				return fmt.Errorf("invalid %s: %w", key, err)
			}
			*dst = d
		}
	}
	ints := map[string]*int{
		"MAX_ATTEMPTS":         &c.MaxAttempts,
		"MAX_CONCURRENT_TASKS": &c.MaxConcurrentTasks,
	}
	for key, dst := range ints {
		if v := getenv(key); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return fmt.Errorf("invalid %s: %w", key, err)
			}
			*dst = n
		}
	}
	return nil
}

// Validate checks that settings are usable. Simulation defaults are validated
// per request, where they are combined with the request body.
func (c Config) Validate() error {
	switch {
	case c.ListenAddr == "":
		return errors.New("listen_addr must not be empty")
	case c.RequestTimeout <= 0, c.HealthTimeout <= 0, c.PhaseTimeout <= 0:
		return errors.New("request_timeout, health_timeout and phase_timeout must be > 0")
	case c.MaxAttempts < 1:
		return errors.New("max_attempts must be >= 1")
	case c.BackoffInitial <= 0 || c.BackoffMax < c.BackoffInitial:
		return errors.New("backoff_initial must be > 0 and <= backoff_max")
	case c.SimTimeout <= 0 || c.SimTimeout >= c.RequestTimeout:
		// The executing node must give up before the coordinating node does,
		// so failures come back as clean errors rather than timeouts.
		return errors.New("sim_timeout must be > 0 and < request_timeout")
	case c.MaxConcurrentTasks < 1:
		return errors.New("max_concurrent_tasks must be >= 1")
	case c.PythonBin == "" || c.SimScript == "":
		return errors.New("python_bin and sim_script must not be empty")
	}
	return nil
}
