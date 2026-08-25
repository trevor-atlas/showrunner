import type { Database } from "bun:sqlite";
import type { Envelope, EventType, RunStatus } from "../../core/index.ts";

import {
  deleteProcess,
  getEnvelope,
  getPhaseByName,
  getRun,
  insertEvent,
  listFailedGateResults,
  listProcesses,
  listRunProcesses,
  listRuns,
  updateRun,
} from "../repository/db.ts";
import type { RunRow } from "../repository/db.ts";
import {
  isEnvelopeApproved,
  overrideGateResult,
  recordEnvelopeAcceptance,
} from "./envelope-runner.ts";
import type { GateOverrideResult } from "./envelope-runner.ts";
import type { EventIds } from "./queue.ts";
import type { RpcCommand, SessionDriver } from "./pi/index.ts";

/**
 * The pause & control surface (T04) — the human-in-the-loop
 * machinery on top of the T01b run loop and T03's gate-override seam.
 *
 * The loop suspends at a pause point (approval / budget exhausted / visit
 * guard / blocked / hook error) by awaiting `RunControl.waitForAction()`. The
 * control surface (HTTP verbs in server.ts, called by the CLI) dispatches one
 * of the pause-menu actions: steer, approve, override gate, restart phase
 * fresh, or fail run. Every action writes a `human_action` event.
 *
 * Stable vs terminal (F1): `stable` resolves at the first pause OR at a
 * terminal state (a paused run is a stable state — T01b's `done`); `terminal`
 * resolves only at success/failed. The pool releases a run's slot on
 * `terminal`, so a paused run KEEPS its pool slot (cheap — no pi
 * process is alive while paused). A run parked at a pause therefore never
 * resolves `done` away from its slot.
 *
 * Paused-run steer semantics (pinned): a steer is ALWAYS audited as a
 * `human_action` and shown in the feed; on a RUNNING run with a live session
 * the RPC steer is written to the SAME session's stdin via
 * SessionDriver.send (queued between turns, no message id) and is NOT
 * re-queued; on a PAUSED run (no live process) the message is queued on the
 * run's control and the run stays paused — delivery lands with the
 * continuation machinery: the next spawned session's driveVisit drains the
 * queue (drainQueuedSteers) and writes each message as an RPC steer after its
 * first prompt ('then the visit continues'). A queued steer whose
 * continuation never spawns (e.g. a gate override accepts the rejected
 * envelope without a new visit) stays queued and rides the NEXT spawn.
 * Resume-from-interrupted records the attempt + sets needs_review per
 * the pin; the relaunch+backfill continuation is T07.
 */

export type PauseKind =
  | "approval" // require_approval, before the visit spawns
  | "budget_exhausted" // corrections within the visit hit the phase budget
  | "guard_exhausted" // max_visits reached
  | "blocked" // the agent's envelope asserted blocked
  | "hook_failed"; // a hook threw

export interface PauseInfo {
  kind: PauseKind;
  phase: string;
  reason: string;
  /** the last rejected envelope of the visit — the override target
   * (budget exhaustion after gate violations; valid=1 with failed gates) */
  envelopeId?: string | null;
  /** the failed gate-result row ids on that envelope — override targets */
  gateResultIds?: string[];
  /** the rejected envelope, parsed (the override continuation's handoff) */
  envelope?: Envelope | null;
  /** the rejected envelope's verbatim JSON (the override continuation's handoff) */
  envelopeRaw?: string | null;
}

export type ControlAction =
  | { kind: "approve"; by?: string }
  | { kind: "steer"; message: string; by?: string }
  | { kind: "override"; by?: string; reason?: string; envelope?: Envelope | null; raw?: string | null }
  | { kind: "restart_fresh"; by?: string }
  | { kind: "fail"; by?: string };

/** The pause menu per pause kind (blocked/guard offer the menu minus
 * override — nothing was rejected; approval offers approve + steer + fail). */
