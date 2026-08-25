/**
 * The run-stats view-model — the ONE owner of the all-time landing aggregate
 * (#53). `buildRunStats` folds the KPI/chart shape (`RunStats`) the /api/stats
 * endpoint used to derive inline, from two persistence handles: a SQLite
 * connection and the run pool.
 *
 * PURE data assembly — ids + handles in, serializable shapes out. No SQL is
 * written here (it calls db.ts's runPhaseExtents/runSpendSplit rollups), no
 * HTTP/routing, no React, no writes, no view state. Counts, success rate, spend
 * totals, average duration, per-day spend, and blueprint usage are all DERIVED
 * IN JS from the two db rollups (no SQL AVG, matching the repo-wide "durations
 * are derived" convention):
 *   - runPhaseExtents: per-run status/blueprint/start + MIN/MAX phase extent
 *   - runSpendSplit: per-run reported-vs-estimated spend, from the spend EVENTS
 *     (phases.spend_usd lags after crash recovery)
 * `queued_count` comes from pool.position(r.id) — the SAME in-memory source
 * apiListRuns uses (queued is a pool state, not a DB status).
 */
import type { Database } from "bun:sqlite";

import { runPhaseExtents, runSpendSplit } from "../repository/db.ts";
import type { RunStats } from "../contract.ts";
import type { RunPool } from "../engine/pool.ts";

export function buildRunStats(db: Database, pool: RunPool): RunStats {
  const extents = runPhaseExtents(db);
  const spendByRun = new Map(runSpendSplit(db).map((s) => [s.run_id, s]));

  const status_counts: Record<string, number> = {};
  let successCount = 0;
  let failedCount = 0;
  let queued_count = 0;
  let reported_usd = 0;
  let estimated_usd = 0;
  const durations: number[] = [];
  const dayBuckets = new Map<string, { reported_usd: number; estimated_usd: number }>();
  const blueprintCounts = new Map<string, number>();

  for (const r of extents) {
    // status_counts keyed by RAW runs.status; queued is tracked separately
    status_counts[r.status] = (status_counts[r.status] ?? 0) + 1;
    if (r.status === "success") successCount += 1;
    if (r.status === "failed") failedCount += 1;
    if (pool.position(r.id) !== null) queued_count += 1;

    const split = spendByRun.get(r.id);
    const rep = split?.reported_usd ?? 0;
    const est = split?.estimated_usd ?? 0;
    reported_usd += rep;
    estimated_usd += est;

    // spend_by_day: bucket by the RUN's start date (UTC), not the spend
    // event ts — the ISO-8601 string is already UTC, so the date is its
    // first 10 chars
    const day = r.started_at.slice(0, 10);
    const bucket = dayBuckets.get(day) ?? { reported_usd: 0, estimated_usd: 0 };
    bucket.reported_usd += rep;
    bucket.estimated_usd += est;
    dayBuckets.set(day, bucket);

    blueprintCounts.set(r.blueprint, (blueprintCounts.get(r.blueprint) ?? 0) + 1);

    // avg duration KPI: TERMINAL runs only, phase-extent with NO `|| now`
    // (a live run must not pollute the average). A terminal run with no
    // measurable extent (no phases, or only pending/skipped phases) drops
    // out — MIN/MAX are null there.
    if (r.status === "success" || r.status === "failed") {
      if (r.min_phase_started_at !== null && r.max_phase_ended_at !== null) {
        durations.push(Date.parse(r.max_phase_ended_at) - Date.parse(r.min_phase_started_at));
      }
    }
  }

  // success_rate: success ÷ (success + failed) only — interrupted is NOT in
  // the denominator; null when there are zero terminal runs
  const terminalCount = successCount + failedCount;
  const success_rate = terminalCount === 0 ? null : successCount / terminalCount;
  const avg_duration_ms =
    durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length;

  const spend_by_day = [...dayBuckets.entries()]
    .map(([day, v]) => ({ day, reported_usd: v.reported_usd, estimated_usd: v.estimated_usd }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const blueprints = [...blueprintCounts.entries()]
    .map(([blueprint, runs]) => ({ blueprint, runs }))
    .sort((a, b) => b.runs - a.runs);

  return {
    runs_count: extents.length,
    status_counts,
    queued_count,
    success_rate,
    reported_usd,
    estimated_usd,
    avg_duration_ms,
    spend_by_day,
    blueprints,
  };
}
