import type { Database } from "bun:sqlite";
import { isFixtureName } from "../engine/pi/harness/fixtures.ts";

import {
  cursorEvents,
  getRun,
  listGateNamesByIds,
} from "../repository/db.ts";
import {
  ApiError,
  type ControlResult,
  type PauseView,
} from "../contract.ts";
import { submitFixture } from "../engine/driver.ts";
import type { SubmitOptions, SubmittedRun } from "../engine/driver.ts";
import {
  effectiveMenu,
  getControl,
  getControlByLiveSession,
  statelessFailRun,
} from "../engine/pause-control.ts";
import type { PauseInfo, RunControl } from "../engine/pause-control.ts";
import { drivePreparedRun, driveResumedRun, prepareBlueprintRun, prepareResume } from "../engine/runner.ts";
import type { ApiState } from "../transport/state.ts";

/**
 * The control/mutation verbs of the server's local HTTP API: submit, shutdown,
 * and the T04 control surface (steer / session-steer / pause-view / approve /
 * fail / resume / override / restart-fresh). Every control verb writes a
 * human_action event; each surfaces the resulting run state. The per-endpoint
 * core functions are exported so the UI actions can call them in-process too;
 * they throw {@link ApiError} with the wire status codes (409 control
 * conflicts, 400 bad body, 201 submit). The query (read) verbs live in
 * ./runs.ts and the wire dispatcher lives in ../transport/http.ts.
 */

/**
 * POST /api/shutdown — graceful stop over HTTP (the CLI's `stop` verb). The
 * server replaces the old file-based SIGTERM dance: the response flushes first,
 * then we raise SIGTERM on ourselves so the installed signal handlers run the
 * SAME graceful close (stop children, close server + DB) and exit(0). A dead
 * process holds no socket, so there is no stale state to reap.
 */
export function apiShutdown(_state: ApiState): { ok: true } {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
  return { ok: true };
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

// ── T04 control surface (the pause viewer behind the CLI's
// `pause` verb). Every control verb writes a human_action event; each
// surfaces the resulting run state. The control handle is the server's
// in-process registry — a paused run after a server restart has none, and
// those verbs answer 409 (the continuation surface is T07/T08). ───────────────

export function apiPause(state: ApiState, runId: string): PauseView {
  const run = getRun(state.db, runId);
  if (!run) throw new ApiError(404, `run ${runId} not found`);
  const control = getControl(runId);
  // a paused run without a control handle (server restarted) is still PAUSED —
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
      ? { note: "paused, but the server has no control handle for it (restarted?) — the continuation surface is T07" }
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
      `run ${runId} has no active control handle (status ${run.status}) — steer needs a live server`,
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
    throw new ApiError(409, `no live session ${piSessionId} on the server (a paused run has no live process)`);
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
      statelessFailRun(state.db, runId, by); // interrupted / restarted-server runs
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
