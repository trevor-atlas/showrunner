/**
 * The run-list view-model — the ONE owner of the landing-table row assembly
 * (#54). `buildRunList` produces the `{ runs: RunListItem[] }` shape the
 * /api/runs endpoint used to derive inline, from two persistence handles: a
 * SQLite connection and the run pool.
 *
 * PURE data assembly — ids + handles in, serializable shapes out. No SQL is
 * written here (it calls db.ts's listRuns/runPhaseExtents/phaseStatusCounts
 * readers), no HTTP/routing, no React, no writes, no view state. Each row is
 * the listRuns row (RunRow + spend_usd) merged with:
 *   - phase_counts: phaseStatusCounts(db, r.id) — { total, <status>: n, ... }
 *   - min/max_phase_started/ended_at: from the runPhaseExtents rollup (the SAME
 *     MIN/MAX aggregation the stats endpoint uses for durations, keyed by id),
 *     so the run-list duration column derives from one aggregation, not a
 *     duplicated per-run extent query
 *   - queue_position: pool.position(r.id) — the 1-based spawn-queue position for
 *     pool-queued runs, null when not queued (queued is a pool state, not a DB
 *     status)
 */
import type { Database } from "bun:sqlite";

import { listRuns, phaseStatusCounts, runPhaseExtents } from "../repository/db.ts";
import type { RunListItem } from "../contract.ts";
import type { RunPool } from "../engine/pool.ts";

export function buildRunList(db: Database, pool: RunPool): { runs: RunListItem[] } {
  // Reuse the runPhaseExtents rollup (the stats endpoint's duration source):
  // one MIN(started)/MAX(ended) row per run, keyed by id, merged onto each
  // list item so the run-list duration column derives from the SAME
  // aggregation instead of a duplicated per-run extent query.
  const extents = new Map(runPhaseExtents(db).map((e) => [e.id, e]));
  const runs = listRuns(db).map((r) => {
    const extent = extents.get(r.id);
    return {
      ...r,
      phase_counts: phaseStatusCounts(db, r.id),
      // queue position (F2 from the T01b review): 1-based spawn-queue
      // position for pool-queued runs, null when not queued
      queue_position: pool.position(r.id),
      min_phase_started_at: extent?.min_phase_started_at ?? null,
      max_phase_ended_at: extent?.max_phase_ended_at ?? null,
    };
  });
  return { runs };
}
