import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFixtureName } from "./pi/harness/fixtures.ts";

import {
  runDirFor,
  type EventRow,
  type PhaseStartCause,
  type PhaseStatus,
  type RunStatus,
} from "../core/index.ts";

import {
  cursorEvents,
  envelopeCount,
  eventCount,
  getPhaseByName,
  getRun,
  listAgentSessions,
  listEnvelopes,
  listGateResults,
  listPhases,
  listRuns,
  sumEstimatedPhaseSpend,
  sumRunSpend,
} from "./db.ts";
import type { PhaseRow, RunRow } from "./db.ts";
import {
  ApiError,
  type ControlResult,
  type DaemonStatus,
  type EventsPage,
  type PauseView,
  type PhaseEnvelopes,
  type PhaseGates,
  type RawTail,
  type RunDetail,
  type RunListItem,
  type SpendBreakdown,
  type TimelineSegment,
  type TimelineView,
} from "./contract.ts";
import { submitFixture } from "./driver.ts";
import type { SubmitOptions, SubmittedRun } from "./driver.ts";
import {
  effectiveMenu,
  getControl,
  getControlByLiveSession,
  statelessFailRun,
} from "./pause-control.ts";
import type { PauseInfo, RunControl } from "./pause-control.ts";
import type { RunPool } from "./pool.ts";
import { tailRawFile } from "./rawfile.ts";
import { drivePreparedRun, driveResumedRun, prepareBlueprintRun, prepareResume } from "./runner.ts";

/**
 * The daemon's local HTTP API — the slice the CLI needs: health,
 * submit (fixture or blueprint module), runs list (with phase counts), run
 * detail, the events cursor, and the raw tail, plus the T04 control
 * surface (steer / pause-view / approve / fail / resume / override /
 * restart-fresh).
 *
 * The merged web server (src/daemon/web.ts) dispatches every `/api/*` request
 * here, in-process, WITHOUT going through remix — the daemon keeps serving
 * the JSON API even while the dashboard's router import is slow. The per-
 * endpoint core functions below are exported so the UI actions can call them
 * in-process too (T4); they throw {@link ApiError} with the wire status codes
 * (404 missing run/phase, 409 control conflicts, 400 bad body, 201 submit).
 *
 * Serves on the daemon's single TCP listener (default 127.0.0.1:44100).
 */

export interface ApiState {
  db: Database;
  dataDir: string;
  /** pool — owned by the caller (hoisted out of the server) */
  pool: RunPool;
  startedAt: number;
}

const MAX_EVENTS_LIMIT = 500;

// The one error class lives in contract.ts (shared with client.ts and
// the UI); re-exported so daemon/index.ts's public surface keeps working.
export { ApiError };

