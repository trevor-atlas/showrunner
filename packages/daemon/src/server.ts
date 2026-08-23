import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { isFixtureName } from "@showrunner/core/test/fixtures";

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
import { submitFixture } from "./driver.ts";
import type { SubmitOptions, SubmittedRun } from "./driver.ts";
import {
  effectiveMenu,
  getControl,
  getControlByLiveSession,
  statelessFailRun,
} from "./pause-control.ts";
import type { PauseInfo } from "./pause-control.ts";
import { RunPool } from "./pool.ts";
import { tailRawFile } from "./rawfile.ts";
import { drivePreparedRun, driveResumedRun, prepareBlueprintRun, prepareResume } from "./runner.ts";

/**
 * The daemon's local HTTP API (spec §13) - the slice the CLI needs: health,
 * submit (fixture or blueprint module), runs list (with phase counts), run
 * detail, the events cursor (§4.3), and the raw tail. The full §13 contract
 * is T08's ticket.
 *
 * Blueprint runs go through the §5.4 pool (default 2 slots, configurable via
 * SHOWRUNNER_POOL_SIZE); fixture submits spawn immediately (observation
 * fixtures, one child each - not pool-governed).
 *
 * Listens on a unix socket (unix://~/.showrunner/daemon.sock) per §13.
 */

export interface DaemonDeps {
  db: Database;
  dataDir: string;
  /** §5.4 pool size override (default: SHOWRUNNER_POOL_SIZE ?? 2) — test seam */
  poolSlots?: number;
}

const MAX_EVENTS_LIMIT = 500;
const POOL_SLOTS = Number(process.env.SHOWRUNNER_POOL_SIZE ?? "2") || 2;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function intParam(v: string | null, fallback: number, max: number): number {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

export function createDaemonServer(deps: DaemonDeps): Server {
  const { db, dataDir } = deps;
  const pool = new RunPool(deps.poolSlots ?? POOL_SLOTS);
  const startedAt = Date.now();

  return createServer((req, res) => {
    void handleRequest(db, dataDir, pool, startedAt, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    });
  });
}

