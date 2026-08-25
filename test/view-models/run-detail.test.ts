/**
 * Ticket #55 — the run-detail view-model (detail + spend + timeline).
 *
 * buildRunDetail / buildSpendBreakdown / buildTimeline are the ONE owner of
 * the run-detail read the apiRunDetail / apiSpend / apiTimeline endpoints used
 * to derive inline. This exercises the models directly against known-good seed
 * literals (a scratch db, no daemon):
 *   - buildRunDetail: run spend (SUM phases.spend_usd), estimated spend (from
 *     the estimated spend EVENTS), envelope count, phase rows, sessions, event
 *     count, and the optional ?full=1 sweep (single- AND multi-page).
 *   - buildSpendBreakdown: the per-phase spend + token totals shape.
 *   - buildTimeline: delegates to buildTimelineView (kept in daemon/timeline.ts)
 *     — the folded per-visit segments + blueprint order.
 * The per-phase spend_usd deliberately differs from the spend EVENTS' usd so
 * the derivations prove they read the right source (phase rows vs events).
 */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { dbPathFor } from "../../src/core/index.ts";
import {
  getRun,
  insertAgentSession,
  insertEnvelope,
  insertEvent,
  insertPhase,
  insertRun,
  openDb,
} from "../../src/server/repository/db.ts";
import { buildRunDetail, buildSpendBreakdown, buildTimeline } from "../../src/server/services/run-detail.ts";

import { cleanupDir, tmpDataDir } from "../daemon/helpers.ts";

