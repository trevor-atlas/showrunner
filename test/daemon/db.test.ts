import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { CURSOR_SQL, SCHEMA_VERSION, cursorEvents, eventCount, getRun, insertAgentSession, insertEnvelope, insertEvent, insertGateResult, insertPhase, insertProcess, insertRun, listFailedGateResults, listPhaseSpend, listRuns, listTables, openDb, phaseStatusCounts, sumEstimatedPhaseSpend, sumRunSpend, sweepRunEvents } from "../../src/server/repository/db.ts";
import {
  getEnvelope,
  getPhaseById,
  insertPhaseVisit,
  listPhaseVisits,
  updatePhaseVisit,
} from "../../src/server/repository/db.ts";
import type { PhaseVisitRow } from "../../src/server/repository/db.ts";

const tables = [
  "runs",
  "phases",
  "events",
  "envelopes",
  "gate_results",
  "gate_overrides", // v2 (T03): the audited override marker table
  "phase_visits",
  "agent_sessions",
  "processes",
];

function columnNames(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test("migrating a fresh DB creates the v3 schema", () => {
  const dir = tmpDataDir("schema");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    const names = listTables(db);
    for (const t of tables) expect(names).toContain(t);
    expect(names).toHaveLength(tables.length); // exactly these, no extras
    expect(SCHEMA_VERSION).toBe(3);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("v3 migration adds phase declaration columns, phase_visits, and envelope visit links", () => {
  const dir = tmpDataDir("schema-v3");
  try {
    const db = openDb(join(dir, "showrunner.db"));

    expect(columnNames(db, "phase_visits")).toEqual([
      "id",
      "phase_id",
      "visit_number",
      "cause",
      "status",
      "started_at",
      "ended_at",
      "agent_session_id",
    ]);

    const phaseCols = columnNames(db, "phases");
    expect(phaseCols).toContain("ordinal");
    expect(phaseCols).toContain("agent_model");
    expect(phaseCols).toContain("require_approval");
    expect(phaseCols).toContain("on_fail_to");
    expect(phaseCols).toContain("gate_names");
    expect(phaseCols).toContain("context_entries");
    expect(columnNames(db, "envelopes")).toContain("visit_id");

    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/w", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, { id: "p1", run_id: "r1", name: "build", agent: "a", status: "in_progress", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: null });
    insertEnvelope(db, { id: "e1", run_id: "r1", phase_id: "p1", visit: 1, attempt: 0, json: "{}", source: "s", validated_at: "t", valid: 1, violations: "[]", correction: null });

    const phaseRow = db.query("SELECT ordinal, agent_model, require_approval, on_fail_to, gate_names, context_entries FROM phases WHERE id = 'p1'").get() as {
      ordinal: number | null;
      agent_model: string | null;
      require_approval: number;
      on_fail_to: string | null;
      gate_names: string;
      context_entries: string;
    };
    expect(phaseRow).toEqual({
      ordinal: null,
      agent_model: null,
      require_approval: 0,
      on_fail_to: null,
      gate_names: "[]",
      context_entries: "[]",
    });
    expect((db.query("SELECT visit_id FROM envelopes WHERE id = 'e1'").get() as { visit_id: string | null }).visit_id).toBeNull();
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("v2 migration adds the attempt-history columns and gate_overrides to a v1 DB", () => {
  const dir = tmpDataDir("schema-v2");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    // columns from v1
    const envCols = columnNames(db, "envelopes");
    expect(envCols).toContain("valid");
    expect(envCols).toContain("violations");
    expect(envCols).toContain("correction");
    expect(listTables(db)).toContain("gate_overrides");

    // a gate_overrides row references real parent rows (FKs are enforced)
    db.query("INSERT INTO runs (id, blueprint, status, cwd, needs_review, started_at, ended_at) VALUES ('r1', 'b', 'running', '/w', 0, 't', NULL)").run();
    db.query("INSERT INTO phases (id, run_id, name, agent, status, visits, corrections, budget, spend_usd, started_at, ended_at) VALUES ('p1', 'r1', 'build', 'a', 'in_progress', 1, 0, 3, 0, 't', NULL)").run();
    db.query("INSERT INTO envelopes (id, run_id, phase_id, visit, attempt, json, source, validated_at) VALUES ('e1', 'r1', 'p1', 1, 0, '{}', 's', 't')").run();
    db.query("INSERT INTO gate_results (id, envelope_id, gate, pass, violations, ran_at) VALUES ('g1', 'e1', 'q', 0, '[]', 't')").run();
    db.query("INSERT INTO gate_overrides (id, gate_result_id, run_id, envelope_id, by, reason, created_at) VALUES ('o1', 'g1', 'r1', 'e1', 'reviewer', 'manual check', 't')").run();
    expect(
      (db.query("SELECT by, reason FROM gate_overrides WHERE id = 'o1'").get() as { by: string; reason: string }).reason,
    ).toBe("manual check");
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("the DB file lands at {data_dir}/showrunner.db", () => {
  const dir = tmpDataDir("dbpath");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    expect(existsSync(join(dir, "showrunner.db"))).toBe(true);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("WAL / synchronous / foreign_keys pragmas are set", () => {
  const dir = tmpDataDir("pragmas");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1); // NORMAL
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(existsSync(join(dir, "showrunner.db-wal"))).toBe(true); // WAL sidecar exists
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migration is idempotent (re-open does not error or duplicate)", () => {
  const dir = tmpDataDir("idem");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    db.close();
    const db2 = openDb(join(dir, "showrunner.db"));
    expect(listTables(db2)).toHaveLength(tables.length);
    db2.close();
  } finally {
    cleanupDir(dir);
  }
});

test("events round-trip through the table (JSON text data)", () => {
  const dir = tmpDataDir("roundtrip");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "fixture:happy", status: "running", cwd: "/w", needs_review: 0, started_at: "t0", ended_at: null });
    const id = insertEvent(db, {
      run_id: "r1",
      phase_id: null,
      agent_session_id: null,
      type: "run_submitted",
      ts: "t0",
      data: { blueprint: "fixture:happy", cwd: "/w" },
    });
    expect(id).toBe(1); // AUTOINCREMENT starts at 1
    const rows = db.query("SELECT id, run_id, type, ts, data FROM events").all() as {
      id: number;
      run_id: string;
      type: string;
      ts: string;
      data: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("run_submitted");
    expect(JSON.parse(rows[0]!.data)).toEqual({ blueprint: "fixture:happy", cwd: "/w" });
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("foreign keys are enforced (event with unknown run_id is rejected)", () => {
  const dir = tmpDataDir("fk");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    expect(() =>
      insertEvent(db, { run_id: "ghost", phase_id: null, agent_session_id: null, type: "run_submitted", ts: "t", data: { blueprint: "b", cwd: "/" } }),
    ).toThrow();
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("event data is validated against the schema before insert", () => {
  const dir = tmpDataDir("validate");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    expect(() => insertEvent(db, { run_id: "r1", phase_id: null, agent_session_id: null, type: "tool_call", ts: "t", data: { tool: "bash" } })).toThrow();
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("the cursor contract (): ordered, page-limited, next_cursor semantics", () => {
  const dir = tmpDataDir("cursor");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "success", cwd: "/", needs_review: 0, started_at: "t", ended_at: "t" });
    for (let i = 0; i < 505; i++) {
      insertEvent(db, { run_id: "r1", phase_id: null, agent_session_id: null, type: "run_status", ts: `t${i}`, data: { from: "a", to: "b" } });
    }

    const page1 = cursorEvents(db, "r1", 0, 500);
    expect(page1).toHaveLength(500);
    expect(page1[0]!.id).toBe(1);
    expect(page1[499]!.id).toBe(500);
    // strictly ascending rowids
    for (let i = 1; i < page1.length; i++) expect(page1[i]!.id).toBeGreaterThan(page1[i - 1]!.id);
    const next1 = page1[page1.length - 1]!.id; // client's next_cursor

    const page2 = cursorEvents(db, "r1", next1, 500);
    expect(page2).toHaveLength(5);
    expect(page2[0]!.id).toBe(501);
    expect(page2[4]!.id).toBe(505);

    // the exact query text from is what runs
    expect(CURSOR_SQL).toBe("SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?");
    expect(eventCount(db, "r1")).toBe(505);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("sumEstimatedPhaseSpend splits reported vs estimated spend from spend events", () => {
  const dir = tmpDataDir("estspend");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "success", cwd: "/", needs_review: 0, started_at: "t", ended_at: "t" });
    insertPhase(db, { id: "p1", run_id: "r1", name: "plan", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.005, started_at: "t", ended_at: "t" });
    insertPhase(db, { id: "p2", run_id: "r1", name: "build", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.0, started_at: "t", ended_at: "t" });
    const spend = (phaseId: string, data: Record<string, unknown>) =>
      insertEvent(db, { run_id: "r1", phase_id: phaseId, agent_session_id: null, type: "spend", ts: "t", data });
    // estimated → counts toward the estimated split
    spend("p1", { phase: "plan", tokens_in: 1000, tokens_out: 200, cache_read: 0, cache_write: 0, usd: 0.004, estimated: true });
    // reported → NOT in the estimated split
    spend("p1", { phase: "plan", tokens_in: 100, tokens_out: 20, cache_read: 0, cache_write: 0, usd: 0.001, estimated: false });
    // usd null + estimated false → never counted
    spend("p2", { phase: "build", tokens_in: 50, tokens_out: 10, cache_read: 0, cache_write: 0, usd: null, estimated: false });

    const byPhase = sumEstimatedPhaseSpend(db, "r1");
    expect(byPhase.get("p1")).toBeCloseTo(0.004); // only the estimated event
    expect(byPhase.has("p2")).toBe(false);
    // an unknown run yields an empty map
    expect(sumEstimatedPhaseSpend(db, "ghost").size).toBe(0);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("runs list aggregates spend and a full row round-trips", () => {
  const dir = tmpDataDir("runslist");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "fixture:happy", status: "success", cwd: "/w", needs_review: 0, started_at: "t0", ended_at: "t1" });
    insertPhase(db, { id: "p1", run_id: "r1", name: "build", agent: "builder", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.00463, started_at: "t0", ended_at: "t1" });
    insertAgentSession(db, { id: "s1", run_id: "r1", phase_id: "p1", pi_session_id: "abc_build_v1", visit: 1, pid: 42, started_at: "t0", ended_at: "t1" });
    insertProcess(db, { id: "s1", pid: 42, kind: "agent", started_at: "t0" });

    const runs = listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("r1");
    expect(runs[0]!.status).toBe("success");
    expect(runs[0]!.needs_review).toBe(0);
    expect(runs[0]!.spend_usd).toBeCloseTo(0.00463);
    expect(sumRunSpend(db, "r1")).toBeCloseTo(0.00463);

    const run = getRun(db, "r1");
    expect(run?.cwd).toBe("/w");
    expect(run?.ended_at).toBe("t1");
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("phaseStatusCounts groups by status with the total key", () => {
  const dir = tmpDataDir("phasecounts");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, { id: "p1", run_id: "r1", name: "plan", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: "t" });
    insertPhase(db, { id: "p2", run_id: "r1", name: "build", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: "t" });
    insertPhase(db, { id: "p3", run_id: "r1", name: "review", agent: "a", status: "pending", visits: 0, corrections: 0, budget: 3, spend_usd: 0, started_at: null, ended_at: null });

    expect(phaseStatusCounts(db, "r1")).toEqual({ total: 3, success: 2, pending: 1 });
    // an unknown run counts zero, with the total key still present
    expect(phaseStatusCounts(db, "ghost")).toEqual({ total: 0 });
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("sweepRunEvents returns the full history in rowid order, across the 500-row page boundary", () => {
  const dir = tmpDataDir("sweep");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "success", cwd: "/", needs_review: 0, started_at: "t", ended_at: "t" });
    for (let i = 0; i < 505; i++) {
      insertEvent(db, { run_id: "r1", phase_id: null, agent_session_id: null, type: "run_status", ts: `t${i}`, data: { from: "a", to: "b" } });
    }

    const all = sweepRunEvents(db, "r1");
    expect(all).toHaveLength(505); // crossed the default 500 batch twice
    expect(all[0]!.id).toBe(1);
    expect(all[504]!.id).toBe(505);
    // strictly ascending rowids — the cursor contract, end to end
    for (let i = 1; i < all.length; i++) expect(all[i]!.id).toBeGreaterThan(all[i - 1]!.id);
    expect(sweepRunEvents(db, "ghost")).toEqual([]);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("listFailedGateResults returns id + gate for failed-only results, in gate_results row order", () => {
  const dir = tmpDataDir("failedgates");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, { id: "p1", run_id: "r1", name: "build", agent: "a", status: "in_progress", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: null });
    insertEnvelope(db, { id: "e1", run_id: "r1", phase_id: "p1", visit: 1, attempt: 0, json: "{}", source: "s", validated_at: "t", valid: 1, violations: "[]", correction: null });
    insertGateResult(db, { id: "g-fail-1", envelope_id: "e1", gate: "quality", pass: 0, violations: "[]", ran_at: "t" });
    insertGateResult(db, { id: "g-pass", envelope_id: "e1", gate: "format", pass: 1, violations: "[]", ran_at: "t" });
    insertGateResult(db, { id: "g-fail-2", envelope_id: "e1", gate: "coverage", pass: 0, violations: "[]", ran_at: "t" });

    const failed = listFailedGateResults(db, "e1");
    expect(failed).toEqual([
      { id: "g-fail-1", gate: "quality" },
      { id: "g-fail-2", gate: "coverage" },
    ]);
    // an envelope with no failed results returns an empty list
    expect(listFailedGateResults(db, "ghost")).toEqual([]);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("listPhaseSpend merges reported spend with the estimated split, in phases-table order", () => {
  const dir = tmpDataDir("phasespend");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "success", cwd: "/", needs_review: 0, started_at: "t", ended_at: "t" });
    insertPhase(db, { id: "p1", run_id: "r1", name: "plan", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.005, started_at: "t1", ended_at: "t" });
    insertPhase(db, { id: "p2", run_id: "r1", name: "build", agent: "a", status: "success", visits: 1, corrections: 0, budget: 3, spend_usd: 0.0, started_at: "t2", ended_at: "t" });
    const spend = (phaseId: string, data: Record<string, unknown>) =>
      insertEvent(db, { run_id: "r1", phase_id: phaseId, agent_session_id: null, type: "spend", ts: "t", data });
    // estimated → counts toward the estimated split
    spend("p1", { phase: "plan", tokens_in: 1000, tokens_out: 200, cache_read: 0, cache_write: 0, usd: 0.004, estimated: true });
    // reported → NOT in the estimated split
    spend("p1", { phase: "plan", tokens_in: 100, tokens_out: 20, cache_read: 0, cache_write: 0, usd: 0.001, estimated: false });

    const rows = listPhaseSpend(db, "r1");
    expect(rows).toHaveLength(2);
    // phases-table order (listPhases' started_at order)
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    const plan = rows.find((r) => r.id === "p1")!;
    expect(plan.spend_usd).toBe(0.005); // reported stays on the phase row
    expect(plan.estimated_spend_usd).toBeCloseTo(0.004); // only the estimated event
    const build = rows.find((r) => r.id === "p2")!;
    expect(build.estimated_spend_usd).toBe(0); // no estimated spend → 0
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("phase_visits rows round-trip through db.ts, ordered by visit_number, with FK enforcement", () => {
  const dir = tmpDataDir("phasevisits");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, { id: "p1", run_id: "r1", name: "build", agent: "a", status: "in_progress", visits: 0, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: null });
    insertAgentSession(db, { id: "s1", run_id: "r1", phase_id: "p1", pi_session_id: "abc_build_v1", visit: 1, pid: 42, started_at: "t", ended_at: null });

    // insert out of visit_number order to prove the ORDER BY
    insertPhaseVisit(db, { id: "v2", phase_id: "p1", visit_number: 2, cause: "correction", status: "in_progress", started_at: "t2", ended_at: null, agent_session_id: null });
    insertPhaseVisit(db, { id: "v1", phase_id: "p1", visit_number: 1, cause: null, status: "success", started_at: "t1", ended_at: "t1b", agent_session_id: "s1" });

    const visits = listPhaseVisits(db, "p1");
    expect(visits.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(visits[0]).toEqual({
      id: "v1",
      phase_id: "p1",
      visit_number: 1,
      cause: null,
      status: "success",
      started_at: "t1",
      ended_at: "t1b",
      agent_session_id: "s1",
    } satisfies PhaseVisitRow);

    // update patches only the given columns
    updatePhaseVisit(db, "v2", { status: "success", ended_at: "t2b" });
    const afterUpdate = listPhaseVisits(db, "p1").find((v) => v.id === "v2")!;
    expect(afterUpdate.status).toBe("success");
    expect(afterUpdate.ended_at).toBe("t2b");
    expect(afterUpdate.cause).toBe("correction"); // untouched

    // FK: a visit pointing at an unknown phase is rejected
    expect(() =>
      insertPhaseVisit(db, { id: "vx", phase_id: "ghost", visit_number: 1, cause: null, status: "pending", started_at: null, ended_at: null, agent_session_id: null }),
    ).toThrow();
    // FK: an unknown agent_session_id is rejected too
    expect(() =>
      insertPhaseVisit(db, { id: "vy", phase_id: "p1", visit_number: 3, cause: null, status: "pending", started_at: null, ended_at: null, agent_session_id: "ghost" }),
    ).toThrow();

    // an unknown phase yields an empty list
    expect(listPhaseVisits(db, "ghost")).toEqual([]);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("envelopes carry visit_id linking to a phase_visit row, with FK enforcement", () => {
  const dir = tmpDataDir("envelopevisit");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, { id: "p1", run_id: "r1", name: "build", agent: "a", status: "in_progress", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: "t", ended_at: null });
    insertPhaseVisit(db, { id: "v1", phase_id: "p1", visit_number: 1, cause: null, status: "in_progress", started_at: "t", ended_at: null, agent_session_id: null });

    insertEnvelope(db, { id: "e1", run_id: "r1", phase_id: "p1", visit: 1, attempt: 0, json: "{}", source: "s", validated_at: "t", valid: 1, violations: "[]", correction: null, visit_id: "v1" });
    expect(getEnvelope(db, "e1")?.visit_id).toBe("v1");

    // omitting visit_id leaves it null (existing call sites stay source-compatible)
    insertEnvelope(db, { id: "e2", run_id: "r1", phase_id: "p1", visit: 1, attempt: 1, json: "{}", source: "s", validated_at: "t", valid: 1, violations: "[]", correction: null });
    expect(getEnvelope(db, "e2")?.visit_id).toBeNull();

    // FK: an unknown visit_id is rejected
    expect(() =>
      insertEnvelope(db, { id: "e3", run_id: "r1", phase_id: "p1", visit: 1, attempt: 2, json: "{}", source: "s", validated_at: "t", valid: 1, violations: "[]", correction: null, visit_id: "ghost" }),
    ).toThrow();
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("phase declaration metadata round-trips through insertPhase", () => {
  const dir = tmpDataDir("phasedecl");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
    insertPhase(db, {
      id: "p1",
      run_id: "r1",
      name: "build",
      agent: "a",
      status: "in_progress",
      visits: 1,
      corrections: 0,
      budget: 3,
      spend_usd: 0,
      started_at: "t",
      ended_at: null,
      ordinal: 2,
      agent_model: "sonnet",
      require_approval: 1,
      on_fail_to: "plan",
      gate_names: JSON.stringify(["quality", "coverage"]),
      context_entries: JSON.stringify(["plan/outputs"]),
    });

    const row = getPhaseById(db, "p1")!;
    expect(row.ordinal).toBe(2);
    expect(row.agent_model).toBe("sonnet");
    expect(row.require_approval).toBe(1);
    expect(row.on_fail_to).toBe("plan");
    expect(row.gate_names).toBe(JSON.stringify(["quality", "coverage"]));
    expect(row.context_entries).toBe(JSON.stringify(["plan/outputs"]));

    // omitting the declaration fields falls back to the schema defaults
    insertPhase(db, { id: "p2", run_id: "r1", name: "plan", agent: "a", status: "pending", visits: 0, corrections: 0, budget: 3, spend_usd: 0, started_at: null, ended_at: null });
    const defaults = getPhaseById(db, "p2")!;
    expect(defaults.ordinal).toBeNull();
    expect(defaults.agent_model).toBeNull();
    expect(defaults.require_approval).toBe(0);
    expect(defaults.on_fail_to).toBeNull();
    expect(defaults.gate_names).toBe("[]");
    expect(defaults.context_entries).toBe("[]");
    db.close();
  } finally {
    cleanupDir(dir);
  }
});