async function handleRequest(
  db: Database,
  dataDir: string,
  pool: RunPool,
  startedAt: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://daemon.local");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/status") {
    // §13 status verb (T07): health + pool utilization + run status counts
    const runs = listRuns(db);
    const byStatus: Record<string, number> = { total: runs.length };
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    json(res, 200, {
      ok: true,
      pid: process.pid,
      data_dir: dataDir,
      uptime_ms: Date.now() - startedAt,
      pool: { slots: pool.slots, running: pool.runningIds, queued: pool.queuedIds },
      runs: byStatus,
    });
    return;
  }

  if (method === "GET" && path === "/runs") {
    const runs = listRuns(db).map((r) => ({
      ...r,
      phase_counts: phaseStatusCounts(db, r.id),
      // §13.1 queue position (F2 from the T01b review): 1-based spawn-queue
      // position for pool-queued runs, null when not queued
      queue_position: pool.position(r.id),
    }));
    json(res, 200, { runs });
    return;
  }

  if (method === "POST" && path === "/runs") {
    let body: Record<string, unknown>;
    try {
      const parsed = (await readJsonBody(req)) as Record<string, unknown>;
      body = parsed;
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
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
      const sub: SubmittedRun = submitFixture(db, dataDir, opts);
      json(res, 201, {
        run_id: sub.run_id,
        phase_id: sub.phase_id,
        agent_session_id: sub.agent_session_id,
        fixture,
        // observation fixtures spawn immediately — never pool-queued
        queue_position: null,
      });
      return;
    }

    // blueprint module (§13.3): import + validate + snapshot at submit, then
    // drive behind the pool (§5.4)
    const blueprintPath = body.blueprint;
    if (typeof blueprintPath === "string" && blueprintPath !== "") {
      // §13.2/§13.3 `args?`: opaque per-submit arguments, recorded in the
      // §13.3 snapshot (the run record is the snapshot — later edits to the
      // blueprint do not change an in-flight run)
      const args = body.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
        json(res, 400, { error: "args must be an array of strings" });
        return;
      }
      let prepared;
      try {
        prepared = await prepareBlueprintRun(db, dataDir, {
          modulePath: blueprintPath,
          cwd: typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : undefined,
          args: args as string[] | undefined,
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const delayMs =
        typeof body.delayMs === "number" && Number.isFinite(body.delayMs)
          ? Math.max(0, Math.floor(body.delayMs))
          : 0;
      pool.enqueue(prepared.runId, () => {
        try {
          const run = drivePreparedRun(db, dataDir, prepared, { delayMs });
          // F1 (§5.4): a paused run KEEPS its pool slot (cheap — no pi process
          // alive while paused); the slot frees only at a TERMINAL state
          void run.terminal.finally(() => pool.release(prepared.runId));
        } catch (err) {
          // synchronous failure: surface it on the run row, free the slot
          pool.release(prepared.runId);
        }
      });
      // §13.1 queue position in the submit response: null when a free slot
      // already started it, else its 1-based place in line
      json(res, 201, {
        run_id: prepared.runId,
        blueprint: prepared.blueprint.name,
        queue_position: pool.position(prepared.runId),
      });
      return;
    }

    json(res, 400, { error: "request body must include a fixture name or a blueprint module path" });
    return;
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const runId = runMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    // §11.1: spend splits reported vs estimated — the estimated half comes
    // from the §6 #12 spend events' flag, so show can mark it as such
    const estimatedByPhase = sumEstimatedPhaseSpend(db, runId);
    let estimatedSpend = 0;
    for (const s of estimatedByPhase.values()) estimatedSpend += s;
    json(res, 200, {
      run,
      spend_usd: sumRunSpend(db, runId),
      estimated_spend_usd: estimatedSpend,
      // §13.1: envelope count (accepted/attempt rows for the run)
      envelope_count: envelopeCount(db, runId),
      phases: listPhases(db, runId).map((p) => ({ ...p, estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0 })),
      sessions: listAgentSessions(db, runId),
      event_count: eventCount(db, runId),
    });
    return;
  }

  // §13.1 per-phase spend breakdown (+ estimated markers per §11.1).
  const spendMatch = path.match(/^\/runs\/([^/]+)\/spend$/);
  if (spendMatch && method === "GET") {
    const runId = spendMatch[1]!;
    if (!getRun(db, runId)) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const estimatedByPhase = sumEstimatedPhaseSpend(db, runId);
    let estimatedSpend = 0;
    for (const s of estimatedByPhase.values()) estimatedSpend += s;
    json(res, 200, {
      run_id: runId,
      spend_usd: sumRunSpend(db, runId),
      estimated_spend_usd: estimatedSpend,
      phases: listPhases(db, runId).map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        spend_usd: p.spend_usd,
        estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0,
      })),
    });
    return;
  }

  // ── §13.1 phase-scoped read endpoints (envelope history, gate results).
  // Both 404 on a missing run OR a phase name the run has no row for. ────────

  const phaseEnvelopesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/envelopes$/);
  if (phaseEnvelopesMatch && method === "GET") {
    const runId = phaseEnvelopesMatch[1]!;
    const phaseName = decodeURIComponent(phaseEnvelopesMatch[2]!);
    const phase = requirePhase(db, res, runId, phaseName);
    if (phase === null) return;
    // §13.1 envelope history for a phase: ALL attempts (valid and rejected,
    // per T03's model), ordered visit → attempt
    json(res, 200, {
      run_id: runId,
      phase: phase.name,
      phase_id: phase.id,
      envelopes: listEnvelopes(db, runId, phase.id),
    });
    return;
  }

  const phaseGatesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/gates$/);
  if (phaseGatesMatch && method === "GET") {
    const runId = phaseGatesMatch[1]!;
    const phaseName = decodeURIComponent(phaseGatesMatch[2]!);
    const phase = requirePhase(db, res, runId, phaseName);
    if (phase === null) return;
    // §13.1 gate results incl. overridden: each row carries the §5.3 override
    // badge (who + why + when) when the original row was overridden — the
    // original pass stays 0, the audit trail is the point
    json(res, 200, {
      run_id: runId,
      phase: phase.name,
      phase_id: phase.id,
      gates: listGateResults(db, runId, phase.id),
    });
    return;
  }

  const eventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const runId = eventsMatch[1]!;
    if (!getRun(db, runId)) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const cursor = intParam(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get("limit"), MAX_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
    const events = cursorEvents(db, runId, cursor, limit);
    const nextCursor = events.length > 0 ? events[events.length - 1]!.id : cursor;
    json(res, 200, { events, next_cursor: nextCursor });
    return;
  }

  const rawMatch = path.match(/^\/runs\/([^/]+)\/raw$/);
  if (rawMatch && method === "GET") {
    const runId = rawMatch[1]!;
    if (!getRun(db, runId)) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    // §13.1 tail semantics: ?lines=N (alias: ?n=) returns the LAST N raw
    // output lines (default 200, capped 5000) — the drill-in feed into the
    // byte-identical raw record (§10). line_count is the FULL line count;
    // truncated reports whether the tail dropped earlier lines.
    const linesParam = url.searchParams.get("lines") ?? url.searchParams.get("n");
    const n = intParam(linesParam, 200, 5000);
    const tail = tailRawFile(join(dataDir, "runs", runId, "raw_output.jsonl"), n);
    json(res, 200, { ...tail, run_id: runId });
    return;
  }

  // ── T04 control surface (spec §13.2 + the pause viewer behind the CLI's
  // `pause` verb). Every control verb writes a §6 #11 human_action event; each
  // surfaces the resulting run state. The control handle is the daemon's
  // in-process registry — a paused run after a daemon restart has none, and
  // those verbs answer 409 (the continuation surface is T07/T08). ───────────

  const pauseMatch = path.match(/^\/runs\/([^/]+)\/pause$/);
  if (pauseMatch && method === "GET") {
    const runId = pauseMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const control = getControl(runId);
    // a paused run without a control handle (daemon restarted) is still PAUSED —
    // the viewer reports the state, without the in-memory menu (T07/T08's surface)
    const paused = run.status === "paused";
    if (paused && control !== null && control.paused) {
      const info = control.pauseInfo!;
      json(res, 200, {
        run_id: runId,
        paused: true,
        status: run.status,
        kind: info.kind,
        phase: info.phase,
        reason: info.reason,
        actions: effectiveMenu(info),
        queued_steers: control.queuedSteerMessages,
        live_session_id: control.liveSessionId,
      });
      return;
    }
    json(res, 200, {
      run_id: runId,
      paused,
      status: run.status,
      reason: lastRunStatusReason(db, runId),
      actions: [],
      ...(paused
        ? { note: "paused, but the daemon has no control handle for it (restarted?) — the continuation surface is T07" }
        : {}),
    });
    return;
  }

  const steerMatch = path.match(/^\/runs\/([^/]+)\/steer$/);
  if (steerMatch && method === "POST") {
    const runId = steerMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const control = getControl(runId);
    if (control === null) {
      json(res, 409, { error: `run ${runId} has no active control handle (status ${run.status}) — steer needs a live daemon` });
      return;
    }
    try {
      const message = typeof body.message === "string" ? body.message : "";
      const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
      control.steer(message, by);
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    json(res, 200, {
      run_id: runId,
      ok: true,
      status: getRun(db, runId)!.status,
      queued_steers: control.queuedSteerCount,
      message: control.paused
        ? "steer recorded and queued — the run stays paused until a proceed action (delivery: T07 continuation)"
        : "steer sent to the live session (queued between turns, §8.4)",
    });
    return;
  }

  const sessionSteerMatch = path.match(/^\/sessions\/([^/]+)\/steer$/);
  if (sessionSteerMatch && method === "POST") {
    const piSessionId = sessionSteerMatch[1]!;
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const control = getControlByLiveSession(piSessionId);
    if (control === null) {
      json(res, 409, { error: `no live session ${piSessionId} on the daemon (a paused run has no live process)` });
      return;
    }
    try {
      const message = typeof body.message === "string" ? body.message : "";
      const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
      control.steer(message, by);
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    json(res, 200, { run_id: control.runId, ok: true, status: "running" });
    return;
  }

  const approveMatch = path.match(/^\/runs\/([^/]+)\/approve$/);
  if (approveMatch && method === "POST") {
    const runId = approveMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const control = getControl(runId);
    if (control === null) {
      json(res, 409, { error: `run ${runId} has no active control handle (status ${run.status})` });
      return;
    }
    try {
      control.approve(typeof body.by === "string" && body.by !== "" ? body.by : undefined);
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    json(res, 200, { run_id: runId, ok: true, status: getRun(db, runId)!.status });
    return;
  }

  const failMatch = path.match(/^\/runs\/([^/]+)\/fail$/);
  if (failMatch && method === "POST") {
    const runId = failMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
    const control = getControl(runId);
    try {
      if (control !== null) {
        control.fail(by); // the loop finalizes (kills the live child, §8.3)
      } else {
        statelessFailRun(db, runId, by); // interrupted / restarted-daemon runs
      }
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    json(res, 200, { run_id: runId, ok: true, status: getRun(db, runId)!.status });
    return;
  }

  const resumeMatch = path.match(/^\/runs\/([^/]+)\/resume$/);
  if (resumeMatch && method === "POST") {
    const runId = resumeMatch[1]!;
    if (!getRun(db, runId)) {
      // §13 404 semantics: a missing run 404s before any resume logic
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
    const delayMs =
      typeof body.delayMs === "number" && Number.isFinite(body.delayMs)
        ? Math.max(0, Math.floor(body.delayMs))
        : 0;
    try {
      // §12 continuation (T07): re-import the blueprint from the §13.3
      // snapshot, record the resume attempt + needs_review (T04 pin), and
      // relaunch the interrupted phase with the SAME --session-id + a
      // continue instruction — behind the pool, like a fresh run
      const preparedResume = await prepareResume(db, dataDir, runId, { by });
      pool.enqueue(runId, () => {
        try {
          const run = driveResumedRun(db, dataDir, preparedResume, { delayMs });
          // F1 (§5.4): the resumed run holds a slot until its TERMINAL state
          void run.terminal.finally(() => pool.release(runId));
        } catch {
          pool.release(runId);
        }
      });
      json(res, 200, { run_id: runId, ok: true, status: "running", needs_review: 1 });
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    return;
  }

  const controlPhaseMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/(override|restart-fresh)$/);
  if (controlPhaseMatch && method === "POST") {
    const runId = controlPhaseMatch[1]!;
    const phase = decodeURIComponent(controlPhaseMatch[2]!);
    const verb = controlPhaseMatch[3]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const control = getControl(runId);
    if (control === null || !control.paused) {
      json(res, 409, { error: `run ${runId} is not paused (status ${run.status}) — ${verb} is a pause-menu verb` });
      return;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const by = typeof body.by === "string" && body.by !== "" ? body.by : undefined;
    try {
      const info: PauseInfo = control.pauseInfo!;
      if (info.phase !== phase) {
        json(res, 409, { error: `run ${runId} is paused on phase "${info.phase}", not "${phase}"` });
        return;
      }
      if (verb === "restart-fresh") {
        control.restartFresh(by);
      } else {
        const gate = typeof body.gate === "string" && body.gate !== "" ? body.gate : "";
        const reason = typeof body.reason === "string" ? body.reason : "";
        control.overrideGate({ gate, by: by ?? "cli", reason });
      }
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    json(res, 200, { run_id: runId, ok: true, verb, status: getRun(db, runId)!.status });
    return;
  }

  json(res, 404, { error: `no such route: ${method} ${path}` });
}

/** Resolve a run's phase by name; 404 (JSON error) and return null when the
 * run or the phase does not exist — the phase-scoped §13 read endpoints rely
 * on these semantics for the UI. */
function requirePhase(db: Database, res: ServerResponse, runId: string, phaseName: string): import("./db.ts").PhaseRow | null {
  if (!getRun(db, runId)) {
    json(res, 404, { error: `run ${runId} not found` });
    return null;
  }
  const phase = getPhaseByName(db, runId, phaseName);
  if (phase === null) {
    json(res, 404, { error: `phase "${phaseName}" not found in run ${runId}` });
    return null;
  }
  return phase;
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