/** An ISO ts at `sec` seconds within the synthetic day (rowid order = ts order). */
function ts(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `2025-02-01T00:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
}

function seedPhase(
  db: Database,
  id: string,
  runId: string,
  name: string,
  spendUsd: number,
  startedAt: string,
  endedAt: string,
  corrections = 0,
): void {
  insertPhase(db, {
    id,
    run_id: runId,
    name,
    agent: "builder",
    status: "success",
    visits: 1,
    corrections,
    budget: 3,
    spend_usd: spendUsd,
    started_at: startedAt,
    ended_at: endedAt,
  });
}

function seedSpendEvent(
  db: Database,
  runId: string,
  phaseId: string,
  name: string,
  t: string,
  usd: number,
  estimated: boolean,
  tokens: { tokens_in: number; tokens_out: number; cache_read: number; cache_write: number },
): number {
  return insertEvent(db, {
    run_id: runId,
    phase_id: phaseId,
    agent_session_id: null,
    type: "spend",
    ts: t,
    data: { phase: name, usd, estimated, ...tokens },
  });
}

function startPhase(db: Database, runId: string, phaseId: string, name: string, visit: number, t: string): number {
  return insertEvent(db, {
    run_id: runId,
    phase_id: phaseId,
    agent_session_id: null,
    type: "phase_start",
    ts: t,
    data: { phase: name, agent: "builder", visit, budget: 3, cause: { kind: "flow" } },
  });
}

function endPhase(db: Database, runId: string, phaseId: string, name: string, visit: number, t: string): number {
  return insertEvent(db, {
    run_id: runId,
    phase_id: phaseId,
    agent_session_id: null,
    type: "phase_end",
    ts: t,
    data: { phase: name, status: "success", visits: visit, corrections: 0, spend_usd: 0 },
  });
}

function seedEnvelope(db: Database, runId: string, phaseId: string, visit: number, attempt: number, t: string): void {
  insertEnvelope(db, {
    id: `${runId}-${phaseId}-v${visit}-a${attempt}`,
    run_id: runId,
    phase_id: phaseId,
    visit,
    attempt,
    json: JSON.stringify({ summary: "synthetic" }),
    source: "synthetic",
    validated_at: t,
    valid: 1,
    violations: "[]",
    correction: null,
  });
}

/** Seed a two-phase run with spend events, envelopes, sessions, and a small
 * timeline log; returns the rowids of the inserted events in insertion order. */
function seedRun(db: Database): number[] {
  insertRun(db, {
    id: "det",
    blueprint: "demo",
    status: "success",
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: ts(0),
    ended_at: ts(59),
  });
  // plan spend_usd 0.10 (row) — its spend EVENT is REPORTED (estimated=false)
  seedPhase(db, "det-plan", "det", "plan", 0.1, ts(1), ts(11), 1);
  // build spend_usd 0.20 (row) — its spend EVENT is ESTIMATED usd 0.25
  seedPhase(db, "det-build", "det", "build", 0.2, ts(2), ts(21));

  const ids: number[] = [];
  ids.push(startPhase(db, "det", "det-plan", "plan", 1, ts(10)));
  ids.push(endPhase(db, "det", "det-plan", "plan", 1, ts(11)));
  ids.push(
    seedSpendEvent(db, "det", "det-plan", "plan", ts(11), 0.1, false, {
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 10,
      cache_write: 5,
    }),
  );
  ids.push(startPhase(db, "det", "det-build", "build", 1, ts(20)));
  ids.push(endPhase(db, "det", "det-build", "build", 1, ts(21)));
  ids.push(
    seedSpendEvent(db, "det", "det-build", "build", ts(21), 0.25, true, {
      tokens_in: 200,
      tokens_out: 60,
      cache_read: 20,
      cache_write: 8,
    }),
  );

  // 3 envelope rows → envelope_count 3 (plan v1 has two attempts)
  seedEnvelope(db, "det", "det-plan", 1, 0, ts(10));
  seedEnvelope(db, "det", "det-plan", 1, 1, ts(10));
  seedEnvelope(db, "det", "det-build", 1, 0, ts(20));

  // 2 agent sessions
  insertAgentSession(db, {
    id: "sess-plan",
    run_id: "det",
    phase_id: "det-plan",
    pi_session_id: "pi-plan",
    visit: 1,
    pid: 111,
    started_at: ts(10),
    ended_at: ts(11),
  });
  insertAgentSession(db, {
    id: "sess-build",
    run_id: "det",
    phase_id: "det-build",
    pi_session_id: "pi-build",
    visit: 1,
    pid: 222,
    started_at: ts(20),
    ended_at: ts(21),
  });
  return ids;
}

test("buildRunDetail assembles spend, estimated spend, counts, phases, and sessions", () => {
  const dir = tmpDataDir("vm-detail");
  try {
    const wdb = openDb(dbPathFor(dir));
    seedRun(wdb);
    wdb.close();

    const db = openDb(dbPathFor(dir));
    const run = getRun(db, "det")!;
    const detail = buildRunDetail(db, run);

    expect(detail.run.id).toBe("det");
    expect(detail.run.status).toBe("success");
    // run spend = SUM(phases.spend_usd) = 0.10 + 0.20
    expect(detail.spend_usd).toBeCloseTo(0.3, 10);
    // estimated spend = SUM of the ESTIMATED spend events' usd = build's 0.25
    expect(detail.estimated_spend_usd).toBeCloseTo(0.25, 10);
    expect(detail.envelope_count).toBe(3);
    expect(detail.event_count).toBe(6);
    expect(detail.sessions.map((s) => s.pi_session_id)).toEqual(["pi-plan", "pi-build"]);
    // phases in started_at order, carrying per-phase estimated spend
    expect(detail.phases.map((p) => [p.name, p.spend_usd, p.estimated_spend_usd])).toEqual([
      ["plan", 0.1, 0],
      ["build", 0.2, 0.25],
    ]);
    // no ?full sweep by default
    expect(detail.events).toBeUndefined();
    expect(detail.next_cursor).toBeUndefined();
  } finally {
    cleanupDir(dir);
  }
});

test("buildRunDetail with full rides the SSR sweep — all events in rowid order + next_cursor (single AND multi-page)", () => {
  const dir = tmpDataDir("vm-detail-full");
  try {
    const wdb = openDb(dbPathFor(dir));
    const ids = seedRun(wdb);
    wdb.close();

    const db = openDb(dbPathFor(dir));
    const run = getRun(db, "det")!;

    const full = buildRunDetail(db, run, { full: true });
    expect(full.events!.map((e) => e.id)).toEqual([...ids].sort((a, b) => a - b));
    expect(full.next_cursor).toBe(Math.max(...ids));

    // a tiny per-page batch forces the sweep's multi-page loop — same result
    const paged = buildRunDetail(db, run, { full: true, sweepBatch: 2 });
    expect(paged.events!.map((e) => e.id)).toEqual(full.events!.map((e) => e.id));
    expect(paged.next_cursor).toBe(full.next_cursor);
  } finally {
    cleanupDir(dir);
  }
});

test("buildSpendBreakdown assembles the per-phase spend + token totals shape", () => {
  const dir = tmpDataDir("vm-spend");
  try {
    const wdb = openDb(dbPathFor(dir));
    seedRun(wdb);
    wdb.close();

    const db = openDb(dbPathFor(dir));
    const run = getRun(db, "det")!;
    const spend = buildSpendBreakdown(db, run);

    expect(spend.run_id).toBe("det");
    expect(spend.spend_usd).toBeCloseTo(0.3, 10);
    expect(spend.estimated_spend_usd).toBeCloseTo(0.25, 10);
    expect(spend.phases.map((p) => p.name)).toEqual(["plan", "build"]);
    const plan = spend.phases.find((p) => p.name === "plan")!;
    expect([plan.tokens_in, plan.tokens_out, plan.cache_read, plan.cache_write]).toEqual([100, 50, 10, 5]);
    expect(plan.spend_usd).toBeCloseTo(0.1, 10);
    const build = spend.phases.find((p) => p.name === "build")!;
    expect([build.tokens_in, build.tokens_out, build.cache_read, build.cache_write]).toEqual([200, 60, 20, 8]);
    expect(build.estimated_spend_usd).toBeCloseTo(0.25, 10);
  } finally {
    cleanupDir(dir);
  }
});

test("buildTimeline delegates to buildTimelineView — folded segments in blueprint order", () => {
  const dir = tmpDataDir("vm-timeline");
  try {
    const wdb = openDb(dbPathFor(dir));
    seedRun(wdb);
    wdb.close();

    const db = openDb(dbPathFor(dir));
    const run = getRun(db, "det")!;
    const view = buildTimeline(db, dir, run);

    expect(view.run_id).toBe("det");
    expect(view.status).toBe("success");
    // no snapshot → fallback is first phase_start order: plan (ts10), build (ts20)
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "build"]);
    expect(view.phases.map((p) => p.segments.length)).toEqual([1, 1]);
    const plan = view.phases.find((p) => p.name === "plan")!;
    expect(plan.segments[0]!.outcome).toBe("success");
    expect(plan.segments[0]!.ended_at).toBe(ts(11));
    // envelope_attempts counts the `envelopes` table rows per (phase, visit)
    expect(plan.segments[0]!.envelope_attempts).toBe(2);
    const build = view.phases.find((p) => p.name === "build")!;
    expect(build.segments[0]!.envelope_attempts).toBe(1);
    expect(build.segments[0]!.outcome).toBe("success");
  } finally {
    cleanupDir(dir);
  }
});