const MENU: Record<PauseKind, ControlAction["kind"][]> = {
  approval: ["approve", "steer", "fail"],
  budget_exhausted: ["steer", "override", "restart_fresh", "fail"],
  guard_exhausted: ["steer", "restart_fresh", "fail"],
  blocked: ["steer", "restart_fresh", "fail"],
  hook_failed: ["steer", "restart_fresh", "fail"],
};

/** The menu actually available on a pause (override needs a rejected gate). */
export function effectiveMenu(info: PauseInfo): ControlAction["kind"][] {
  const base = MENU[info.kind] ?? [];
  if (info.kind === "budget_exhausted" && (!info.gateResultIds || info.gateResultIds.length === 0)) {
    return base.filter((a) => a !== "override");
  }
  return [...base];
}

// ── RunResult (the shape of the stable/terminal promises) ────────────────────

export interface RunControlResult {
  status: RunStatus;
  needs_review: boolean;
}

/** What the loop hands the control for live-session operations. */
export interface LiveSessionRef {
  driver: SessionDriver;
  piSessionId: string;
  agentSessionId: string;
}

export interface ControlState {
  runId: string;
  db: Database;
  emit: (type: EventType, data: unknown, ids?: EventIds) => void;
}

/**
 * One handle per in-flight run (running or paused): the loop registers it at
 * init, pauses suspend on it, and the HTTP surface dispatches menu actions
 * through it. The registry is module-level — the server is a single process,
 * so the loop and the server share it; it dies with the server (control
 * surface after a restart is T07/T08 territory).
 */
export class RunControl {
  readonly runId: string;
  /** resolves at the first pause OR at terminal (T01b's `done`) */
  readonly stable: Promise<RunControlResult>;
  /** resolves only at a terminal state (success|failed) — F1's slot release */
  readonly terminal: Promise<RunControlResult>;

  private readonly state: ControlState;
  private pauseInfoValue: PauseInfo | null = null;
  private pauseWaiter: { resolve: (a: ControlAction) => void } | null = null;
  private liveSessionValue: LiveSessionRef | null = null;
  private readonly queuedSteers: string[] = [];
  private abort: "fail" | null = null;
  private stableResolve: (r: RunControlResult) => void = () => {};
  private terminalResolve: (r: RunControlResult) => void = () => {};

  constructor(state: ControlState) {
    this.runId = state.runId;
    this.state = state;
    this.stable = new Promise<RunControlResult>((resolve) => {
      this.stableResolve = resolve;
    });
    this.terminal = new Promise<RunControlResult>((resolve) => {
      this.terminalResolve = resolve;
    });
  }

  // ── loop side ─────────────────────────────────────────────────────────────

  get paused(): boolean {
    return this.pauseInfoValue !== null;
  }

  get pauseInfo(): PauseInfo | null {
    return this.pauseInfoValue;
  }

  get queuedSteerCount(): number {
    return this.queuedSteers.length;
  }

  get queuedSteerMessages(): string[] {
    return [...this.queuedSteers];
  }

  /**
   * Drain + clear the steers queued while the run was paused. Called by the
   * continuation machinery (driveVisit) once a session is spawned and its
   * first prompt is sent: each queued message is written to the new session
   * as an RPC steer (queued between turns). Live steers never enter
   * this queue — they were delivered to the session immediately.
   */
  drainQueuedSteers(): string[] {
    const drained = this.queuedSteers;
    this.queuedSteers.length = 0;
    return drained;
  }

  get liveSessionId(): string | null {
    return this.liveSessionValue?.piSessionId ?? null;
  }

  /** The loop parks the run at a pause; the stable promise resolves (a paused
   * run is stable, not terminal — F1), then the loop awaits a menu action. */
  setPause(info: PauseInfo): void {
    this.pauseInfoValue = info;
  }

  markPaused(result: RunControlResult): void {
    this.stableResolve(result);
  }

  markTerminal(result: RunControlResult): void {
    this.terminalResolve(result);
    this.stableResolve(result); // idempotent — a run that never paused
  }

  setLiveSession(ref: LiveSessionRef | null): void {
    this.liveSessionValue = ref;
  }

