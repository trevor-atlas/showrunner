import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import {
  parseEventData,
  serializeEventData,
} from "../core/index.ts";
import type { EventRow, EventType } from "../core/index.ts";
import { backfillV3 } from "./backfill-v3.ts";

/**
 * The SQLite layer. One single-writer connection owned by the daemon;
 * readers (CLI, UI, tail) open separate read-only connections or go through the
 * daemon's HTTP API. Every event row is validated against the core event
 * schemas before insert - zod is the single source of truth.
 */

export const SCHEMA_VERSION = 3;

/**
 * v1 — the seven tables, plus the cursor index. `events.id` is
 * INTEGER PRIMARY KEY AUTOINCREMENT, which SQLite aliases to rowid — the
 * cursor contract is an index scan on (run_id, id).
 *
 * v2 (T03, issue #8) — additive only: every envelope attempt is now a row
 * (valid=0 for zod-rejected / unreadable envelopes), each attempt carries the
 * gate violations that rejected it and the correction message issued after it,
 * and gate overrides are audited in their own table — the original
 * gate_results row is KEPT (the audit trail is the point); this table is the
 * "who + why + when" marker hanging off it.
 *
 * v3 — additive only: phase declaration metadata is stored as queryable columns,
 * each phase visit gets its own row, and envelopes can link to that visit row
 * while keeping their existing visit number for compatibility.
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
  // v2 (T03, issue #8): full attempt history + audited gate overrides
  `
ALTER TABLE envelopes ADD COLUMN valid INTEGER NOT NULL DEFAULT 1;
ALTER TABLE envelopes ADD COLUMN violations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE envelopes ADD COLUMN correction TEXT;

CREATE TABLE gate_overrides (
  id             TEXT PRIMARY KEY,
  gate_result_id TEXT NOT NULL REFERENCES gate_results(id),
  run_id         TEXT NOT NULL REFERENCES runs(id),
  envelope_id    TEXT NOT NULL REFERENCES envelopes(id),
  by             TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
`,
  `
CREATE TABLE phase_visits (
  id               TEXT PRIMARY KEY,
  phase_id         TEXT NOT NULL REFERENCES phases(id),
  visit_number     INTEGER NOT NULL,
  cause            TEXT,
  status           TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  agent_session_id TEXT REFERENCES agent_sessions(id)
);

ALTER TABLE phases ADD COLUMN ordinal INTEGER;
ALTER TABLE phases ADD COLUMN agent_model TEXT;
ALTER TABLE phases ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0;
ALTER TABLE phases ADD COLUMN on_fail_to TEXT;
ALTER TABLE phases ADD COLUMN gate_names TEXT NOT NULL DEFAULT '[]';
ALTER TABLE phases ADD COLUMN context_entries TEXT NOT NULL DEFAULT '[]';

ALTER TABLE envelopes ADD COLUMN visit_id TEXT REFERENCES phase_visits(id);
`,
];

/** Open (creating if needed) and migrate the DB, with the pragmas. */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  backfillV3(db); // best-effort v3 synthesis, AFTER migrate commits (never inside the DDL txn)
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
  // v3 declaration metadata (optional so existing insertPhase call sites keep
  // compiling; omitted fields fall back to the schema defaults on insert).
  /** blueprint order of this phase, or null when unranked */
  ordinal?: number | null;
  /** the model the phase's agent runs on, or null when unset */
  agent_model?: string | null;
  /** 1 = the phase's accepted envelope needs manual approval; defaults to 0 */
  require_approval?: number;
  /** the phase name to jump to on failure, or null when none */
  on_fail_to?: string | null;
  /** the declared gate names, JSON array of strings ('[]' when none) */
  gate_names?: string;
  /** the declared context entries, JSON array of strings ('[]' when none) */
  context_entries?: string;
}

/** One phase visit (T?? v3): each attempt at a phase gets its own row, keyed
 * by (phase_id, visit_number). `cause` is why the visit started (null for the
 * first visit), `agent_session_id` links the pi session that ran it. */
