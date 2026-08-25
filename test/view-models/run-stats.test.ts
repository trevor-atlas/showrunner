/**
 * Ticket #53 — the run-stats view-model.
 *
 * buildRunStats(db, pool) folds the all-time landing KPI/chart aggregate from
 * two db rollups (runPhaseExtents + runSpendSplit) plus the pool's queue
 * positions, exactly as the /api/stats endpoint did inline. This exercises the
 * model directly against known-good seed literals: status counts, success rate,
 * spend split (with null-usd skipped), avg duration (terminal + measurable
 * extent only), day buckets keyed off the RUN start, blueprint counts, and
 * queued_count from a real pool. Hermetic: an in-memory-ish scratch db, no
 * daemon.
 */
import { expect, test } from "bun:test";

import { cleanupDir, tmpDataDir } from "../daemon/helpers.ts";
import { dbPathFor } from "../../src/core/index.ts";
import { insertEvent, insertPhase, insertRun, openDb } from "../../src/daemon/db.ts";
import type { Database } from "bun:sqlite";
import { RunPool } from "../../src/server/engine/pool.ts";
import { buildRunStats } from "../../src/view-models/index.ts";

function seedRun(
  db: Database,
  id: string,
  status: string,
  blueprint: string,
  startedAt: string,
  endedAt: string | null,
): void {
  insertRun(db, {
    id,
    blueprint,
    status,
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: startedAt,
    ended_at: endedAt,
  });
}

function seedPhase(
  db: Database,
  id: string,
  runId: string,
  startedAt: string | null,
  endedAt: string | null,
): void {
  insertPhase(db, {
    id,
    run_id: runId,
    name: "build",
    agent: "builder",
    status: endedAt === null ? "pending" : "success",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: startedAt,
    ended_at: endedAt,
  });
}

function seedSpend(
  db: Database,
  runId: string,
  phaseId: string | null,
  usd: number | null,
  estimated: boolean,
  ts: string,
): void {
  insertEvent(db, {
    run_id: runId,
    phase_id: phaseId,
    agent_session_id: null,
    type: "spend",
    ts,
    data: { phase: "build", tokens_in: 10, tokens_out: 5, cache_read: 0, cache_write: 0, usd, estimated },
  });
}

test("buildRunStats folds all-time KPIs from seeded runs/phases/events", () => {
  const dir = tmpDataDir("vm-stats");
  try {
    const db = openDb(dbPathFor(dir));

    // success: blueprint alpha, extent 20_000ms, reported 0.10 + estimated 0.04
    // + a null-usd event that must be skipped. Spend ts is on 03-02 but the run
    // started 03-01, so it must bucket to 03-01.
    seedRun(db, "run-a", "success", "alpha", "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:20.000Z");
    seedPhase(db, "ph-a", "run-a", "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:20.000Z");
    seedSpend(db, "run-a", "ph-a", 0.1, false, "2024-03-02T09:00:00.000Z");
    seedSpend(db, "run-a", "ph-a", 0.04, true, "2024-03-02T09:00:00.000Z");
    seedSpend(db, "run-a", "ph-a", null, false, "2024-03-02T09:00:00.000Z");

    // failed: blueprint alpha, extent 10_000ms, reported 0.05
    seedRun(db, "run-b", "failed", "alpha", "2024-03-02T00:00:00.000Z", "2024-03-02T00:00:10.000Z");
    seedPhase(db, "ph-b", "run-b", "2024-03-02T00:00:00.000Z", "2024-03-02T00:00:10.000Z");
    seedSpend(db, "run-b", "ph-b", 0.05, false, "2024-03-02T00:10:00.000Z");

    // interrupted: blueprint beta, NOT terminal (excluded from rate + avg),
    // open phase, reported 0.20
    seedRun(db, "run-c", "interrupted", "beta", "2024-03-01T00:00:00.000Z", null);
    seedPhase(db, "ph-c", "run-c", "2024-03-01T00:00:00.000Z", null);
    seedSpend(db, "run-c", "ph-c", 0.2, false, "2024-03-01T00:10:00.000Z");

    db.close();

    // A real 1-slot pool: a holder takes the slot, run-c queues at position 1
    // → queued_count must see run-c via pool.position.
    const pool = new RunPool(1);
    pool.enqueue("holder", () => {});
    pool.enqueue("run-c", () => {});

    const stats = buildRunStats(openDb(dbPathFor(dir)), pool);

    expect(stats.runs_count).toBe(3);
    expect(stats.status_counts).toEqual({ success: 1, failed: 1, interrupted: 1 });
    expect(stats.queued_count).toBe(1);

    expect(stats.success_rate).toBeCloseTo(0.5, 10);
    expect(stats.reported_usd).toBeCloseTo(0.35, 10); // 0.10 + 0.05 + 0.20
    expect(stats.estimated_usd).toBeCloseTo(0.04, 10);
    expect(stats.avg_duration_ms).toBeCloseTo(15_000, 6); // (20_000 + 10_000) / 2

    expect(stats.spend_by_day).toHaveLength(2);
    const [d1, d2] = stats.spend_by_day;
    expect(d1!.day).toBe("2024-03-01");
    expect(d1!.reported_usd).toBeCloseTo(0.3, 10); // 0.10 + 0.20
    expect(d1!.estimated_usd).toBeCloseTo(0.04, 10);
    expect(d2!.day).toBe("2024-03-02");
    expect(d2!.reported_usd).toBeCloseTo(0.05, 10);
    expect(d2!.estimated_usd).toBeCloseTo(0, 10);

    expect(stats.blueprints).toEqual([
      { blueprint: "alpha", runs: 2 },
      { blueprint: "beta", runs: 1 },
    ]);
  } finally {
    cleanupDir(dir);
  }
});

test("buildRunStats reports null KPIs when there are zero terminal runs", () => {
  const dir = tmpDataDir("vm-stats-empty");
  try {
    const db = openDb(dbPathFor(dir));
    seedRun(db, "run-int-only", "interrupted", "scout", "2024-02-01T00:00:00.000Z", null);
    db.close();

    const stats = buildRunStats(openDb(dbPathFor(dir)), new RunPool(1));

    expect(stats.runs_count).toBe(1);
    expect(stats.status_counts).toEqual({ interrupted: 1 });
    expect(stats.success_rate).toBeNull();
    expect(stats.avg_duration_ms).toBeNull();
  } finally {
    cleanupDir(dir);
  }
});