  /** Suspend the loop until a pause-menu action is dispatched. */
  waitForAction(): Promise<ControlAction> {
    if (this.pauseWaiter !== null) {
      throw new Error(`run ${this.runId} already has a pending pause`);
    }
    return new Promise<ControlAction>((resolve) => {
      this.pauseWaiter = { resolve };
    });
  }

  /** A mid-visit abort requested while no pause waiter is pending (fail). */
  takeAbort(): "fail" | null {
    const aborted = this.abort;
    this.abort = null;
    return aborted;
  }

  // ── control surface (server verbs call these; each validates + audits) ─────

  /**
   * steer: on a RUNNING run with a live session, the RPC steer is written to
   * the SAME session via SessionDriver.send — queued between turns, no
   * message id — and is not re-queued. On a PAUSED run (no live
   * process) the message is audited + queued and the run stays paused;
   * delivery lands with the continuation machinery (drainQueuedSteers on the
   * next spawned visit ('then the visit continues'). Works mid-run on
   * both a paused and a running run; always writes the human_action event.
   */
  steer(message: string, by?: string): void {
    if (typeof message !== "string" || message.trim() === "") {
      throw new Error("steer message must be a non-empty string");
    }
    this.emitHuman("steer", by, message);
    const live = this.liveSessionValue;
    if (live !== null) {
      // running: deliver to the live session NOW (queued between turns)
      const cmd: RpcCommand = { type: "steer", message };
      // fire-and-forget: a dead stream surfaces via the loop's settle waiter
      void live.driver.send(cmd).catch(() => {});
      return;
    }
    // paused: audited + queued — the pause stays until a proceed action; the
    // continuation machinery drains this on the next spawned visit
    this.queuedSteers.push(message);
  }

  /** approve: only valid on a require_approval pause; the run proceeds to spawn. */
  approve(by?: string): void {
    this.assertMenu("approve");
    const phase = this.pauseInfoValue!.phase;
    this.emitHuman("approve", by, `approval granted for phase "${phase}"`);
    this.resolveAction({ kind: "approve", by });
  }

  /**
   * override gate: T03's overrideGateResult (audited: who+why+when; the
   * original gate_results row is KEPT) marks the gate treated-as-passed, the
   * envelope becomes approved (isEnvelopeApproved), and the acceptance is
   * recorded — the loop then continues the run from the envelope.
   */
  overrideGate(input: { gate: string; by: string; reason: string }): GateOverrideResult {
    this.assertMenu("override");
    const info = this.pauseInfoValue!;
    if (!info.envelopeId || !info.gateResultIds || info.gateResultIds.length === 0) {
      throw new Error("no rejected gate result to override on this pause");
    }
    const gateResultId = this.resolveGateResultId(info, input.gate);
    const over = overrideGateResult({
      db: this.state.db,
      gateResultId,
      by: input.by,
      reason: input.reason,
      emit: (t, d, ids) => this.state.emit(t, d, ids),
    });
    if (!isEnvelopeApproved(this.state.db, info.envelopeId)) {
      throw new Error(`envelope ${info.envelopeId} still has un-overridden gate violations`);
    }
    recordEnvelopeAcceptance({
      db: this.state.db,
      envelopeId: info.envelopeId,
      emit: (t, d, ids) => this.state.emit(t, d, ids),
    });
    const action: ControlAction = {
      kind: "override",
      by: input.by,
      reason: input.reason,
      envelope: info.envelope ?? null,
      raw: info.envelopeRaw ?? null,
    };
    this.resolveAction(action);
    return over;
  }

  /** restart phase fresh: new pi session, same agent config — a new visit
   * (session id v<visit+1>); the loop re-drives the phase. */
  restartFresh(by?: string): void {
    this.assertMenu("restart_fresh");
    const phase = this.pauseInfoValue!.phase;
    this.emitHuman("restart", by, `phase "${phase}" restarted fresh (new session, new visit)`);
    this.resolveAction({ kind: "restart_fresh", by });
  }

