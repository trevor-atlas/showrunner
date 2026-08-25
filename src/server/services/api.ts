import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { isFixtureName } from "../engine/pi/harness/fixtures.ts";

import {
  cursorEvents,
  getPhaseByName,
  getRun,
  listEnvelopes,
  listGateNamesByIds,
  listGateResults,
  listRuns,
} from "../repository/db.ts";
import {
  ApiError,
  type ControlResult,
  type DaemonStatus,
  type EventsPage,
  type PauseView,
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
import { submitFixture } from "../engine/driver.ts";
import type { SubmitOptions, SubmittedRun } from "../engine/driver.ts";
import { readOutputsDir } from "../repository/workspace/index.ts";
import {
  effectiveMenu,
  getControl,
  getControlByLiveSession,
  statelessFailRun,
} from "../engine/pause-control.ts";
import type { PauseInfo, RunControl } from "../engine/pause-control.ts";
import type { RunPool } from "../engine/pool.ts";
import { tailRawFile } from "../repository/rawfile.ts";
import { drivePreparedRun, driveResumedRun, prepareBlueprintRun, prepareResume } from "../engine/runner.ts";
import { buildRunList } from "./run-list.ts";
import { buildRunStats } from "./run-stats.ts";
import {
  buildRunDetail,
  buildSpendBreakdown,
  buildTimeline,
} from "./run-detail.ts";

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

/** The events-page size and the sweep batch — exported so the UI's
 * events proxy imports the same constant (no re-declared 500 in the
 * controller). The daemon caps the cursor query at this; the detail
 * sweep batches this per page. sweepRunEvents' default in db.ts is the
 * same 500 (db.ts cannot import server.ts, so the value lives in both). */
export const MAX_EVENTS_LIMIT = 500;

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

/**
 * POST /api/shutdown — graceful stop over HTTP (the CLI's `stop` verb). The
 * daemon replaces the old file-based SIGTERM dance: the response flushes first,
 * then we raise SIGTERM on ourselves so the installed signal handlers run the
 * SAME graceful close (stop children, close server + DB) and exit(0). A dead
 * process holds no socket, so there is no stale state to reap.
 */
export function apiShutdown(_state: ApiState): { ok: true } {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
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
    const actions = effectiveMenu(info);
    const view: PauseView = {
      run_id: runId,
      paused: true,
      status: run.status,
      kind: info.kind,
      phase: info.phase,
      reason: info.reason,
      actions,
      queued_steers: control.queuedSteerMessages,
      live_session_id: control.liveSessionId,
    };
    // the override form's target gates ride the SAME viewer call — the
    // failed gate-result ids on the pause info, resolved to names in
    // gate_results ROW order (deduped), so the menu and the override
    // form always agree; absent when the menu offers no override
    if (actions.includes("override") && info.gateResultIds !== undefined) {
      view.override_targets = listGateNamesByIds(state.db, info.gateResultIds);
    }
    return view;
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
    if (method === "POST" && path === "/shutdown") return Response.json(apiShutdown(state));
    if (method === "GET" && path === "/status") return Response.json(apiStatus(state));
    if (method === "GET" && path === "/stats") return Response.json(apiStats(state));
    if (method === "GET" && path === "/runs") return Response.json(apiListRuns(state));
    if (method === "POST" && path === "/runs") {
      return Response.json(await apiSubmitRun(state, await readBody(request)), { status: 201 });
    }

    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      return Response.json(apiRunDetail(state, runMatch[1]!, url.searchParams));
    }

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

    const phaseOutputsMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/outputs$/);
    if (phaseOutputsMatch && method === "GET") {
      return Response.json(
        apiPhaseOutputs(state, phaseOutputsMatch[1]!, decodeURIComponent(phaseOutputsMatch[2]!)),
      );
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
