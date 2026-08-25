/**
 * The run-detail view-model — the ONE owner of the run drill-in reads (#55):
 * `buildRunDetail` (GET /runs/:id), `buildSpendBreakdown` (GET /runs/:id/spend),
 * and `buildTimeline` (GET /runs/:id/timeline). The apiRunDetail / apiSpend /
 * apiTimeline endpoints used to derive these shapes inline; they now delegate
 * here (the 404 check stays with the caller — like buildTimelineView).
 *
 * PURE data assembly — a db handle + the already-fetched run in, serializable
 * shapes out. No SQL is written here (it calls db.ts readers: listPhaseSpend,
 * sumRunSpend, envelopeCount, listAgentSessions, eventCount, cursorEvents,
 * sumSpendTokenTotals), no HTTP/routing, no React, no writes, no view state.
 *
 * The timeline fold stays in daemon/timeline.ts (buildTimelineView) — the
 * model CALLS it (buildTimeline is the model's entry point; the derivation
 * lives in the one tested place it always has).
 */
import type { Database } from "bun:sqlite";

import type { EventRow } from "../../core/index.ts";
import {
  cursorEvents,
  envelopeCount,
  eventCount,
  listAgentSessions,
  listPhaseSpend,
  sumRunSpend,
  sumSpendTokenTotals,
} from "../repository/db.ts";
import type { RunRow } from "../repository/db.ts";
import type { RunDetail, SpendBreakdown, TimelineView } from "../contract.ts";
import { buildTimelineView } from "./timeline.ts";

/** Per-page sweep batch — mirrors server.ts's exported MAX_EVENTS_LIMIT and
 * db.ts's sweepRunEvents default (both 500). View-models cannot import from
 * server.ts (layering), so the value is mirrored here as it is in db.ts; the
 * endpoint may override it via opts.sweepBatch. */
const SWEEP_BATCH = 500;

/** Safety cap on the ?full=1 detail sweep: 20 × 500 = 10k events. */
const MAX_EVENT_PAGES = 20;

export interface RunDetailOptions {
  /** ?full=1 — the initial SSR sweep rides the detail call (the UI reads
   * detail.events / detail.next_cursor instead of re-implementing the sweep). */
  full?: boolean;
  /** per-page sweep batch; defaults to SWEEP_BATCH (the endpoint's
   * MAX_EVENTS_LIMIT). Exists so the loop is testable without 500+ events. */
  sweepBatch?: number;
}

export function buildRunDetail(db: Database, run: RunRow, opts: RunDetailOptions = {}): RunDetail {
  // spend splits reported vs estimated — the estimated half comes
  // from the spend events' flag, so show can mark it as such
  const phaseSpend = listPhaseSpend(db, run.id);
  const detail: RunDetail = {
    run,
    spend_usd: sumRunSpend(db, run.id),
    estimated_spend_usd: phaseSpend.reduce((a, r) => a + r.estimated_spend_usd, 0),
    // envelope count (accepted/attempt rows for the run)
    envelope_count: envelopeCount(db, run.id),
    phases: phaseSpend,
    sessions: listAgentSessions(db, run.id),
    event_count: eventCount(db, run.id),
  };
  // ?full=1: the initial SSR sweep rides the detail call — the UI reads
  // detail.events/detail.next_cursor instead of re-implementing the sweep
  // (the flagless shape is unchanged; CLI callers never pass ?full=1)
  if (opts.full) {
    const sweep = sweepEvents(db, run.id, opts.sweepBatch ?? SWEEP_BATCH);
    detail.events = sweep.events;
    detail.next_cursor = sweep.cursor;
  }
  return detail;
}

// per-phase spend breakdown (+ estimated markers + exact token totals).
export function buildSpendBreakdown(db: Database, run: RunRow): SpendBreakdown {
  const phaseSpend = listPhaseSpend(db, run.id);
  const tokenTotals = sumSpendTokenTotals(db, run.id);
  return {
    run_id: run.id,
    spend_usd: sumRunSpend(db, run.id),
    estimated_spend_usd: phaseSpend.reduce((a, r) => a + r.estimated_spend_usd, 0),
    // the wire shape is exactly these keys — the field pick stays here
    // (listPhaseSpend returns the full row; the contract pins the shape).
    // Token totals come from the SUM map — SQL SUM is exact, so there is
    // no sweep cap and no truncated flag on the wire
    phases: phaseSpend.map(({ id, name, status, spend_usd, estimated_spend_usd }) => {
      const tokens = tokenTotals.get(id);
      return {
        id,
        name,
        status,
        spend_usd,
        estimated_spend_usd,
        tokens_in: tokens?.tokens_in ?? 0,
        tokens_out: tokens?.tokens_out ?? 0,
        cache_read: tokens?.cache_read ?? 0,
        cache_write: tokens?.cache_write ?? 0,
      };
    }),
  };
}

/** GET /runs/:id/timeline — the model's timeline entry point: it CALLS
 * buildTimelineView (the fold stays in daemon/timeline.ts). The 404 check
 * stays with the caller (apiTimeline). */
export function buildTimeline(db: Database, dataDir: string, run: RunRow): TimelineView {
  return buildTimelineView(db, dataDir, run);
}

/** Sweep the cursor query from 0 to the tail — a run's full event history
 * in rowid order, `batch` per page, capped at `maxPages` pages (default 20 =
 * 10k events — the ?full=1 detail sweep; the timeline's own sweep in db.ts
 * stays uncapped). Reproduces the old UI collectEvents loop exactly: a short
 * page is the tail (cursor = its last rowid, or the requested cursor when
 * empty); a full final page still advances. Returns { events, cursor } — the
 * wire gets events + next_cursor. */
function sweepEvents(
  db: Database,
  runId: string,
  batch: number,
  maxPages = MAX_EVENT_PAGES,
): { events: EventRow[]; cursor: number } {
  const events: EventRow[] = [];
  let cursor = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = cursorEvents(db, runId, cursor, batch);
    events.push(...res);
    if (res.length < batch) {
      if (res.length > 0) cursor = res[res.length - 1]!.id;
      break;
    }
    cursor = res[res.length - 1]!.id;
  }
  return { events, cursor };
}
