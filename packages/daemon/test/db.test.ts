import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  CURSOR_SQL,
  cursorEvents,
  eventCount,
  getRun,
  insertAgentSession,
  insertEvent,
  insertPhase,
  insertProcess,
  insertRun,
  listRuns,
  listTables,
  openDb,
  sumRunSpend,
} from "../src/index.ts";

const tables = [
  "runs",
  "phases",
  "events",
  "envelopes",
  "gate_results",
  "agent_sessions",
  "processes",
];

test("migrating a fresh DB creates all seven tables (§4.2)", () => {
  const dir = tmpDataDir("schema");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    const names = listTables(db);
    for (const t of tables) expect(names).toContain(t);
    expect(names).toHaveLength(tables.length); // exactly the seven, no extras
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("the DB file lands at {data_dir}/showrunner.db (§4.1)", () => {
  const dir = tmpDataDir("dbpath");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    expect(existsSync(join(dir, "showrunner.db"))).toBe(true);
    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("WAL / synchronous / foreign_keys pragmas are set (§4.1)", () => {
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

test("event data is validated against the §6 schema before insert", () => {
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

test("the cursor contract (§4.3): ordered, page-limited, next_cursor semantics", () => {
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

    // the exact query text from §4.3 is what runs
    expect(CURSOR_SQL).toBe("SELECT * FROM events WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?");
    expect(eventCount(db, "r1")).toBe(505);
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