function intParam(v: string | null, fallback: number, max: number): number {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/** Read a JSON object body. Empty bodies resolve to {}; invalid JSON → 400. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 1024 * 1024) {
    throw new ApiError(400, "request body too large");
  }
  const text = await request.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ApiError(400, `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Control verbs tolerate a missing/empty body (empty → {}). */
async function readBodyLenient(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readBody(request);
  } catch {
    return {};
  }
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

export function apiListRuns(state: ApiState): { runs: RunListItem[] } {
  const runs = listRuns(state.db).map((r) => ({
    ...r,
    phase_counts: phaseStatusCounts(state.db, r.id),
    // queue position (F2 from the T01b review): 1-based spawn-queue
    // position for pool-queued runs, null when not queued
    queue_position: state.pool.position(r.id),
  }));
  return { runs };
}

export async function apiSubmitRun(state: ApiState, body: Record<string, unknown>): Promise<{
  run_id: string;
  fixture?: string;
  blueprint?: string;
  phase_id?: string;
  agent_session_id?: string;
  queue_position: number | null;
}> {
  const fixture = body.fixture;
  if (isFixtureName(fixture)) {
    const opts: SubmitOptions = { fixture };
    if (typeof body.cwd === "string" && body.cwd !== "") opts.cwd = body.cwd;
    if (typeof body.delayMs === "number" && Number.isFinite(body.delayMs)) {
      opts.delayMs = Math.max(0, Math.floor(body.delayMs));
    }
    if (typeof body.agent === "string" && body.agent !== "") opts.agent = body.agent;
    if (typeof body.model === "string" && body.model !== "") opts.model = body.model;
    if (typeof body.phase === "string" && body.phase !== "") opts.phase = body.phase;
    const sub: SubmittedRun = submitFixture(state.db, state.dataDir, opts);
    return {
      run_id: sub.run_id,
      phase_id: sub.phase_id,
      agent_session_id: sub.agent_session_id,
      fixture,
      // observation fixtures spawn immediately — never pool-queued
      queue_position: null,
    };
  }

  // blueprint module: import + validate + snapshot at submit, then
  // drive behind the pool
  const blueprintPath = body.blueprint;
  if (typeof blueprintPath === "string" && blueprintPath !== "") {
    // `args?`: opaque per-submit arguments, recorded in the
    // snapshot (the run record is the snapshot — later edits to the
    // blueprint do not change an in-flight run)
    const args = body.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
      throw new ApiError(400, "args must be an array of strings");
    }
    let prepared;
    try {
      prepared = await prepareBlueprintRun(state.db, state.dataDir, {
        modulePath: blueprintPath,
        cwd: typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : undefined,
        args: args as string[] | undefined,
      });
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    const delayMs =
      typeof body.delayMs === "number" && Number.isFinite(body.delayMs)
        ? Math.max(0, Math.floor(body.delayMs))
        : 0;
    state.pool.enqueue(prepared.runId, () => {
      try {
        const run = drivePreparedRun(state.db, state.dataDir, prepared, { delayMs });
        // F1: a paused run KEEPS its pool slot (cheap — no pi process
        // alive while paused); the slot frees only at a TERMINAL state
        void run.terminal.finally(() => state.pool.release(prepared.runId));
      } catch {
        // synchronous failure: surface it on the run row, free the slot
        state.pool.release(prepared.runId);
      }
    });
    // queue position in the submit response: null when a free slot
    // already started it, else its 1-based place in line
    return {
      run_id: prepared.runId,
      blueprint: prepared.blueprint.name,
      queue_position: state.pool.position(prepared.runId),
    };
  }

  throw new ApiError(400, "request body must include a fixture name or a blueprint module path");
}

export function apiRunDetail(state: ApiState, runId: string): RunDetail {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  // spend splits reported vs estimated — the estimated half comes
  // from the spend events' flag, so show can mark it as such
  const estimatedByPhase = sumEstimatedPhaseSpend(state.db, runId);
  let estimatedSpend = 0;
  for (const s of estimatedByPhase.values()) estimatedSpend += s;
  return {
    run,
    spend_usd: sumRunSpend(state.db, runId),
    estimated_spend_usd: estimatedSpend,
    // envelope count (accepted/attempt rows for the run)
    envelope_count: envelopeCount(state.db, runId),
    phases: listPhases(state.db, runId).map((p) => ({ ...p, estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0 })),
    sessions: listAgentSessions(state.db, runId),
    event_count: eventCount(state.db, runId),
  };
}

// per-phase spend breakdown (+ estimated markers).
export function apiSpend(state: ApiState, runId: string): SpendBreakdown {
  if (!getRun(state.db, runId)) throw new ApiError(404, `run ${runId} not found`);
  const estimatedByPhase = sumEstimatedPhaseSpend(state.db, runId);
  let estimatedSpend = 0;
  for (const s of estimatedByPhase.values()) estimatedSpend += s;
  return {
    run_id: runId,
    spend_usd: sumRunSpend(state.db, runId),
    estimated_spend_usd: estimatedSpend,
    phases: listPhases(state.db, runId).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      spend_usd: p.spend_usd,
      estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0,
    })),
  };
}

