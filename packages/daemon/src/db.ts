import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import {
  parseEventData,
  serializeEventData,
} from "@showrunner/core";
import type { EventRow, EventType } from "@showrunner/core";

/**
 * The SQLite layer (spec §4). One single-writer connection owned by the daemon;
 * readers (CLI, UI, tail) open separate read-only connections or go through the
 * daemon's HTTP API. Every event row is validated against the core event
 * schemas (§6) before insert - zod is the single source of truth.
 */

export const SCHEMA_VERSION = 1;

/**
 * v1 — the seven tables (spec §4.2), plus the cursor index. `events.id` is
 * INTEGER PRIMARY KEY AUTOINCREMENT, which SQLite aliases to rowid — the
 * cursor contract (§4.3) is an index scan on (run_id, id).
 */
const MIGRATIONS: string[] = [
  `
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  blueprint     TEXT NOT NULL,
  status        TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  needs_review  INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE phases (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  name          TEXT NOT NULL,
  agent         TEXT NOT NULL,
  status        TEXT NOT NULL,
  visits        INTEGER NOT NULL DEFAULT 0,
  corrections   INTEGER NOT NULL DEFAULT 0,
  budget        INTEGER NOT NULL,
  spend_usd     REAL NOT NULL DEFAULT 0,
  started_at    TEXT,
  ended_at      TEXT
);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT REFERENCES phases(id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  type          TEXT NOT NULL,
  ts            TEXT NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX idx_events_run_rowid ON events(run_id, id);

CREATE TABLE envelopes (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT NOT NULL REFERENCES phases(id),
  visit         INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,
  json          TEXT NOT NULL,
  source        TEXT NOT NULL,
  validated_at  TEXT NOT NULL
);

CREATE TABLE gate_results (
  id            TEXT PRIMARY KEY,
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id),
  gate          TEXT NOT NULL,
  pass          INTEGER NOT NULL,
  violations    TEXT NOT NULL DEFAULT '[]',
  ran_at        TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT NOT NULL REFERENCES phases(id),
  pi_session_id TEXT NOT NULL,
  visit         INTEGER NOT NULL,
  pid           INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE processes (
  id            TEXT PRIMARY KEY,
  pid           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  started_at    TEXT NOT NULL
);
`,
];

/** Open (creating if needed) and migrate the DB, with the §4.1 pragmas. */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Apply migrations not yet applied, tracked by PRAGMA user_version. */
export function migrate(db: Database): void {
  const { user_version: version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN;");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1};`);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }
}

// ── row shapes ───────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  blueprint: string;
  status: string;
  cwd: string;
  needs_review: number;
  started_at: string;
  ended_at: string | null;
}

export interface RunWithSpend extends RunRow {
  spend_usd: number;
}

export interface PhaseRow {
  id: string;
  run_id: string;
  name: string;
  agent: string;
  status: string;
  visits: number;
  corrections: number;
  budget: number;
  spend_usd: number;
  started_at: string | null;
  ended_at: string | null;
}

export interface EnvelopeRow {
  id: string;
  run_id: string;
  phase_id: string;
  visit: number;
  attempt: number;
  json: string;
  source: string;
  validated_at: string;
}

export interface GateResultRow {
  id: string;
  envelope_id: string;
  gate: string;
  pass: number;
  violations: string;
  ran_at: string;
}

export interface AgentSessionRow {
  id: string;
  run_id: string;
  phase_id: string;
  pi_session_id: string;
  visit: number;
  pid: number;
  started_at: string;
  ended_at: string | null;
}

export interface ProcessRow {
  id: string;
  pid: number;
  kind: string;
  started_at: string;
}

type Row = Record<string, unknown>;

// bun:sqlite's query() accepts any return shape; the constraint is only that
// rows are objects.
function q<T>(db: Database, sql: string) {
  return db.query<T, SQLQueryBindings[]>(sql);
}

// ── runs ─────────────────────────────────────────────────────────────────────

export function insertRun(db: Database, r: RunRow): void {
  q(db, "INSERT INTO runs (id, blueprint, status, cwd, needs_review, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    r.id, r.blueprint, r.status, r.cwd, r.needs_review, r.started_at, r.ended_at,
  );
}

export function updateRun(db: Database, id: string, patch: Partial<RunRow>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  q(db, `UPDATE runs SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLQueryBindings), id);
}

export function getRun(db: Database, id: string): RunRow | null {
  return q<RunRow>(db, "SELECT * FROM runs WHERE id = ?").get(id) ?? null;
}

export function listRuns(db: Database): RunWithSpend[] {
  return q<RunWithSpend>(
    db,
    `SELECT r.*, COALESCE(SUM(p.spend_usd), 0) AS spend_usd
     FROM runs r LEFT JOIN phases p ON p.run_id = r.id
     GROUP BY r.id ORDER BY r.started_at DESC`,
  ).all();
}

// ── phases ───────────────────────────────────────────────────────────────────

export function insertPhase(db: Database, p: PhaseRow): void {
  q(
    db,
    "INSERT INTO phases (id, run_id, name, agent, status, visits, corrections, budget, spend_usd, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(p.id, p.run_id, p.name, p.agent, p.status, p.visits, p.corrections, p.budget, p.spend_usd, p.started_at, p.ended_at);
}

export function updatePhase(db: Database, id: string, patch: Partial<PhaseRow>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  q(db, `UPDATE phases SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLQueryBindings), id);
}

export function listPhases(db: Database, runId: string): PhaseRow[] {
  return q<PhaseRow>(db, "SELECT * FROM phases WHERE run_id = ? ORDER BY started_at").all(runId);
}