  /**
   * fail run: run → failed, ended_at set; the live child is killed via
   * SessionDriver.stop() (SIGTERM → SIGKILL after 1s) and any other
   * children recorded in processes for the run are signalled too. Audited as
   * a human_action; the loop finalizes with run_status paused→failed.
   */
  fail(by?: string): void {
    this.emitHuman("fail", by, `run failed by ${by ?? "human"}`);
    const live = this.liveSessionValue;
    if (live !== null) {
      void live.driver.stop().catch(() => {});
    }
    killRunProcesses(this.state.db, this.runId);
    if (this.pauseWaiter !== null) {
      this.resolveAction({ kind: "fail", by });
    } else {
      // mid-visit fail: the loop notices the abort when the settle waiter
      // rejects (the driver was stopped) or at the next loop checkpoint
      this.abort = "fail";
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private assertMenu(action: ControlAction["kind"]): void {
    const info = this.pauseInfoValue;
    if (info === null) {
      throw new Error(`run ${this.runId} is not paused — no ${action} to take`);
    }
    if (!effectiveMenu(info).includes(action)) {
      throw new Error(
        `action "${action}" is not available at a ${info.kind} pause of phase "${info.phase}" (menu: ${effectiveMenu(info).join(", ")})`,
      );
    }
  }

  private resolveGateResultId(info: PauseInfo, gate: string): string {
    const rows = listFailedGateResults(this.state.db, info.envelopeId!);
    const match = rows.find((r) => r.gate === gate);
    if (!match) {
      throw new Error(
        `no failed gate "${gate}" on envelope ${info.envelopeId} (failed: ${rows.map((r) => r.gate).join(", ") || "none"})`,
      );
    }
    return match.id;
  }

  private emitHuman(action: string, by: string | undefined, detail: string): void {
    this.state.emit(
      "human_action",
      { action, by, detail },
      { phase_id: this.pauseInfoValue?.phase ? phaseIdForRun(this.state, this.pauseInfoValue.phase) : null, agent_session_id: null },
    );
  }

  private resolveAction(action: ControlAction): void {
    const w = this.pauseWaiter;
    this.pauseWaiter = null;
    this.pauseInfoValue = null;
    if (w !== null) w.resolve(action);
  }
}

/** phase id lookup for human_action tagging — from the runs phases table. */
function phaseIdForRun(state: ControlState, phaseName: string): string | null {
  return getPhaseByName(state.db, state.runId, phaseName)?.id ?? null;
}

// ── the registry (single server process) ─────────────────────────────────────

const controls = new Map<string, RunControl>();

export function registerControl(control: RunControl): void {
  controls.set(control.runId, control);
}

export function getControl(runId: string): RunControl | null {
  return controls.get(runId) ?? null;
}

export function unregisterControl(runId: string): void {
  controls.delete(runId);
}

/** Find a control whose session is live (the session-keyed steer). */
export function getControlByLiveSession(piSessionId: string): RunControl | null {
  for (const control of controls.values()) {
    if (control.liveSessionId === piSessionId) return control;
  }
  return null;
}

// ── process signalling (fail-run semantics) ─────────────────────────────

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  // SIGKILL after 1s — the same semantics as pi's RpcClient.stop()
  const timer = setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 1_000);
  timer.unref?.();
}

/** Kill every child recorded in processes for the run. */
export function killRunProcesses(db: Database, runId: string): void {
  for (const p of listRunProcesses(db, runId)) killPid(p.pid);
}

/** Is a pid a live process (process.kill(pid, 0) probe)? */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * orphan cleanup — the server-startup sweep over the WHOLE processes
 * table. Rows whose pid is dead (or bogus) are removed; rows whose pid is
 * ALIVE are orphaned children from a previous server instance killed with
 * SIGKILL — they are SIGTERM'd (SIGKILL after 1s) and removed. The
 * server cannot take over a child whose stdout pipe it no longer owns, so
 * reaping is the only honest cleanup. Returns what was cleaned for tests.
 */