// ── R3: the timeline view (GET /runs/:id/timeline) — per-visit segments ─────
// The server derives the segments by folding the run's phase_start/phase_end
// events (the derivation lives in ONE tested place instead of in every
// client). The wire shapes (TimelineView et al.) live in contract.ts — the
// server builds the same shape without importing the client (layering, like
// apiRunDetail).

/** The event payload slices the fold reads (rows are zod-validated at insert). */
interface PhaseStartPayload {
  phase: string;
  agent: string;
  visit: number;
  budget: number;
  cause?: PhaseStartCause;
}
interface PhaseEndPayload {
  phase: string;
  status: string;
  visits: number;
  corrections: number;
  spend_usd: number;
}
interface CorrectionPayload {
  phase: string;
  visit: number;
}

/**
 * GET /runs/:id/timeline (R3) — per-visit segments folded from the run's
 * phase_start/phase_end events, in blueprint order. 404 when the run is
 * missing (apiSpend's semantics). Returns the TimelineView contract.
 */
export function apiTimeline(state: ApiState, runId: string): TimelineView {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);

  const events = collectTimelineEvents(state.db, runId);
  // R7 (envelope_attempts): the `envelope` EVENT fires only on ACCEPTANCE
  // — a gate-rejected visit emits none, so event-counting would report 0 for
  // a visit that really attempted. The per-attempt record is the `envelopes`
  // TABLE (one row per attempt, valid or rejected — the same source the phase
  // drill-in's attempt list reads). The fold derives each segment's
  // envelope_attempts from those ROWS per (phase_id, visit).
  const segmentsByPhase = foldPhaseSegments(run, events, countEnvelopeAttempts(state.db, runId));
  const ordered = orderTimelinePhases(
    listPhases(state.db, runId),
    events,
    readBlueprintPhaseNames(state.dataDir, runId),
  );
  const estimatedByPhase = sumEstimatedPhaseSpend(state.db, runId);

  return {
    run_id: runId,
    blueprint: run.blueprint,
    // the runs table stores only validated statuses (single-writer daemon) —
    // the narrow cast to the contract's RunStatus/PhaseStatus is honest
    status: run.status as RunStatus,
    needs_review: run.needs_review !== 0,
    started_at: run.started_at,
    ended_at: run.ended_at,
    phases: ordered.map((p) => ({
      phase_id: p.id,
      name: p.name,
      agent: p.agent,
      status: p.status as PhaseStatus,
      visits: p.visits,
      budget: p.budget,
      spend_usd: p.spend_usd,
      estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0,
      segments: segmentsByPhase.get(p.id) ?? [],
    })),
  };
}

/** Sweep the cursor query from the start — the full event history, in
 * rowid order, batched 500 at a time (the one indexed read transport). */
function collectTimelineEvents(db: Database, runId: string): EventRow[] {
  const all: EventRow[] = [];
  let after = 0;
  for (;;) {
    const page = cursorEvents(db, runId, after, MAX_EVENTS_LIMIT);
    all.push(...page);
    if (page.length < MAX_EVENTS_LIMIT) break;
    after = page[page.length - 1]!.id;
  }
  return all;
}

/** Per-(phase_id, visit) attempt counts from the `envelopes` table — one row
 * per attempt (valid=1 parsed-and-processed, valid=0 zod-rejected or
 * unreadable), in visit → attempt order (listEnvelopes). The timeline's
 * envelope_attempts counts these ROWS, not `envelope` events (which
 * fire only on acceptance) — a gate-rejected visit still reports its
 * attempts (R7). */