export function sumRunSpend(db: Database, runId: string): number {
  const row = q<{ s: number | null }>(
    db,
    "SELECT SUM(spend_usd) AS s FROM phases WHERE run_id = ?",
  ).get(runId);
  return row?.s ?? 0;
}

// ── events (the cursor contract, §4.3) ───────────────────────────────────────

export interface NewEvent {
  run_id: string;
  phase_id: string | null;
  agent_session_id: string | null;
  type: EventType;
  ts: string;
  data: unknown;
}

/**
 * Insert one event. The data payload is validated against the core event
 * schema for its type before it is serialized - a tracer bug is loud, not
 * silently stored.
 */
export function insertEvent(db: Database, e: NewEvent): number {
  const validated = parseEventData(e.type, e.data);
  const res = q(
    db,
    "INSERT INTO events (run_id, phase_id, agent_session_id, type, ts, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(e.run_id, e.phase_id, e.agent_session_id, e.type, e.ts, serializeEventData(validated));
  return Number(res.lastInsertRowid);
}

/**
 * The one cursor query that is the entire read transport (spec §2.3, §4.3):
 *
 *   select * from events where run_id = ? and rowid > ? order by rowid limit 500;
 *
 * `id` IS the rowid (INTEGER PRIMARY KEY AUTOINCREMENT), so the (run_id, id)
 * index serves it.
 */
export const CURSOR_SQL =
  "SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?";

function rowToEvent(row: Record<string, unknown>): EventRow {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    phase_id: row.phase_id === null ? null : String(row.phase_id),
    agent_session_id: row.agent_session_id === null ? null : String(row.agent_session_id),
    type: String(row.type) as EventType,
    ts: String(row.ts),
    data: JSON.parse(String(row.data)),
  };
}

export function cursorEvents(db: Database, runId: string, afterRowid: number, limit: number): EventRow[] {
  return q<Record<string, unknown>>(db, CURSOR_SQL).all(runId, afterRowid, limit).map(rowToEvent);
}

export function eventCount(db: Database, runId: string): number {
  const row = q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(runId);
  return row?.n ?? 0;
}

// ── envelopes ────────────────────────────────────────────────────────────────

export function insertEnvelope(db: Database, e: EnvelopeRow): void {
  q(
    db,
    "INSERT INTO envelopes (id, run_id, phase_id, visit, attempt, json, source, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(e.id, e.run_id, e.phase_id, e.visit, e.attempt, e.json, e.source, e.validated_at);
}

export function listEnvelopes(db: Database, runId: string, phaseId?: string): EnvelopeRow[] {
  if (phaseId !== undefined) {
    return q<EnvelopeRow>(db, "SELECT * FROM envelopes WHERE run_id = ? AND phase_id = ? ORDER BY validated_at").all(runId, phaseId);
  }
  return q<EnvelopeRow>(db, "SELECT * FROM envelopes WHERE run_id = ? ORDER BY validated_at").all(runId);
}

// ── gate results ─────────────────────────────────────────────────────────────

export function insertGateResult(db: Database, g: GateResultRow): void {
  q(
    db,
    "INSERT INTO gate_results (id, envelope_id, gate, pass, violations, ran_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(g.id, g.envelope_id, g.gate, g.pass, g.violations, g.ran_at);
}

export function listGateResults(db: Database, runId: string, phaseId?: string): GateResultRow[] {
  const sql = phaseId !== undefined
    ? `SELECT gr.* FROM gate_results gr JOIN envelopes e ON e.id = gr.envelope_id WHERE e.run_id = ? AND e.phase_id = ? ORDER BY gr.ran_at`
    : `SELECT gr.* FROM gate_results gr JOIN envelopes e ON e.id = gr.envelope_id WHERE e.run_id = ? ORDER BY gr.ran_at`;
  return (phaseId !== undefined
    ? q<GateResultRow>(db, sql).all(runId, phaseId)
    : q<GateResultRow>(db, sql).all(runId));
}

// ── agent sessions ───────────────────────────────────────────────────────────

export function insertAgentSession(db: Database, s: AgentSessionRow): void {
  q(
    db,
    "INSERT INTO agent_sessions (id, run_id, phase_id, pi_session_id, visit, pid, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(s.id, s.run_id, s.phase_id, s.pi_session_id, s.visit, s.pid, s.started_at, s.ended_at);
}

export function updateAgentSession(db: Database, id: string, patch: Partial<AgentSessionRow>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  q(db, `UPDATE agent_sessions SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLQueryBindings), id);
}

export function listAgentSessions(db: Database, runId: string): AgentSessionRow[] {
  return q<AgentSessionRow>(db, "SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY started_at").all(runId);
}

// ── processes (id -> pid; how a stuck run is found, §8.3) ────────────────────

export function insertProcess(db: Database, p: ProcessRow): void {
  q(db, "INSERT INTO processes (id, pid, kind, started_at) VALUES (?, ?, ?, ?)").run(
    p.id, p.pid, p.kind, p.started_at,
  );
}

export function deleteProcess(db: Database, id: string): void {
  q(db, "DELETE FROM processes WHERE id = ?").run(id);
}

export function listProcesses(db: Database): ProcessRow[] {
  return q<ProcessRow>(db, "SELECT * FROM processes ORDER BY started_at").all();
}

/** List the seven user tables (test helper; sqlite_* internals excluded). */
export function listTables(db: Database): string[] {
  return q<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
    .all()
    .map((r) => r.name);
}