export interface PhaseVisitRow {
  id: string;
  phase_id: string;
  visit_number: number;
  cause: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  agent_session_id: string | null;
}

/** A phase row with its estimated (roster-derived) spend attached — the ONE
 * per-phase spend shape the run detail, the spend breakdown, and the timeline
 * all read (the spend events' `estimated` flag is the source, per
 * sumEstimatedPhaseSpend). Rows come back in phases-table order, not the wire
 * shape — the callers pick the fields they expose. */
export type PhaseSpendRow = PhaseRow & { estimated_spend_usd: number };

export interface EnvelopeRow {
  id: string;
  run_id: string;
  phase_id: string;
  visit: number;
  /** 0..budget — corrections issued before this attempt (0 = first attempt of the visit) */
  attempt: number;
  /** the envelope text, verbatim — for a valid attempt it parsed; for an
   * invalid attempt it is the rejected text (or "" when the file was missing) */
  json: string;
  source: string;
  validated_at: string;
  /** 1 = parsed and processed (gates/blocked); 0 = zod-rejected or unreadable */
  valid: number;
  /** gate violations that rejected this attempt, JSON array of strings ('[]' when none) */
  violations: string;
  /** the correction message issued AFTER this attempt; null when none followed
   * (accepted, blocked, or the run stopped) */
  correction: string | null;
  /** v3: the phase_visits row this attempt belongs to, or null when unlinked
   * (optional so existing insertEnvelope call sites keep compiling) */
  visit_id?: string | null;
}

export interface GateResultRow {
  id: string;
  envelope_id: string;
  gate: string;
  pass: number;
  violations: string;
  ran_at: string;
}

/** A FAILED-only gate result (id + gate name) — the override-target set the
 * pause menu and the budget-exhaustion info both read. */
export interface FailedGateRow {
  id: string;
  gate: string;
}

/** A gate result with its override marker — the drill-in badge: the
 * original row is kept, so pass stays 0 and the override is a separate marker. */
export interface GateResultWithOverride extends GateResultRow {
  overridden: number; // 1 when an override marker exists for this gate result
  override_by: string | null;
  override_reason: string | null;
  overridden_at: string | null;
}

export interface GateOverrideRow {
  id: string;
  gate_result_id: string;
  run_id: string;
  envelope_id: string;
  by: string;
  reason: string;
  created_at: string;
}

