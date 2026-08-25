import { join } from "node:path";

import {
  cursorEvents,
  getPhaseByName,
  getRun,
  listEnvelopes,
  listGateResults,
  listRuns,
} from "../repository/db.ts";
import {
  ApiError,
  type DaemonStatus,
  type EventsPage,
  type PhaseEnvelopes,
  type PhaseGates,
  type PhaseOutputs,
  type RawTail,
  type RunDetail,
  type RunListItem,
  type RunStats,
  type SpendBreakdown,
  type TimelineView,
} from "../contract.ts";
import { readOutputsDir } from "../repository/workspace/index.ts";
import { tailRawFile } from "../repository/rawfile.ts";
import { buildRunList } from "./run-list.ts";
import { buildRunStats } from "./run-stats.ts";
import {
  buildRunDetail,
  buildSpendBreakdown,
  buildTimeline,
} from "./run-detail.ts";
import type { ApiState } from "../transport/state.ts";

/**
 * The query (read) verbs of the daemon's local HTTP API: health, status, the
 * runs list (with phase counts), run detail, per-phase reads (envelopes,
 * gates, outputs), spend, timeline, the events cursor, and the raw tail. The
 * per-endpoint core functions are exported so the UI actions can call them
 * in-process too; they throw {@link ApiError} with the wire status codes (404
 * missing run/phase). The control/mutation verbs live in ./control.ts and the
 * wire dispatcher lives in ../transport/http.ts.
 */

/** The events-page size and the sweep batch — exported so the UI's
 * events proxy imports the same constant (no re-declared 500 in the
 * controller). The daemon caps the cursor query at this; the detail
 * sweep batches this per page. sweepRunEvents' default in db.ts is the
 * same 500 (db.ts cannot import server.ts, so the value lives in both). */
export const MAX_EVENTS_LIMIT = 500;

function intParam(v: string | null, fallback: number, max: number): number {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

// ── per-endpoint core functions (exported: the UI actions call these
// in-process; handleApiRequest wires them to the wire) ────────────────────────

export function apiHealth(_state: ApiState): { ok: true } {
  return { ok: true };
}

export function apiStatus(state: ApiState): DaemonStatus {
  // status verb (T07): health + pool utilization + run status counts
  const runs = listRuns(state.db);
  const byStatus: Record<string, number> = { total: runs.length };
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    ok: true,
    pid: process.pid,
    data_dir: state.dataDir,
    uptime_ms: Date.now() - state.startedAt,
    pool: { slots: state.pool.slots, running: state.pool.runningIds, queued: state.pool.queuedIds },
    runs: byStatus,
  };
}

/**
 * GET /api/stats — the all-time landing KPI/chart aggregate. A protocol
 * adapter: it hands the db + pool to the run-stats view-model (the sole owner
 * of the derivation) and serves the result. See view-models/run-stats.ts.
 */
export function apiStats(state: ApiState): RunStats {
  return buildRunStats(state.db, state.pool);
}

/**
 * GET /api/runs — the landing-table rows, each with phase counts, phase
 * extent, and queue position. A protocol adapter: it hands the db + pool to
 * the run-list view-model (the sole owner of the assembly) and serves the
 * result. See view-models/run-list.ts.
 */
export function apiListRuns(state: ApiState): { runs: RunListItem[] } {
  return buildRunList(state.db, state.pool);
}

export function apiRunDetail(state: ApiState, runId: string, query?: URLSearchParams): RunDetail {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  // ?full=1 (the UI's initial SSR load) rides the event sweep on the detail
  // call — the flag is a query-param parse; the assembly lives in the model
  return buildRunDetail(state.db, run, { full: query?.get("full") === "1" });
}

// per-phase spend breakdown (+ estimated markers + exact token totals).
export function apiSpend(state: ApiState, runId: string): SpendBreakdown {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  return buildSpendBreakdown(state.db, run);
}

