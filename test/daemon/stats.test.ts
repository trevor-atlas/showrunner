process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi
/**
 * GET /api/stats acceptance (issue #34): the all-time landing KPI/chart
 * aggregate, from REAL daemon data. Runs/phases/events are seeded directly
 * (like test/ui/run-list.test.ts) so every KPI has a deterministic value,
 * then the daemon runs in-process and the typed DaemonClient reads it back
 * (mirroring test/daemon/server.test.ts).
 *
 * Hermetic: each test uses its own scratch data dir and closes its daemon.
 */
import { test, expect } from "bun:test";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { dbPathFor } from "../../src/core/index.ts";
import { DaemonClient } from "../../src/server/transport/client.ts";
import { insertEvent, insertPhase, insertRun, openDb } from "../../src/server/repository/db.ts";
import { startDaemon } from "../../src/server/lifecycle.ts";
import { type DaemonHandle } from "../../src/server/lifecycle.ts";
import type { Database } from "bun:sqlite";

const APPROVAL_BLUEPRINT = new URL("./fixtures/approval-blueprint.ts", import.meta.url).pathname;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms}ms`);
}

// ── seed helpers ────────────────────────────────────────────────────────────

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
  name: string,
  startedAt: string | null,
  endedAt: string | null,
): void {
  insertPhase(db, {
    id,
    run_id: runId,
    name,
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

/** A spend event (usd may be null to exercise the null-usd skip). `ts` is
 * deliberately independent of the run start so the day-bucketing test proves
 * buckets key off the RUN start, not the event ts. */
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

test("apiStats derives all-time KPIs from seeded runs/phases/events", async () => {
  const dir = tmpDataDir("stats");
  let daemon: DaemonHandle | null = null;
  try {
    // Seed BEFORE start: only pre-start `running` rows get reconciled to
    // interrupted, so these statuses survive verbatim.
    const db = openDb(dbPathFor(dir));

    // success-1: two ended phases → extent 00:00:00 → 00:00:30 = 30_000ms.
    // Spend: reported 0.10 + estimated 0.05 (its ts is on 2024-01-02, but the
    // run started 2024-01-01, so it must bucket to the 01 day) + a null-usd
    // event that must be skipped from both totals.
    seedRun(db, "run-succ-1", "success", "plan_build", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:30.000Z");
    seedPhase(db, "ph-s1-a", "run-succ-1", "build", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:10.000Z");
    seedPhase(db, "ph-s1-b", "run-succ-1", "test", "2024-01-01T00:00:10.000Z", "2024-01-01T00:00:30.000Z");
    seedSpend(db, "run-succ-1", "ph-s1-a", 0.1, false, "2024-01-02T09:00:00.000Z");
    seedSpend(db, "run-succ-1", "ph-s1-b", 0.05, true, "2024-01-02T09:00:00.000Z");
    seedSpend(db, "run-succ-1", "ph-s1-b", null, false, "2024-01-02T09:00:00.000Z");

    // success-2: extent 50_000ms; reported 0.20
    seedRun(db, "run-succ-2", "success", "plan_build", "2024-01-02T00:00:00.000Z", "2024-01-02T00:00:50.000Z");
    seedPhase(db, "ph-s2-a", "run-succ-2", "build", "2024-01-02T00:00:00.000Z", "2024-01-02T00:00:50.000Z");
    seedSpend(db, "run-succ-2", "ph-s2-a", 0.2, false, "2024-01-02T00:10:00.000Z");

    // failed-1: extent 10_000ms; reported 0.02
    seedRun(db, "run-fail-1", "failed", "plan_build", "2024-01-02T00:00:00.000Z", "2024-01-02T00:00:10.000Z");
    seedPhase(db, "ph-f1-a", "run-fail-1", "build", "2024-01-02T00:00:00.000Z", "2024-01-02T00:00:10.000Z");
    seedSpend(db, "run-fail-1", "ph-f1-a", 0.02, false, "2024-01-02T00:10:00.000Z");

    // interrupted-1: NOT terminal → out of the success-rate denominator AND
    // out of the avg; counted on its own. One open phase, reported 0.30.
    seedRun(db, "run-int-1", "interrupted", "scout", "2024-01-01T00:00:00.000Z", null);
    seedPhase(db, "ph-i1-a", "run-int-1", "build", "2024-01-01T00:00:00.000Z", null);
    seedSpend(db, "run-int-1", "ph-i1-a", 0.3, false, "2024-01-01T00:10:00.000Z");

    // success-no-phases: terminal but NO phases → no measurable extent →
    // excluded from the avg. Reported 0.01 (phase_id null).
    seedRun(db, "run-succ-np", "success", "everything", "2024-01-03T00:00:00.000Z", "2024-01-03T00:00:05.000Z");
    seedSpend(db, "run-succ-np", null, 0.01, false, "2024-01-03T00:10:00.000Z");

    // success-pending-phase: terminal but the only phase is pending
    // (started/ended null) → MIN/MAX null → excluded from the avg. No spend.
    seedRun(db, "run-succ-pp", "success", "everything", "2024-01-03T00:00:00.000Z", "2024-01-03T00:00:05.000Z");
    seedPhase(db, "ph-pp-a", "run-succ-pp", "build", null, null);

    db.close();

    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const client = new DaemonClient({ baseUrl: daemon.baseUrl });
    const stats = await client.getStats();

    // counts: raw status keys only (no `queued`); interrupted is its own count
    expect(stats.runs_count).toBe(6);
    expect(stats.status_counts).toEqual({ success: 4, failed: 1, interrupted: 1 });
    expect(stats.queued_count).toBe(0);

    // success-rate: success ÷ (success + failed) = 4 / 5; interrupted excluded
    expect(stats.success_rate).toBeCloseTo(0.8, 10);

    // spend totals from EVENTS, split on the flag, null-usd skipped
    expect(stats.reported_usd).toBeCloseTo(0.63, 10); // 0.10+0.20+0.02+0.30+0.01
    expect(stats.estimated_usd).toBeCloseTo(0.05, 10);

    // avg duration: terminal runs with a measurable extent only
    // (30_000 + 50_000 + 10_000) / 3 = 30_000; no `|| now`, no pending/no-phase
    expect(stats.avg_duration_ms).toBeCloseTo(30_000, 6);

    // spend_by_day: bucketed by RUN start date (UTC), ascending. success-1's
    // estimated event ts is 2024-01-02 but its run started 2024-01-01.
    expect(stats.spend_by_day).toHaveLength(3);
    const [d1, d2, d3] = stats.spend_by_day;
    expect(d1!.day).toBe("2024-01-01");
    expect(d1!.reported_usd).toBeCloseTo(0.4, 10); // 0.10 + 0.30
    expect(d1!.estimated_usd).toBeCloseTo(0.05, 10);
    expect(d2!.day).toBe("2024-01-02");
    expect(d2!.reported_usd).toBeCloseTo(0.22, 10); // 0.20 + 0.02
    expect(d2!.estimated_usd).toBeCloseTo(0, 10);
    expect(d3!.day).toBe("2024-01-03");
    expect(d3!.reported_usd).toBeCloseTo(0.01, 10);

    // blueprints sorted runs-desc
    expect(stats.blueprints).toEqual([
      { blueprint: "plan_build", runs: 3 },
      { blueprint: "everything", runs: 2 },
      { blueprint: "scout", runs: 1 },
    ]);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("apiStats reports null KPIs when there are zero terminal runs", async () => {
  const dir = tmpDataDir("stats-empty");
  let daemon: DaemonHandle | null = null;
  try {
    const db = openDb(dbPathFor(dir));
    // one interrupted run: terminal count is 0 → success_rate and
    // avg_duration_ms are both null (interrupted is not terminal)
    seedRun(db, "run-int-only", "interrupted", "scout", "2024-02-01T00:00:00.000Z", null);
    db.close();

    daemon = await startDaemon({ dataDir: dir, port: 0 });
    const client = new DaemonClient({ baseUrl: daemon.baseUrl });
    const stats = await client.getStats();

    expect(stats.runs_count).toBe(1);
    expect(stats.status_counts).toEqual({ interrupted: 1 });
    expect(stats.success_rate).toBeNull();
    expect(stats.avg_duration_ms).toBeNull();
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("apiStats queued_count comes from a real 1-slot pool", async () => {
  const dir = tmpDataDir("stats-queue");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, poolSlots: 1, port: 0 });
    const client = new DaemonClient({ baseUrl: daemon.baseUrl });

    // A pauses at require_approval and HOLDS the single slot (F1)…
    const a = await client.submitRun({ blueprint: APPROVAL_BLUEPRINT, cwd: dir });
    await waitFor(async () => {
      const { runs } = await client.listRuns();
      return runs.find((r) => r.id === a.run_id)?.status === "paused";
    });
    // …so B queues at spawn-position 1
    const b = await client.submitRun({ blueprint: APPROVAL_BLUEPRINT, cwd: dir });
    expect(b.queue_position).toBe(1);

    const stats = await client.getStats();
    expect(stats.runs_count).toBe(2);
    // queued is a POOL state, not a DB status — it surfaces as queued_count,
    // driven by pool.position, the same source apiListRuns uses
    expect(stats.queued_count).toBe(1);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});