function countEnvelopeAttempts(db: Database, runId: string): Map<string, Map<number, number>> {
  const counts = new Map<string, Map<number, number>>();
  for (const env of listEnvelopes(db, runId)) {
    let byVisit = counts.get(env.phase_id);
    if (byVisit === undefined) {
      byVisit = new Map<number, number>();
      counts.set(env.phase_id, byVisit);
    }
    byVisit.set(env.visit, (byVisit.get(env.visit) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fold a run's events into per-phase visit segments (R3 derivation rules 1–4):
 *
 * Rule 1 — each phase_start (payload `visit`) pairs with the NEXT phase_end
 * for the same phase_id; the phase_end payload's status is the segment's
 * outcome. Segments are per-phase in rowid order (visits ascend). A redrive
 * from a blocked pause re-enters the visit loop with a NEW visit and emits
 * NO phase_end for the blocked one — the blocked visit stays an open segment
 * (rule 2) exactly as the start/end pairing prescribes.
 *
 * The resume fold: a run resumed from `interrupted` re-visits the
 * RECORDED visit number, so the log can hold TWO phase_start events with the
 * same visit (the crashed visit's start, then the resumed visit's start) and
 * ONE phase_end. A naive "each start pairs with the next end" would render a
 * phantom open segment. When a phase_start arrives for a phase that already
 * has an OPEN segment with the SAME visit, fold it into that segment — keep
 * the ORIGINAL started_at and the FIRST start's cause — instead of opening a
 * duplicate. This preserves rule 1 for the common case and collapses the
 * resume case to one segment per visit.
 *
 * Rules 3/4 — correction EVENTS are attributed to the segment whose VISIT
 * matches (phase_id from the event row, visit from the payload); the
 * segment's envelope_attempts is NOT event-derived — it counts the
 * `envelopes` TABLE rows for that (phase_id, visit) (the envelope
 * event fires only on acceptance, so event-counting would miss rejected
 * visits — R7). `cause` is copied verbatim from the phase_start payload
 * (null when absent — pre-R2 rows are never reconstructed heuristically).
 *
 * Rule 2 is applied AFTER the fold: open segments (no following phase_end)
 * read in_progress while the run is running/paused, interrupted once the run
 * is over (status interrupted, or ended_at set).
 */
function foldPhaseSegments(
  run: RunRow,
  events: readonly EventRow[],
  envelopeAttempts: Map<string, Map<number, number>>,
): Map<string, TimelineSegment[]> {
  const segments = new Map<string, TimelineSegment[]>();
  for (const ev of events) {
    const phaseId = ev.phase_id;
    if (phaseId === null) continue;
    const segs = segments.get(phaseId);
    const last = segs !== undefined ? segs[segs.length - 1] : undefined;
    switch (ev.type) {
      case "phase_start": {
        const data = ev.data as Partial<PhaseStartPayload>;
        const visit = data.visit ?? 0;
        if (last !== undefined && last.ended_at === null && last.visit === visit) {
          // resume fold — same visit, prior segment still open; keep the
          // original started_at and the FIRST start's cause (rule: no dup)
          break;
        }
        const list = segs ?? [];
        list.push({
          visit,
          started_at: ev.ts,
          ended_at: null,
          outcome: "in_progress",
          corrections: 0,
          envelope_attempts: 0,
          cause: data.cause ?? null,
        });
        segments.set(phaseId, list);
        break;
      }
      case "phase_end": {
        if (last !== undefined && last.ended_at === null) {
          last.ended_at = ev.ts;
          last.outcome = phaseEndOutcome((ev.data as Partial<PhaseEndPayload>).status);
        }
        // a dangling phase_end (no open segment) produces nothing — rule 1
        // pairs starts with ends, never ends alone
        break;
      }
      case "correction": {
        const seg = segmentForVisit(segs, (ev.data as Partial<CorrectionPayload>).visit);
        if (seg !== undefined) seg.corrections += 1;
        break;
      }
    }
  }

  // R7 (envelope_attempts): fold the envelopes-table counts into the segments
  // per (phase_id, visit) — rows exist for EVERY attempt (valid or rejected),
  // where the `envelope` event exists only on acceptance. Corrections
  // stay event-derived above (correction events fire per correction).
  for (const [phaseId, segs] of segments) {
    const byVisit = envelopeAttempts.get(phaseId);
    if (byVisit === undefined) continue;
    for (const seg of segs) {
      seg.envelope_attempts = byVisit.get(seg.visit) ?? 0;
    }
  }

  // Rule 2: open segments read in_progress or interrupted depending on the run
  const runOver = run.status === "interrupted" || run.ended_at !== null;
  for (const segs of segments.values()) {
    for (const seg of segs) {
      if (seg.ended_at === null) seg.outcome = runOver ? "interrupted" : "in_progress";
    }
  }
  return segments;
}

/** The last segment of a phase whose visit matches (visits ascend per phase). */
function segmentForVisit(
  segs: readonly TimelineSegment[] | undefined,
  visit: number | undefined,
): TimelineSegment | undefined {
  if (segs === undefined || visit === undefined) return undefined;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i]!.visit === visit) return segs[i]!;
  }
  return undefined;
}

/** The segment outcome from a phase_end payload status (the runner writes
 * "success" | "failed"; anything unexpected reads as failed — a terminal
 * status that is not a pass). */
function phaseEndOutcome(status: string | undefined): TimelineSegment["outcome"] {
  if (status === "success" || status === "failed" || status === "skipped" || status === "interrupted") {
    return status;
  }
  return "failed";
}

/**
 * Blueprint-order the phase rows (R3: the endpoint returns blueprint order
 * itself, like the UI's orderPhases but without importing UI code).
 *
 * Preference order, mirroring orderPhases:
 *  1. the blueprint snapshot's phases (exact blueprint order); unknown
 *     detail phases append defensively in phases-row order;
 *  2. fallback (no snapshot — fixture/observation runs): phases that started,
 *     in FIRST phase_start event order, then the row's started_at, then the
 *     phases-row array order.
 *
 * Note the deliberate divergence from the UI helper's fallback: the UI sorts
 * by the LAST phase_start ts (a Map overwrite), which mis-orders a backward
 * on_fail jump (implement re-runs after review failed ⇒ review's last start
 * precedes implement's). First-start is the correct "when this phase entered
 * the run" order and agrees with the UI whenever it matters (sequential runs).
 */
function orderTimelinePhases(
  phases: readonly PhaseRow[],
  events: readonly EventRow[],
  blueprintOrder: readonly string[] | null,
): PhaseRow[] {
  if (blueprintOrder !== null && blueprintOrder.length > 0) {
    const byName = new Map<string, PhaseRow>();
    for (const phase of phases) byName.set(phase.name, phase);
    const ordered: PhaseRow[] = [];
    for (const name of blueprintOrder) {
      const phase = byName.get(name);
      if (phase !== undefined) {
        ordered.push(phase);
        byName.delete(name);
      }
    }
    // any detail phase the snapshot does not mention keeps its row order at
    // the end (the snapshot and the rows should agree)
    for (const phase of phases) {
      if (byName.has(phase.name)) ordered.push(phase);
    }
    return ordered;
  }

  const firstStart = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "phase_start") continue;
    const name =
      typeof ev.data === "object" && ev.data !== null ? (ev.data as { phase?: unknown }).phase : undefined;
    if (typeof name !== "string") continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || firstStart.has(name)) continue;
    firstStart.set(name, t);
  }

  return [...phases]
    .map((phase, index) => ({ phase, index }))
    .sort((a, b) => {
      const aStart = firstStart.get(a.phase.name) ?? rowStartTs(a.phase);
      const bStart = firstStart.get(b.phase.name) ?? rowStartTs(b.phase);
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ phase }) => phase);
}

