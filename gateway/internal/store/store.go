// Package store persists run history in SQLite (pure Go driver, no CGO).
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned for an unknown run ID.
var ErrNotFound = errors.New("run not found")

// Run states. "complete" is the node's orchestration state, not the
// statistical verdict, which lives in the report.
const (
	StateRunning         = "running"
	StateComplete        = "complete"
	StateCoordinatorLost = "coordinator_lost"
	StateUnknown         = "unknown"
)

// Params are the fully resolved run parameters.
type Params struct {
	Replications   int     `json:"replications"`
	Lambda         float64 `json:"lambda"`
	Mu             float64 `json:"mu"`
	SimTime        float64 `json:"sim_time"`
	WarmupTime     float64 `json:"warmup_time"`
	TolerancePct   float64 `json:"tolerance_pct"`
	BaseSeed       int64   `json:"base_seed"`
	SerialBaseline bool    `json:"serial_baseline"`
	// Kind is "network" for network-scenario runs (empty for M/M/1); their
	// topology and traffic are in Scenario and the M/M/1 fields are unused.
	Kind     string          `json:"kind,omitempty"`
	Scenario json.RawMessage `json:"scenario,omitempty"`
}

type Run struct {
	RunID       string          `json:"run_id"`
	BatchID     string          `json:"batch_id"`
	Coordinator string          `json:"coordinator"`
	CreatedAt   time.Time       `json:"created_at"`
	Params      Params          `json:"params"`
	State       string          `json:"state"`
	Status      json.RawMessage `json:"status"` // latest node status snapshot, or null
	Report      json.RawMessage `json:"report"` // final node report, or null
}

type Store struct {
	db *sql.DB
}

// migrations[i] upgrades the schema from version i to i+1.
var migrations = []string{
	`CREATE TABLE runs (
		run_id      TEXT PRIMARY KEY,
		batch_id    TEXT NOT NULL,
		coordinator TEXT NOT NULL,
		created_at  TEXT NOT NULL,
		params      TEXT NOT NULL,
		state       TEXT NOT NULL,
		status      TEXT,
		report      TEXT,
		updated_at  TEXT NOT NULL
	);
	CREATE INDEX runs_created_at ON runs (created_at);
	CREATE INDEX runs_state ON runs (state);`,
}

// Open opens (creating if needed) the database at path. ":memory:" is
// accepted for tests.
func Open(path string) (*Store, error) {
	dsn := ":memory:"
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
		dsn = "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: SQLite has a single writer, and :memory: is per connection.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	var version int
	err := s.db.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO schema_version (version) VALUES (0)`); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if version > len(migrations) {
		return fmt.Errorf("database schema version %d is newer than this gateway (%d)", version, len(migrations))
	}
	for v := version; v < len(migrations); v++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[v]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", v+1, err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE schema_version SET version = ?`, v+1); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", v+1, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Version returns the current schema version.
func (s *Store) Version(ctx context.Context) (int, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `SELECT version FROM schema_version`).Scan(&v)
	return v, err
}

const timeLayout = "2006-01-02T15:04:05.000000000Z07:00" // fixed width, so text order is time order

func (s *Store) Insert(ctx context.Context, r Run) error {
	params, err := json.Marshal(r.Params)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO runs (run_id, batch_id, coordinator, created_at, params, state, status, report, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.RunID, r.BatchID, r.Coordinator, r.CreatedAt.UTC().Format(timeLayout), string(params), r.State,
		nullJSON(r.Status), nullJSON(r.Report), time.Now().UTC().Format(timeLayout))
	return err
}

// Update sets the state and, when non-nil, the status snapshot and report.
func (s *Store) Update(ctx context.Context, runID, state string, status, report json.RawMessage) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE runs SET state = ?, status = COALESCE(?, status), report = COALESCE(?, report), updated_at = ?
		 WHERE run_id = ?`,
		state, nullJSON(status), nullJSON(report), time.Now().UTC().Format(timeLayout), runID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) Get(ctx context.Context, runID string) (Run, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+columns+` FROM runs WHERE run_id = ?`, runID)
	r, err := scan(row)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}

// List returns runs newest first, plus the total count.
func (s *Store) List(ctx context.Context, limit, offset int) ([]Run, int, error) {
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+columns+` FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	runs := []Run{}
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, 0, err
		}
		runs = append(runs, r)
	}
	return runs, total, rows.Err()
}

// ListByState returns every run in this state, oldest first.
func (s *Store) ListByState(ctx context.Context, state string) ([]Run, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+columns+` FROM runs WHERE state = ? ORDER BY created_at, rowid`, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []Run
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, r)
	}
	return runs, rows.Err()
}

// Prune deletes the oldest runs beyond keep and returns how many it removed.
func (s *Store) Prune(ctx context.Context, keep int) (int, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM runs WHERE run_id IN (
			SELECT run_id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`, keep)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

const columns = `run_id, batch_id, coordinator, created_at, params, state, status, report`

type scanner interface{ Scan(dest ...any) error }

func scan(row scanner) (Run, error) {
	var r Run
	var created, params string
	var status, report sql.NullString
	if err := row.Scan(&r.RunID, &r.BatchID, &r.Coordinator, &created, &params, &r.State, &status, &report); err != nil {
		return r, err
	}
	t, err := time.Parse(timeLayout, created)
	if err != nil {
		return r, fmt.Errorf("run %s: bad created_at: %w", r.RunID, err)
	}
	r.CreatedAt = t
	if err := json.Unmarshal([]byte(params), &r.Params); err != nil {
		return r, fmt.Errorf("run %s: bad params: %w", r.RunID, err)
	}
	if status.Valid {
		r.Status = json.RawMessage(status.String)
	}
	if report.Valid {
		r.Report = json.RawMessage(report.String)
	}
	return r, nil
}

func nullJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}