export function cleanupProcesses(db: Database): { removed_dead: number; killed: number[] } {
  const removedDead: number[] = [];
  const killed: number[] = [];
  for (const p of listProcesses(db)) {
    if (isPidAlive(p.pid)) {
      killPid(p.pid); // SIGTERM → SIGKILL after 1s
      killed.push(p.pid);
    } else {
      removedDead.push(p.pid);
    }
    deleteProcess(db, p.id);
  }
  return { removed_dead: removedDead.length, killed };
}

/**
 * Graceful shutdown (T07): stop every recorded child (SIGTERM → SIGKILL
 * after 1s) and remove its processes row. Events are already durable —
 * nothing is persisted here; the runs they belong to surface as interrupted
 * on the next server start.
 */
export function stopRecordedChildren(db: Database): void {
  for (const p of listProcesses(db)) {
    killPid(p.pid);
    deleteProcess(db, p.id);
  }
}

// ── stateless verbs (no loop in this process) ────────────────────────────────

/**
 * POST /runs/:id/resume on an INTERRUPTED run — the continue
 * verb's recording half. needs_review semantics PINNED (T04):
 * mid-tool-call death (an unsettled stream at process death) flags
 * needs_review when the crash lands; ANY resume from interrupted flags it
 * again — this verb enforces the second half unconditionally. The relaunch
 * itself (same --session-id + continue instruction + backfill) is T07's
 * prepareResume/driveResumedRun; this records the attempt (a
 * human_action) and pins the flag.
 */
export function resumeInterruptedRun(db: Database, runId: string, by?: string): { status: string; needs_review: number } {
  const run = getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  if (run.status !== "interrupted") {
    throw new Error(`run ${runId} is ${run.status}, not interrupted — resume is the interrupted-run continue verb`);
  }
  insertEvent(db, {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "human_action",
    ts: new Date().toISOString(),
    data: {
      action: "resume",
      by,
      detail: `resume requested for interrupted run ${runId} — needs_review flagged; the interrupted phase is relaunched with the same session id + a continue instruction (prepareResume/driveResumedRun)`,
    },
  });
  updateRun(db, runId, { needs_review: 1 });
  return { status: "interrupted", needs_review: 1 };
}

/**
 * Stateless fail for a run with NO control handle (interrupted, or paused
 * after a server restart): fail the run row + kill recorded children + audit.
 * Runs WITH a live control go through RunControl.fail (the loop finalizes).
 */
export function statelessFailRun(db: Database, runId: string, by?: string): RunRow {
  const run = getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  if (run.status === "success" || run.status === "failed") {
    throw new Error(`run ${runId} is already ${run.status}`);
  }
  killRunProcesses(db, runId);
  const ts = new Date().toISOString();
  insertEvent(db, {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "human_action",
    ts,
    data: { action: "fail", by, detail: `run failed by ${by ?? "human"}` },
  });
  insertEvent(db, {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "run_status",
    ts,
    data: { from: run.status, to: "failed", reason: `failed by ${by ?? "human"}` },
  });
  updateRun(db, runId, { status: "failed", ended_at: ts });
  return { ...run, status: "failed", ended_at: ts };
}

/**
 * Server-startup reconciliation: every run left in `running` when the
 * server restarts is surfaced as `interrupted` — orphaned children are killed
 * (the server cannot take over a child whose stdout it no longer owns), the
 * run_status event records the crash, and the run awaits a human continue.
 * `paused` runs are untouched (a pause is durable; their control surface is
 * T07/T08's restart concern).
 */
export function reconcileInterruptedRuns(db: Database): string[] {
  const interrupted: string[] = [];
  for (const run of listRuns(db)) {
    if (run.status !== "running") continue;
    killRunProcesses(db, run.id);
    insertEvent(db, {
      run_id: run.id,
      phase_id: null,
      agent_session_id: null,
      type: "run_status",
      ts: new Date().toISOString(),
      data: { from: "running", to: "interrupted", reason: "server restarted — run interrupted for a human continue" },
    });
    updateRun(db, run.id, { status: "interrupted" });
    interrupted.push(run.id);
  }
  return interrupted;
}