/**
 * GET /runs/:id/timeline (R3) — per-visit segments folded from the run's
 * phase_start/phase_end events, in blueprint order. 404 when the run is
 * missing (apiSpend's semantics). Returns the TimelineView contract; the
 * model's buildTimeline calls buildTimelineView (kept in daemon/timeline.ts).
 */
export function apiTimeline(state: ApiState, runId: string): TimelineView {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  return buildTimeline(state.db, state.dataDir, run);
}

/** Resolve a run's phase by name; 404 when the run or the phase does not
 * exist — the phase-scoped read endpoints rely on these semantics. */
function requirePhaseOrThrow(state: ApiState, runId: string, phaseName: string): import("../repository/db.ts").PhaseRow {
  if (!getRun(state.db, runId)) {
    throw new ApiError(404, `run ${runId} not found`);
  }
  const phase = getPhaseByName(state.db, runId, phaseName);
  if (phase === null) {
    throw new ApiError(404, `phase "${phaseName}" not found in run ${runId}`);
  }
  return phase;
}

// ── phase-scoped read endpoints (envelope history, gate results). ──────

export function apiPhaseEnvelopes(state: ApiState, runId: string, phaseName: string): PhaseEnvelopes {
  const phase = requirePhaseOrThrow(state, runId, phaseName);
  // envelope history for a phase: ALL attempts (valid and rejected,
  // per T03's model), ordered visit → attempt
  return {
    run_id: runId,
    phase: phase.name,
    phase_id: phase.id,
    envelopes: listEnvelopes(state.db, runId, phase.id),
  };
}

export function apiPhaseGates(state: ApiState, runId: string, phaseName: string): PhaseGates {
  const phase = requirePhaseOrThrow(state, runId, phaseName);
  // gate results incl. overridden: each row carries the override
  // badge (who + why + when) when the original row was overridden — the
  // original pass stays 0, the audit trail is the point
  return {
    run_id: runId,
    phase: phase.name,
    phase_id: phase.id,
    gates: listGateResults(state.db, runId, phase.id),
  };
}

/** GET /runs/:id/phases/:phase/outputs — what the agent actually wrote in
 * the phase's outputs dir (files + FINDINGS.md content). Same 404
 * semantics as the envelope/gate phase-scoped reads; reads the run's
 * record dir only — the daemon stays the sole SQLite writer, and the UI
 * lost its last fs path past the seam. */
export function apiPhaseOutputs(state: ApiState, runId: string, phaseName: string): PhaseOutputs {
  const phase = requirePhaseOrThrow(state, runId, phaseName);
  const outputs = readOutputsDir(join(state.dataDir, "runs", runId), phase.name);
  return {
    run_id: runId,
    phase: phase.name,
    phase_id: phase.id,
    files: outputs.files,
    findings_md: outputs.findingsMd,
  };
}

export function apiEvents(state: ApiState, runId: string, query: URLSearchParams): EventsPage {
  if (!getRun(state.db, runId)) throw new ApiError(404, `run ${runId} not found`);
  const cursor = intParam(query.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
  // the page default/cap is MAX_EVENTS_LIMIT — the same batch the
  // ?full=1 detail sweep uses (and sweepRunEvents' default in db.ts)
  const limit = intParam(query.get("limit"), MAX_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
  const events = cursorEvents(state.db, runId, cursor, limit);
  const nextCursor = events.length > 0 ? events[events.length - 1]!.id : cursor;
  return { events, next_cursor: nextCursor };
}

export function apiRaw(state: ApiState, runId: string, query: URLSearchParams): RawTail {
  if (!getRun(state.db, runId)) throw new ApiError(404, `run ${runId} not found`);
  // tail semantics: ?lines=N (alias: ?n=) returns the LAST N raw
  // output lines (default 200, capped 5000) — the drill-in feed into the
  // byte-identical raw record. line_count is the FULL line count;
  // truncated reports whether the tail dropped earlier lines.
  const linesParam = query.get("lines") ?? query.get("n");
  const n = intParam(linesParam, 200, 5000);
  const tail = tailRawFile(join(state.dataDir, "runs", runId, "raw_output.jsonl"), n);
  return { ...tail, run_id: runId };
}
