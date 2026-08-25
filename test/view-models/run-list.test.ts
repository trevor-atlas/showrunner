/**
 * Ticket #54 — the run-list view-model.
 *
 * buildRunList(db, pool) assembles the landing-table rows the /api/runs
 * endpoint used to derive inline: listRuns rows merged with the runPhaseExtents
 * rollup (min/max phase extent), phaseStatusCounts per run, and the pool's
 * 1-based queue position (null when not queued). This exercises the model
 * directly against known-good seed literals: row count, phase-count merge, the
 * extent merge, spend rollup, and queue-position behavior from a real pool.
 * Hermetic: a scratch db + a real RunPool, no daemon.
 */
import { expect, test } from "bun:test";

import { cleanupDir, tmpDataDir } from "../daemon/helpers.ts";
import { dbPathFor } from "../../src/core/index.ts";
import { insertPhase, insertRun, openDb } from "../../src/daemon/db.ts";
import type { Database } from "bun:sqlite";
import { RunPool } from "../../src/server/engine/pool.ts";
import { buildRunList } from "../../src/view-models/index.ts";

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
  status: string,
  spendUsd: number,
  startedAt: string | null,
  endedAt: string | null,
): void {
  insertPhase(db, {
    id,
    run_id: runId,
    name: "build",
    agent: "builder",
    status,
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: spendUsd,
    started_at: startedAt,
    ended_at: endedAt,
  });
}

test("buildRunList assembles rows with phase counts, extent merge, and spend", () => {
  const dir = tmpDataDir("vm-list");
  try {
    const db = openDb(dbPathFor(dir));

    // run-a: two phases (1 success + 1 pending). spend 0.10 + 0.04 = 0.14.
    // extent = MIN(started)/MAX(ended) over the phases that ran → the success
    // phase span (the pending one has no started/ended and drops out).
    seedRun(db, "run-a", "success", "alpha", "2024-03-02T00:00:00.000Z", "2024-03-02T00:00:20.000Z");
    seedPhase(db, "ph-a1", "run-a", "success", 0.1, "2024-03-02T00:00:00.000Z", "2024-03-02T00:00:20.000Z");
    seedPhase(db, "ph-a2", "run-a", "pending", 0.04, null, null);

    // run-b: one failed phase, spend 0.05, extent = its own span
    seedRun(db, "run-b", "failed", "beta", "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:10.000Z");
    seedPhase(db, "ph-b1", "run-b", "failed", 0.05, "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:10.000Z");

    db.close();

    const { runs } = buildRunList(openDb(dbPathFor(dir)), new RunPool(1));

    // listRuns orders by started_at DESC → run-a first, run-b second
    expect(runs).toHaveLength(2);
    const [a, b] = runs;

    expect(a!.id).toBe("run-a");
    expect(a!.spend_usd).toBeCloseTo(0.14, 10);
    expect(a!.phase_counts).toEqual({ total: 2, success: 1, pending: 1 });
    expect(a!.min_phase_started_at).toBe("2024-03-02T00:00:00.000Z");
    expect(a!.max_phase_ended_at).toBe("2024-03-02T00:00:20.000Z");
    // not pool-queued → null
    expect(a!.queue_position).toBeNull();

    expect(b!.id).toBe("run-b");
    expect(b!.spend_usd).toBeCloseTo(0.05, 10);
    expect(b!.phase_counts).toEqual({ total: 1, failed: 1 });
    expect(b!.queue_position).toBeNull();
  } finally {
    cleanupDir(dir);
  }
});

test("buildRunList surfaces the pool's 1-based queue position", () => {
  const dir = tmpDataDir("vm-list-queue");
  try {
    const db = openDb(dbPathFor(dir));
    seedRun(db, "run-run", "running", "alpha", "2024-03-01T00:00:00.000Z", null);
    seedRun(db, "run-q1", "running", "alpha", "2024-03-01T00:00:01.000Z", null);
    seedRun(db, "run-q2", "running", "alpha", "2024-03-01T00:00:02.000Z", null);
    db.close();

    // 1-slot pool: a holder takes the only slot; run-q2 queues at 1, run-q1 at
    // 2 (listRuns is started-DESC, so run-q2 is first in the list rows).
    const pool = new RunPool(1);
    pool.enqueue("holder", () => {});
    pool.enqueue("run-q2", () => {});
    pool.enqueue("run-q1", () => {});

    const byId = new Map(buildRunList(openDb(dbPathFor(dir)), pool).runs.map((r) => [r.id, r]));

    expect(byId.get("run-q2")!.queue_position).toBe(1);
    expect(byId.get("run-q1")!.queue_position).toBe(2);
    // "run-run" was never enqueued → not queued
    expect(byId.get("run-run")!.queue_position).toBeNull();
  } finally {
    cleanupDir(dir);
  }
});