/** An override joined with its gate result — the run-level audit trail. */
export interface GateOverrideWithGate extends GateOverrideRow {
  gate: string;
  pass: number;
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

/** Per-run phase-extent rollup — the stats endpoint's duration source. One
 * row per run over `runs LEFT JOIN phases GROUP BY r.id`, carrying the run's
 * own id/status/blueprint/started_at/ended_at alongside MIN(phases.started_at)
 * and MAX(phases.ended_at). SQL MIN/MAX skip NULLs, so skipped/pending phases
 * (no started_at/ended_at) drop out naturally — the phase extent is the span
 * of the phases that actually ran. The AVERAGE stays a JS derivation (no SQL
 * AVG, matching the repo-wide "durations are derived" convention). */
export interface RunPhaseExtent {
  id: string;
  status: string;
  blueprint: string;
  started_at: string;
  ended_at: string | null;
  min_phase_started_at: string | null;
  max_phase_ended_at: string | null;
}

export function runPhaseExtents(db: Database): RunPhaseExtent[] {
  return q<RunPhaseExtent>(
    db,
    `SELECT r.id, r.status, r.blueprint, r.started_at, r.ended_at,
       MIN(p.started_at) AS min_phase_started_at,
       MAX(p.ended_at) AS max_phase_ended_at
     FROM runs r LEFT JOIN phases p ON p.run_id = r.id
     GROUP BY r.id ORDER BY r.started_at DESC`,
  ).all();
}

// ── phases ───────────────────────────────────────────────────────────────────

export function insertPhase(db: Database, p: PhaseRow): void {
  q(
    db,
    "INSERT INTO phases (id, run_id, name, agent, status, visits, corrections, budget, spend_usd, started_at, ended_at, ordinal, agent_model, require_approval, on_fail_to, gate_names, context_entries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    p.id, p.run_id, p.name, p.agent, p.status, p.visits, p.corrections, p.budget, p.spend_usd, p.started_at, p.ended_at,
    p.ordinal ?? null,
    p.agent_model ?? null,
    p.require_approval ?? 0,
    p.on_fail_to ?? null,
    p.gate_names ?? "[]",
    p.context_entries ?? "[]",
  );
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

export function getPhaseById(db: Database, id: string): PhaseRow | null {
  return q<PhaseRow>(db, "SELECT * FROM phases WHERE id = ?").get(id) ?? null;
}

// ── phase visits (v3) ──────────────────────────────────────────────────────

export function insertPhaseVisit(db: Database, v: PhaseVisitRow): void {
  q(
    db,
    "INSERT INTO phase_visits (id, phase_id, visit_number, cause, status, started_at, ended_at, agent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(v.id, v.phase_id, v.visit_number, v.cause, v.status, v.started_at, v.ended_at, v.agent_session_id);
}

export function updatePhaseVisit(db: Database, id: string, patch: Partial<PhaseVisitRow>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  q(db, `UPDATE phase_visits SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLQueryBindings), id);
}

/** Every visit of one phase, in visit_number order (the drill-in's visit list). */
export function listPhaseVisits(db: Database, phaseId: string): PhaseVisitRow[] {
  return q<PhaseVisitRow>(db, "SELECT * FROM phase_visits WHERE phase_id = ? ORDER BY visit_number").all(phaseId);
}

/** A phase of a run, looked up by its blueprint NAME (the phase-scoped
 * endpoints use the name — the URL-safe slug the UI carries). */
export function getPhaseByName(db: Database, runId: string, name: string): PhaseRow | null {
  return q<PhaseRow>(db, "SELECT * FROM phases WHERE run_id = ? AND name = ? LIMIT 1").get(runId, name) ?? null;
}

export function sumRunSpend(db: Database, runId: string): number {
  const row = q<{ s: number | null }>(
    db,
    "SELECT SUM(spend_usd) AS s FROM phases WHERE run_id = ?",
  ).get(runId);
  return row?.s ?? 0;
}

/**
 * Estimated (roster-derived) spend per phase, summed from the spend
 * events whose `estimated` flag is set — the show drill-in splits
 * reported vs estimated dollars. Reported spend never lands here: the flag is
 * set only when usd came from the local prices.json.
 */
export function sumEstimatedPhaseSpend(db: Database, runId: string): Map<string, number> {
  const rows = q<{ phase_id: string | null; s: number | null }>(
    db,
    `SELECT phase_id, SUM(CAST(json_extract(data, '$.usd') AS REAL)) AS s
     FROM events
     WHERE run_id = ? AND type = 'spend' AND json_extract(data, '$.estimated') = 1
     GROUP BY phase_id`,
  ).all(runId);
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.phase_id !== null) out.set(r.phase_id, r.s ?? 0);
  }
  return out;
}

/**
 * Per-phase spend-token totals, summed from the spend events' token
 * fields in ONE grouped pass — the spend breakdown's tokens_in /
 * tokens_out / cache_read / cache_write. SQL SUM is exact — the old
 * UI sweep's 100k-event cap and its `truncated` flag die with it.
 * The token field names match the spend event schema (core SpendData):
 * tokens_in, tokens_out, cache_read, cache_write. Phases with no spend
 * events are absent from the map; callers read `?? 0`.
 */
export function sumSpendTokenTotals(
  db: Database,
  runId: string,
): Map<string, { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }> {
  const rows = q<{
    phase_id: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cache_read: number | null;
    cache_write: number | null;
  }>(
    db,
    `SELECT phase_id,
       SUM(CAST(json_extract(data, '$.tokens_in') AS REAL)) AS tokens_in,
       SUM(CAST(json_extract(data, '$.tokens_out') AS REAL)) AS tokens_out,
       SUM(CAST(json_extract(data, '$.cache_read') AS REAL)) AS cache_read,
       SUM(CAST(json_extract(data, '$.cache_write') AS REAL)) AS cache_write
     FROM events
     WHERE run_id = ? AND type = 'spend'
     GROUP BY phase_id`,
  ).all(runId);
  const out = new Map<string, { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }>();
  for (const r of rows) {
    if (r.phase_id === null) continue;
    out.set(r.phase_id, {
      tokens_in: r.tokens_in ?? 0,
      tokens_out: r.tokens_out ?? 0,
      cache_read: r.cache_read ?? 0,
      cache_write: r.cache_write ?? 0,
    });
  }
  return out;
}

/** Per-run reported-vs-estimated spend split, summed from the spend EVENTS
 * (not `phases.spend_usd`). The events table is the source because
 * `phases.spend_usd` LAGS after crash recovery: backfill folds spend events
 * only and never calls updatePhase (src/daemon/backfill.ts), so a recovered
 * run's phase rows understate spend while its events do not. Mirrors the
 * sumEstimatedPhaseSpend json_extract pattern: type='spend', usd non-null
 * (usd:null spend events — reported-zero with no roster entry, src/daemon/
 * tracer.ts — are excluded), split on the `estimated` flag. */
export interface RunSpendSplit {
  run_id: string;
  reported_usd: number;
  estimated_usd: number;
}

export function runSpendSplit(db: Database): RunSpendSplit[] {
  return q<RunSpendSplit>(
    db,
    `SELECT run_id,
       SUM(CASE WHEN json_extract(data, '$.estimated') = 1
                THEN 0 ELSE CAST(json_extract(data, '$.usd') AS REAL) END) AS reported_usd,
       SUM(CASE WHEN json_extract(data, '$.estimated') = 1
                THEN CAST(json_extract(data, '$.usd') AS REAL) ELSE 0 END) AS estimated_usd
     FROM events
     WHERE type = 'spend' AND json_extract(data, '$.usd') IS NOT NULL
     GROUP BY run_id`,
  ).all();
}

/** The per-phase spend shape for the three surfaces (run detail, spend
 * breakdown, timeline): the estimated half mapped onto the phases rows.
 * Returned in phases-table order (listPhases' started_at order) — the
 * wire shapes stay the callers' business. */
export function listPhaseSpend(db: Database, runId: string): PhaseSpendRow[] {
  const estimated = sumEstimatedPhaseSpend(db, runId);
  return listPhases(db, runId).map((p) => ({ ...p, estimated_spend_usd: estimated.get(p.id) ?? 0 }));
}

/** Phase counts grouped by status, with the `total` key — the runs-list
 * contract (apiListRuns pins the shape: { total, <status>: n, ... }). */
export function phaseStatusCounts(db: Database, runId: string): Record<string, number> {
  const rows = q<{ status: string; n: number }>(
    db,
    "SELECT status, COUNT(*) AS n FROM phases WHERE run_id = ? GROUP BY status",
  ).all(runId);
  const counts: Record<string, number> = { total: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.n);
    counts["total"] = (counts["total"] ?? 0) + Number(row.n);
  }
  return counts;
}

// ── events (the cursor contract) ───────────────────────────────────────

export interface NewEvent {
  run_id: string;
  phase_id: string | null;
  agent_session_id: string | null;
  type: EventType;
  ts: string;
  data: unknown;
}

/** The single, replaceable post-insert hook (default null). web.ts installs
 * the live bus's `emitRunChange` here; with no hook installed `insertEvent`
 * behaves exactly as before (no behavior change). See src/daemon/live.ts for
 * the chokepoint invariant. */
type EventInsertHook = (runId: string) => void;
let eventInsertHook: EventInsertHook | null = null;

export function setEventInsertHook(fn: EventInsertHook | null): void {
  eventInsertHook = fn;
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
  if (eventInsertHook !== null) eventInsertHook(e.run_id);
  return Number(res.lastInsertRowid);
}

/**
 * The one cursor query that is the entire read transport:
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

/** Sweep the cursor query from the start — a run's full event history in
 * rowid order, batched `batchSize` at a time (the one indexed read
 * transport). The timeline fold's event source; the default batch is the
 * events-page size (500 — server.ts's exported MAX_EVENTS_LIMIT is the
 * same value; db.ts cannot import server.ts, so the literal stays here). */
export function sweepRunEvents(db: Database, runId: string, batchSize = 500): EventRow[] {
  const all: EventRow[] = [];
  let after = 0;
  for (;;) {
    const page = cursorEvents(db, runId, after, batchSize);
    all.push(...page);
    if (page.length < batchSize) break;
    after = page[page.length - 1]!.id;
  }
  return all;
}

export function eventCount(db: Database, runId: string): number {
  const row = q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(runId);
  return row?.n ?? 0;
}

/** Accepted/attempt envelope rows for a run — the detail's envelope count. */
export function envelopeCount(db: Database, runId: string): number {
  const row = q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM envelopes WHERE run_id = ?").get(runId);
  return row?.n ?? 0;
}

// ── envelopes ────────────────────────────────────────────────────────────────

export function insertEnvelope(db: Database, e: EnvelopeRow): void {
  q(
    db,
    "INSERT INTO envelopes (id, run_id, phase_id, visit, attempt, json, source, validated_at, valid, violations, correction, visit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(e.id, e.run_id, e.phase_id, e.visit, e.attempt, e.json, e.source, e.validated_at, e.valid, e.violations, e.correction, e.visit_id ?? null);
}

export function updateEnvelope(db: Database, id: string, patch: Partial<EnvelopeRow>): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  q(db, `UPDATE envelopes SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLQueryBindings), id);
}

export function getEnvelope(db: Database, id: string): EnvelopeRow | null {
  return q<EnvelopeRow>(db, "SELECT * FROM envelopes WHERE id = ?").get(id) ?? null;
}

export function listEnvelopes(db: Database, runId: string, phaseId?: string): EnvelopeRow[] {
  // per-attempt history order: visit, then attempt within the visit (the drill-in's
  // "attempts: 1 ✗ … 2 ✓ …" list)
  if (phaseId !== undefined) {
    return q<EnvelopeRow>(db, "SELECT * FROM envelopes WHERE run_id = ? AND phase_id = ? ORDER BY visit, attempt").all(runId, phaseId);
  }
  return q<EnvelopeRow>(db, "SELECT * FROM envelopes WHERE run_id = ? ORDER BY visit, attempt").all(runId);
}

// ── gate results ─────────────────────────────────────────────────────────────

export function insertGateResult(db: Database, g: GateResultRow): void {
  q(
    db,
    "INSERT INTO gate_results (id, envelope_id, gate, pass, violations, ran_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(g.id, g.envelope_id, g.gate, g.pass, g.violations, g.ran_at);
}

export function getGateResult(db: Database, id: string): GateResultRow | null {
  return q<GateResultRow>(db, "SELECT * FROM gate_results WHERE id = ?").get(id) ?? null;
}

/** Every gate result for a run (or phase), with its override marker. The
 * original row is KEPT on override: pass stays 0 and overridden=1 carries the
 * audit badge. */
export function listGateResults(db: Database, runId: string, phaseId?: string): GateResultWithOverride[] {
  const where =
    phaseId !== undefined
      ? "e.run_id = ? AND e.phase_id = ?"
      : "e.run_id = ?";
  const sql = `SELECT gr.*,
      CASE WHEN go.id IS NULL THEN 0 ELSE 1 END AS overridden,
      go.by AS override_by, go.reason AS override_reason, go.created_at AS overridden_at
    FROM gate_results gr
    JOIN envelopes e ON e.id = gr.envelope_id
    LEFT JOIN gate_overrides go ON go.gate_result_id = gr.id
    WHERE ${where}
    ORDER BY gr.ran_at`;
  const bindings = phaseId !== undefined ? [runId, phaseId] : [runId];
  return q<GateResultWithOverride>(db, sql).all(...bindings);
}

/** The FAILED-only gate results of one envelope (id + gate, in gate_results
 * row order) — the override-target set both the pause menu and the
 * budget-exhaustion pause info read. One shape serves both callers. */
export function listFailedGateResults(db: Database, envelopeId: string): FailedGateRow[] {
  return q<FailedGateRow>(db, "SELECT id, gate FROM gate_results WHERE envelope_id = ? AND pass = 0").all(envelopeId);
}

/** Gate names for the given gate-result ids, in gate_results ROW order
 * (the WHERE id IN (...) scan's natural order), deduped preserving
 * first-seen order — the pause viewer's override_targets. The ids are
 * already the failed-only set, so no pass filter is needed here; the
 * dedup matches the old UI's failedGateNames semantics (the first row
 * of a repeated gate name wins). */
export function listGateNamesByIds(db: Database, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = q<{ id: string; gate: string }>(
    db,
    `SELECT id, gate FROM gate_results WHERE id IN (${placeholders})`,
  ).all(...ids);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    if (seen.has(row.gate)) continue;
    seen.add(row.gate);
    names.push(row.gate);
  }
  return names;
}

// ── gate overrides ────────────────────────────────────────────────────

export function insertGateOverride(db: Database, o: GateOverrideRow): void {
  q(
    db,
    "INSERT INTO gate_overrides (id, gate_result_id, run_id, envelope_id, by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(o.id, o.gate_result_id, o.run_id, o.envelope_id, o.by, o.reason, o.created_at);
}

/** The run-level override audit trail: who + why + when per overridden gate. */
export function listGateOverrides(db: Database, runId: string): GateOverrideWithGate[] {
  return q<GateOverrideWithGate>(
    db,
    `SELECT go.*, gr.gate, gr.pass
     FROM gate_overrides go
     JOIN gate_results gr ON gr.id = go.gate_result_id
     WHERE go.run_id = ?
     ORDER BY go.created_at`,
  ).all(runId);
}

/** Is there an override marker on this gate result (the audit marker hanging
 * off the KEPT original row)? */
export function hasGateOverride(db: Database, gateResultId: string): boolean {
  return q<{ id: string }>(db, "SELECT id FROM gate_overrides WHERE gate_result_id = ?").get(gateResultId) != null;
}

/** Failed gate results of an envelope with NO override marker — the count
 * `isEnvelopeApproved` keys off (approved = zero un-overridden failures). */
export function countUnoverriddenFailedGates(db: Database, envelopeId: string): number {
  const row = q<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n
     FROM gate_results gr
     LEFT JOIN gate_overrides go ON go.gate_result_id = gr.id
     WHERE gr.envelope_id = ? AND gr.pass = 0 AND go.id IS NULL`,
  ).get(envelopeId);
  return row?.n ?? 0;
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

// ── processes (id -> pid; how a stuck run is found) ────────────────────

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

/** Every live child recorded for one run (agent-session rows plus any run-kind
 * rows) — the kill target set for fail / daemon-restart recovery. */
export function listRunProcesses(db: Database, runId: string): ProcessRow[] {
  return q<ProcessRow>(
    db,
    `SELECT p.* FROM processes p
     LEFT JOIN agent_sessions s ON s.id = p.id
     WHERE p.id = ? OR s.run_id = ?`,
  ).all(runId, runId);
}

/** List the user tables (test helper; sqlite_* internals excluded). */
export function listTables(db: Database): string[] {
  return q<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
    .all()
    .map((r) => r.name);
}