function rowStartTs(phase: PhaseRow): number {
  if (phase.started_at === null) return Infinity;
  const t = Date.parse(phase.started_at);
  return Number.isFinite(t) ? t : Infinity;
}

/** The snapshot's phase names, in blueprint order, or null when the run
 * has no readable snapshot (fixture/observation runs, missing/corrupt file). */
function readBlueprintPhaseNames(dataDir: string, runId: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(join(runDirFor(dataDir, runId), "blueprint.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const phases = (parsed as { phases?: unknown }).phases;
    if (!Array.isArray(phases)) return null;
    const names: string[] = [];
    for (const phase of phases) {
      if (typeof phase === "object" && phase !== null && typeof (phase as { name?: unknown }).name === "string") {
        names.push((phase as { name: string }).name);
      }
    }
    return names;
  } catch {
    return null;
  }
}

/** Resolve a run's phase by name; 404 when the run or the phase does not
 * exist — the phase-scoped read endpoints rely on these semantics. */
function requirePhaseOrThrow(state: ApiState, runId: string, phaseName: string): import("./db.ts").PhaseRow {
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

export function apiEvents(state: ApiState, runId: string, query: URLSearchParams): EventsPage {
  if (!getRun(state.db, runId)) throw new ApiError(404, `run ${runId} not found`);
  const cursor = intParam(query.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
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

// ── T04 control surface (the pause viewer behind the CLI's
// `pause` verb). Every control verb writes a human_action event; each
// surfaces the resulting run state. The control handle is the daemon's
// in-process registry — a paused run after a daemon restart has none, and
// those verbs answer 409 (the continuation surface is T07/T08). ───────────────

export function apiPause(state: ApiState, runId: string): PauseView {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const control = getControl(runId);
  // a paused run without a control handle (daemon restarted) is still PAUSED —
  // the viewer reports the state, without the in-memory menu (T07/T08's surface)
  const paused = run.status === "paused";
  if (paused && control !== null && control.paused) {
    const info = control.pauseInfo!;
    return {
      run_id: runId,
      paused: true,
      status: run.status,
      kind: info.kind,
      phase: info.phase,
      reason: info.reason,
      actions: effectiveMenu(info),
      queued_steers: control.queuedSteerMessages,
      live_session_id: control.liveSessionId,
    };
  }
  return {
    run_id: runId,
    paused,
    status: run.status,
    reason: lastRunStatusReason(state.db, runId),
    actions: [],
    ...(paused
      ? { note: "paused, but the daemon has no control handle for it (restarted?) — the continuation surface is T07" }
      : {}),
  };
}

export function apiSteerRun(state: ApiState, runId: string, body: Record<string, unknown>): ControlResult {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const control = getControl(runId);
  if (control === null) {
    throw new ApiError(
      409,
      `run ${runId} has no active control handle (status ${run.status}) — steer needs a live daemon`,
    );
  }
  try {
    const message = typeof body.message === "string" ? body.message : "";
    const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
    control.steer(message, by);
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return {
    run_id: runId,
    ok: true,
    status: getRun(state.db, runId)!.status,
    queued_steers: control.queuedSteerCount,
    message: control.paused
      ? "steer recorded and queued — the run stays paused until a proceed action (delivery: T07 continuation)"
      : "steer sent to the live session (queued between turns)",
  };
}

export function apiSessionSteer(state: ApiState, piSessionId: string, body: Record<string, unknown>): ControlResult {
  const control = getControlByLiveSession(piSessionId);
  if (control === null) {
    throw new ApiError(409, `no live session ${piSessionId} on the daemon (a paused run has no live process)`);
  }
  try {
    const message = typeof body.message === "string" ? body.message : "";
    const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
    control.steer(message, by);
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return { run_id: control.runId, ok: true, status: "running" };
}

export function apiApprove(state: ApiState, runId: string, body: Record<string, unknown>): ControlResult {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const control = getControl(runId);
  if (control === null) {
    throw new ApiError(409, `run ${runId} has no active control handle (status ${run.status})`);
  }
  try {
    control.approve(typeof body.by === "string" && body.by !== "" ? body.by : undefined);
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return { run_id: runId, ok: true, status: getRun(state.db, runId)!.status };
}

export function apiFailRun(state: ApiState, runId: string, body: Record<string, unknown>): ControlResult {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
  const control = getControl(runId);
  try {
    if (control !== null) {
      control.fail(by); // the loop finalizes (kills the live child)
    } else {
      statelessFailRun(state.db, runId, by); // interrupted / restarted-daemon runs
    }
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return { run_id: runId, ok: true, status: getRun(state.db, runId)!.status };
}

export async function apiResume(state: ApiState, runId: string, body: Record<string, unknown>): Promise<ControlResult> {
  if (!getRun(state.db, runId)) {
    // 404 semantics: a missing run 404s before any resume logic
    throw new ApiError(404, `run ${runId} not found`);
  }
  const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
  const delayMs =
    typeof body.delayMs === "number" && Number.isFinite(body.delayMs)
      ? Math.max(0, Math.floor(body.delayMs))
      : 0;
  try {
    // continuation (T07): re-import the blueprint from the
    // snapshot, record the resume attempt + needs_review (T04 pin), and
    // relaunch the interrupted phase with the SAME --session-id + a
    // continue instruction — behind the pool, like a fresh run
    const preparedResume = await prepareResume(state.db, state.dataDir, runId, { by });
    state.pool.enqueue(runId, () => {
      try {
        const run = driveResumedRun(state.db, state.dataDir, preparedResume, { delayMs });
        // F1: the resumed run holds a slot until its TERMINAL state
        void run.terminal.finally(() => state.pool.release(runId));
      } catch {
        state.pool.release(runId);
      }
    });
    return { run_id: runId, ok: true, status: "running", needs_review: 1 };
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
}

function requirePausedControl(state: ApiState, runId: string, phase: string, verb: string): RunControl {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const control = getControl(runId);
  if (control === null || !control.paused) {
    throw new ApiError(409, `run ${runId} is not paused (status ${run.status}) — ${verb} is a pause-menu verb`);
  }
  const info: PauseInfo = control.pauseInfo!;
  if (info.phase !== phase) {
    throw new ApiError(409, `run ${runId} is paused on phase "${info.phase}", not "${phase}"`);
  }
  return control;
}

export function apiOverrideGate(state: ApiState, runId: string, phase: string, body: Record<string, unknown>): ControlResult {
  const control = requirePausedControl(state, runId, phase, "override");
  try {
    const gate = typeof body.gate === "string" && body.gate !== "" ? body.gate : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    control.overrideGate({
      gate,
      by: (typeof body.by === "string" && body.by !== "" ? body.by : undefined) ?? "cli",
      reason,
    });
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return { run_id: runId, ok: true, verb: "override", status: getRun(state.db, runId)!.status };
}

export function apiRestartFresh(state: ApiState, runId: string, phase: string, body: Record<string, unknown>): ControlResult {
  const control = requirePausedControl(state, runId, phase, "restart-fresh");
  try {
    control.restartFresh(typeof body.by === "string" && body.by !== "" ? body.by : undefined);
  } catch (err) {
    throw new ApiError(409, err instanceof Error ? err.message : String(err));
  }
  return { run_id: runId, ok: true, verb: "restart-fresh", status: getRun(state.db, runId)!.status };
}

// ── wire dispatcher: Request → Response (used by src/daemon/web.ts for every
// `/api/*` request; pure JS, no remix dependency) ─────────────────────────────

export async function handleApiRequest(state: ApiState, request: Request): Promise<Response> {
  const url = new URL(request.url, "http://127.0.0.1");
  const method = request.method ?? "GET";
  const path = url.pathname === "/api" ? "/" : url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;

  try {
    if (method === "GET" && path === "/health") return Response.json(apiHealth(state));
    if (method === "GET" && path === "/status") return Response.json(apiStatus(state));
    if (method === "GET" && path === "/runs") return Response.json(apiListRuns(state));
    if (method === "POST" && path === "/runs") {
      return Response.json(await apiSubmitRun(state, await readBody(request)), { status: 201 });
    }

    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") return Response.json(apiRunDetail(state, runMatch[1]!));

    const spendMatch = path.match(/^\/runs\/([^/]+)\/spend$/);
    if (spendMatch && method === "GET") return Response.json(apiSpend(state, spendMatch[1]!));

    const timelineMatch = path.match(/^\/runs\/([^/]+)\/timeline$/);
    if (timelineMatch && method === "GET") return Response.json(apiTimeline(state, timelineMatch[1]!));

    const phaseEnvelopesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/envelopes$/);
    if (phaseEnvelopesMatch && method === "GET") {
      return Response.json(
        apiPhaseEnvelopes(state, phaseEnvelopesMatch[1]!, decodeURIComponent(phaseEnvelopesMatch[2]!)),
      );
    }

    const phaseGatesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/gates$/);
    if (phaseGatesMatch && method === "GET") {
      return Response.json(apiPhaseGates(state, phaseGatesMatch[1]!, decodeURIComponent(phaseGatesMatch[2]!)));
    }

    const eventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
    if (eventsMatch && method === "GET") return Response.json(apiEvents(state, eventsMatch[1]!, url.searchParams));

    const rawMatch = path.match(/^\/runs\/([^/]+)\/raw$/);
    if (rawMatch && method === "GET") return Response.json(apiRaw(state, rawMatch[1]!, url.searchParams));

    const pauseMatch = path.match(/^\/runs\/([^/]+)\/pause$/);
    if (pauseMatch && method === "GET") return Response.json(apiPause(state, pauseMatch[1]!));

    const steerMatch = path.match(/^\/runs\/([^/]+)\/steer$/);
    if (steerMatch && method === "POST") {
      return Response.json(apiSteerRun(state, steerMatch[1]!, await readBodyLenient(request)));
    }

    const sessionSteerMatch = path.match(/^\/sessions\/([^/]+)\/steer$/);
    if (sessionSteerMatch && method === "POST") {
      return Response.json(apiSessionSteer(state, sessionSteerMatch[1]!, await readBodyLenient(request)));
    }

    const approveMatch = path.match(/^\/runs\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      return Response.json(apiApprove(state, approveMatch[1]!, await readBodyLenient(request)));
    }

    const failMatch = path.match(/^\/runs\/([^/]+)\/fail$/);
    if (failMatch && method === "POST") {
      return Response.json(apiFailRun(state, failMatch[1]!, await readBodyLenient(request)));
    }

    const resumeMatch = path.match(/^\/runs\/([^/]+)\/resume$/);
    if (resumeMatch && method === "POST") {
      return Response.json(await apiResume(state, resumeMatch[1]!, await readBodyLenient(request)));
    }

    const controlPhaseMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/(override|restart-fresh)$/);
    if (controlPhaseMatch && method === "POST") {
      const body = await readBodyLenient(request);
      const runId = controlPhaseMatch[1]!;
      const phase = decodeURIComponent(controlPhaseMatch[2]!);
      if (controlPhaseMatch[3] === "restart-fresh") {
        return Response.json(apiRestartFresh(state, runId, phase, body));
      }
      return Response.json(apiOverrideGate(state, runId, phase, body));
    }

    throw new ApiError(404, `no such route: ${method} ${path}`);
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** The reason of the run's last run_status event — what the run is parked on. */
function lastRunStatusReason(db: Database, runId: string): string | null {
  const events = cursorEvents(db, runId, 0, 500);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "run_status") {
      return (events[i]!.data as { reason?: string }).reason ?? null;
    }
  }
  return null;
}

function phaseStatusCounts(db: Database, runId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      "SELECT status, COUNT(*) AS n FROM phases WHERE run_id = ? GROUP BY status",
    )
    .all(runId);
  const counts: Record<string, number> = { total: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.n);
    counts["total"] = (counts["total"] ?? 0) + Number(row.n);
  }
  return counts;
}
