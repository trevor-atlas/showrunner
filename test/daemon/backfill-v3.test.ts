import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { getEnvelope, getPhaseById, listPhaseVisits, migrate, openDb } from "../../src/daemon/db.ts";
import { backfillV3 } from "../../src/daemon/backfill-v3.ts";

/**
 * Build a v2-shaped DB by hand: a v3 schema (openDb migrates it) seeded with
 * rows that lack every v3 field — NULL ordinal/agent_model, NULL envelope
 * visit_id, and no phase_visits rows. That is exactly the post-migration shape
 * an old v2 DB lands in, so backfillV3 has real work to synthesize.
 */
function seedV2Shaped(db: Database): void {
  db.query("INSERT INTO runs (id, blueprint, status, cwd, needs_review, started_at, ended_at) VALUES ('r1', 'b', 'success', '/w', 0, 't', 't')").run();
  // two phases; insertion order (rowid) is the ordinal source
  db.query("INSERT INTO phases (id, run_id, name, agent, status, visits, corrections, budget, spend_usd, started_at, ended_at) VALUES ('p0', 'r1', 'plan', 'planner', 'success', 2, 0, 3, 0, 't', 't')").run();
  db.query("INSERT INTO phases (id, run_id, name, agent, status, visits, corrections, budget, spend_usd, started_at, ended_at) VALUES ('p1', 'r1', 'build', 'builder', 'failed', 3, 1, 3, 0, 't', 't')").run();

  // agent_sessions carry (phase_id, visit) pairs and the started/ended stamps
  db.query("INSERT INTO agent_sessions (id, run_id, phase_id, pi_session_id, visit, pid, started_at, ended_at) VALUES ('s-p0-v1', 'r1', 'p0', 'sid_plan_v1', 1, 10, 'p0v1-start', 'p0v1-end')").run();
  db.query("INSERT INTO agent_sessions (id, run_id, phase_id, pi_session_id, visit, pid, started_at, ended_at) VALUES ('s-p1-v1', 'r1', 'p1', 'sid_build_v1', 1, 11, 'p1v1-start', 'p1v1-end')").run();
  db.query("INSERT INTO agent_sessions (id, run_id, phase_id, pi_session_id, visit, pid, started_at, ended_at) VALUES ('s-p1-v2', 'r1', 'p1', 'sid_build_v2', 2, 12, 'p1v2-start', 'p1v2-end')").run();
  // a session with a visit that has NO envelope (proves the UNION covers sessions)
  db.query("INSERT INTO agent_sessions (id, run_id, phase_id, pi_session_id, visit, pid, started_at, ended_at) VALUES ('s-p1-v3', 'r1', 'p1', 'sid_build_v3', 3, 13, 'p1v3-start', null)").run();

  // envelopes carry (phase_id, visit) pairs; no visit_id yet
  const env = (id: string, phase: string, visit: number, attempt: number) =>
    db.query("INSERT INTO envelopes (id, run_id, phase_id, visit, attempt, json, source, validated_at) VALUES (?, 'r1', ?, ?, ?, '{}', 's', 't')").run(id, phase, visit, attempt);
  env("e-p0-v1", "p0", 1, 0);
  env("e-p1-v1a", "p1", 1, 0);
  env("e-p1-v1b", "p1", 1, 1);
  env("e-p1-v2", "p1", 2, 0);
  // an envelope with a visit that has NO session (proves the UNION covers envelopes)
  env("e-p0-v2", "p0", 2, 0);
}

test("backfillV3 synthesizes phase_visits and links envelope visit_id on a v2-shaped DB", () => {
  const dir = tmpDataDir("backfill-v3");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    seedV2Shaped(db);

    const summary = backfillV3(db);

    // distinct (phase_id, visit) pairs across envelopes + agent_sessions:
    // p0 -> {1, 2}, p1 -> {1, 2, 3}
    const p0 = listPhaseVisits(db, "p0");
    expect(p0.map((v) => v.visit_number)).toEqual([1, 2]);
    const p1 = listPhaseVisits(db, "p1");
    expect(p1.map((v) => v.visit_number)).toEqual([1, 2, 3]);
    expect(summary.visitsSynthesized).toBe(5);

    // a visit backed by a session copies its stamps + links the session
    const p0v1 = p0.find((v) => v.visit_number === 1)!;
    expect(p0v1.agent_session_id).toBe("s-p0-v1");
    expect(p0v1.started_at).toBe("p0v1-start");
    expect(p0v1.ended_at).toBe("p0v1-end");
    expect(p0v1.status).toBe("success"); // derived from the phase's status

    // a visit with only an envelope (no session) links no session
    const p0v2 = p0.find((v) => v.visit_number === 2)!;
    expect(p0v2.agent_session_id).toBeNull();
    expect(p0v2.started_at).toBeNull();

    const p1v3 = p1.find((v) => v.visit_number === 3)!;
    expect(p1v3.status).toBe("failed"); // p1's status
    expect(p1v3.agent_session_id).toBe("s-p1-v3");

    // every envelope now points at the phase_visits row for its (phase_id, visit)
    expect(getEnvelope(db, "e-p0-v1")?.visit_id).toBe(p0v1.id);
    expect(getEnvelope(db, "e-p0-v2")?.visit_id).toBe(p0v2.id);
    const p1v1 = p1.find((v) => v.visit_number === 1)!;
    expect(getEnvelope(db, "e-p1-v1a")?.visit_id).toBe(p1v1.id);
    expect(getEnvelope(db, "e-p1-v1b")?.visit_id).toBe(p1v1.id);
    const p1v2 = p1.find((v) => v.visit_number === 2)!;
    expect(getEnvelope(db, "e-p1-v2")?.visit_id).toBe(p1v2.id);
    expect(summary.envelopesLinked).toBe(5);

    // ordinal derives from phase insertion (rowid) order per run
    expect(getPhaseById(db, "p0")?.ordinal).toBe(0);
    expect(getPhaseById(db, "p1")?.ordinal).toBe(1);
    expect(summary.phasesOrdinaled).toBe(2);

    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("backfillV3 is idempotent — a second run changes nothing", () => {
  const dir = tmpDataDir("backfill-v3-idem");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    seedV2Shaped(db);
    backfillV3(db);

    const snapshot = () => ({
      visits: [...listPhaseVisits(db, "p0"), ...listPhaseVisits(db, "p1")],
      envelopeVisitIds: ["e-p0-v1", "e-p0-v2", "e-p1-v1a", "e-p1-v1b", "e-p1-v2"].map((id) => getEnvelope(db, id)?.visit_id),
      ordinals: [getPhaseById(db, "p0")?.ordinal, getPhaseById(db, "p1")?.ordinal],
    });
    const before = snapshot();

    const second = backfillV3(db);
    expect(second).toEqual({ phasesOrdinaled: 0, phasesModeled: 0, visitsSynthesized: 0, envelopesLinked: 0 });
    expect(snapshot()).toEqual(before);

    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("backfillV3 copies agent_model from the run's blueprint.json snapshot when present", () => {
  const dir = tmpDataDir("backfill-v3-model");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    seedV2Shaped(db);

    const runDir = join(dir, "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "blueprint.json"),
      JSON.stringify({
        name: "b",
        phases: [
          { name: "plan", agent: { name: "planner", model: "sonnet" } },
          { name: "build", agent: { name: "builder", model: "opus" } },
        ],
      }),
    );

    const summary = backfillV3(db);
    expect(getPhaseById(db, "p0")?.agent_model).toBe("sonnet");
    expect(getPhaseById(db, "p1")?.agent_model).toBe("opus");
    expect(summary.phasesModeled).toBe(2);

    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migrate commits the v3 schema on its own — a backfill bug cannot brick the migration transaction", () => {
  const dir = tmpDataDir("backfill-v3-order");
  try {
    const path = join(dir, "showrunner.db");
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON;");

    // migrate() alone produces a committed v3 schema — backfill never runs inside it
    migrate(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phase_visits'").all() as { name: string }[]);
    expect(tables).toHaveLength(1);
    // no synthesis happened during migrate: even with v2-shaped data, phase_visits is empty
    seedV2Shaped(db);
    expect(listPhaseVisits(db, "p0")).toHaveLength(0);

    db.close();
  } finally {
    cleanupDir(dir);
  }
});

test("openDb runs backfillV3 after migrating, synthesizing visits for pre-existing v2-shaped rows", () => {
  const dir = tmpDataDir("backfill-v3-opendb");
  try {
    const path = join(dir, "showrunner.db");
    const first = openDb(path);
    seedV2Shaped(first);
    first.close();

    // reopening migrates (already v3, a no-op) then runs backfillV3 over the seeded rows
    const reopened = openDb(path);
    expect(listPhaseVisits(reopened, "p0").map((v) => v.visit_number)).toEqual([1, 2]);
    expect(getEnvelope(reopened, "e-p0-v1")?.visit_id).not.toBeNull();
    expect(getPhaseById(reopened, "p1")?.ordinal).toBe(1);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});
