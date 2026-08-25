import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  createShell,
  DEFAULT_BUDGET,
  EnvelopeBase,
  validateBlueprint,
} from "../../core/index.ts";
import type {
  Blueprint,
  BlueprintPhase,
  Envelope,
  EventType,
  PhaseHookContext,
  PhaseStartCause,
  RunStatus,
  ShellResult,
  Spend,
} from "../../core/index.ts";
import { runDirFor } from "../../core/index.ts";

import {
  materializeHandoff,
  outputsDirFor,
  phaseDirFor,
  readHandoffInputs,
  recordAcceptedEnvelope,
  resolveContext,
  slugFor,
  writeAgentMap,
} from "../repository/workspace/index.ts";
import type { Handoff } from "../repository/workspace/index.ts";

import {
  deleteProcess,
  getEnvelope,
  getPhaseByName,
  getRun,
  insertAgentSession,
  insertEvent,
  insertPhase,
  insertPhaseVisit,
  insertProcess,
  insertRun,
  listFailedGateResults,
  listPhases,
  updateAgentSession,
  updateEnvelope,
  updatePhase,
  updatePhaseVisit,
  updateRun,
} from "../repository/db.ts";
import { registerControl, unregisterControl, resumeInterruptedRun, RunControl } from "./pause-control.ts";
import type { ControlAction, PauseInfo } from "./pause-control.ts";
import { MAX_CAPTURED_STDERR, sessionIdFor } from "./driver.ts";
import { gateName, runEnvelopeStage } from "./envelope-runner.ts";
import { EventSink } from "./queue.ts";
import type { EventIds } from "./queue.ts";
import { RawOutputFile } from "../repository/rawfile.ts";
import { loadRoster } from "./roster.ts";
import type { Roster } from "./roster.ts";
import { Tracer } from "./tracer.ts";
import {
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  isSettledLine,
  sessionDriverKind,
} from "./pi/index.ts";
import type { RpcCommand, RpcResponse, SessionDriver } from "./pi/index.ts";

/**
 * The run loop (T01b) — the state machine that drives a blueprint's
 * phases to completion. The loop itself is driver-agnostic: per visit
 * it materializes the predecessor handoff → visit guard (visits >= max_visits
 * → pause) → obtains the session driver (T02: the real pi binary when
 * SHOWRUNNER_SMOKE=1, scripted FakePi sessions otherwise; session id
 * `<run8>_<phase>_v<visit>`) → sends the composed prompt → tails/folds
 * events until agent_settled → zod-validates envelope.json → blocked? → gates →
 * records the envelope → next phase. Corrections re-prompt the SAME session
 * (one message naming exactly what was wrong) against the phase's budget
 * (default 3); exhaustion routes through `on_fail` (new visit) or pauses.
 *
 * The envelope/gate stage lives in envelope-runner.ts (T03's seam); the
 * context/handoff protocol lives in handoff.ts (T05) — this loop calls
 * materializeHandoff at visit start and recordAcceptedEnvelope on acceptance.
 * Hooks run in-process with a shell() helper. The pool is
 * server-side (pool.ts).
 */

export const DEFAULT_MAX_VISITS = 3;
export const FAKE_SESSION_DIR = "fake-pi";

// ── scripted session seam (the FakePi side of the loop) ──────────────────────

export interface ScriptedTurn {
  /** raw pi JSONL event objects, streamed verbatim (sessionId is injected) */
  events: Record<string, unknown>[];
  /** the envelope.json the agent "writes" at the end of this turn */
  envelope: Record<string, unknown>;
  /** extra files the agent "writes" into outputs/ (path → content) — the
   * paths listed in envelope.artifacts become the next phase's inputs */
  artifacts?: Record<string, string>;
}

export interface ScriptedSession {
  turns: ScriptedTurn[];
  /** per-visit turn override (R7 fixture seam, strictly additive):
   * byVisit[visit] replaces `turns` for THAT visit — the same
   * ScriptedTurn[] shape. Visits without a key fall back to `turns`
   * (byte-identical to the pre-extension session for every existing
   * script), so a phase can behave differently across its visits (e.g.
   * review v1 exhausts its budget while review v2 passes). */
  byVisit?: Record<number, ScriptedTurn[]>;
  /** emit the very last event without a trailing newline (byte-identical raw) */
  unterminatedFinalLine?: boolean;
  /** after the last scripted turn, the session dies instead of waiting (crash tests) */
  exitAfterLastTurn?: { code?: number };
}

export type ScriptMap = Record<string, ScriptedSession>;

// ── public surface ───────────────────────────────────────────────────────────

export interface RunResult {
  status: RunStatus;
  needs_review: boolean;
}

export interface BlueprintRun {
  run_id: string;
  /** resolves at the first stable state — a pause counts (T01b compat) */
  done: Promise<RunResult>;
  /** resolves only at a TERMINAL state (success|failed) — the F1 slot release
   * (a paused run keeps its pool slot, cheap — no pi process alive) */
  terminal: Promise<RunResult>;
}

export interface RunBlueprintOptions {
  db: Database;
  dataDir: string;
  blueprint: Blueprint;
  cwd: string;
  /** phase name → scripted session (FakePi); every phase must have one */
  scripts: ScriptMap;
  maxVisits?: number;
  delayMs?: number;
  /** the blueprint module's directory, for context-entry file fallback */
  moduleDir?: string | null;
  now?: () => string;
}

export interface PreparedRun {
  runId: string;
  blueprint: Blueprint;
  cwd: string;
  scripts: ScriptMap;
  moduleDir: string | null;
  maxVisits?: number;
  delayMs?: number;
}

// ── blueprint module loading + validation ──────────────────────

export async function loadBlueprintModule(modulePath: string): Promise<Blueprint> {
  const mod = (await import(pathToFileURL(modulePath).href)) as {
    default?: Blueprint;
    blueprint?: Blueprint;
  };
  const blueprint = mod.default ?? mod.blueprint;
  if (!blueprint) {
    throw new Error(
      `blueprint module ${modulePath} must export a blueprint (default export or a named "blueprint" export)`,
    );
  }
  validateBlueprint(blueprint);
  return blueprint;
}

/** Resolve each phase's scripted session from <scriptDir>/<slug>.json. */
export function resolveScriptedSessions(blueprint: Blueprint, scriptDir: string): ScriptMap {
  const scripts: ScriptMap = {};
  const missing: string[] = [];
  for (const phase of blueprint.phases) {
    const path = join(scriptDir, `${slugFor(phase.name)}.json`);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      missing.push(path);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`scripted session ${path} is not valid JSON: ${messageOf(err)}`);
    }
    const session = parsed as ScriptedSession;
    if (!session || !Array.isArray(session.turns) || session.turns.length === 0) {
      throw new Error(`scripted session ${path} must define a non-empty "turns" array`);
    }
    scripts[phase.name] = session;
  }
  if (missing.length > 0) {
    throw new Error(
      `no scripted FakePi session for phase(s) — this build runs on FakePi only; add: ${missing.join(", ")}`,
    );
  }
  return scripts;
}

/**
 * Import + validate + snapshot a blueprint module, resolve its scripted
 * sessions, create the run/phase rows and the run events. Returns the
 * prepared run; driving it is drivePreparedRun (server-side, behind the pool).
 */
export async function prepareBlueprintRun(
  db: Database,
  dataDir: string,
  opts: { modulePath: string; cwd?: string; maxVisits?: number; delayMs?: number; args?: string[] },
): Promise<PreparedRun> {
  const modulePath = isAbsolute(opts.modulePath) ? opts.modulePath : join(process.cwd(), opts.modulePath);
  // fail fast on a malformed prices.json: a broken roster is a config
  // error — surface it at submit (a 400), not as a run stuck mid-drive. The
  // roster itself is re-read once per run in initState (the snapshot
  // doctrine: submit-time values govern the run).
  loadRoster(dataDir);
  const blueprint = await loadBlueprintModule(modulePath);
  const moduleDir = dirname(modulePath);
  const scripts = resolveScriptedSessions(blueprint, join(moduleDir, FAKE_SESSION_DIR));
  const cwd = opts.cwd ?? process.cwd();
  const runId = createRunRows(db, dataDir, {
    blueprint,
    cwd,
    moduleDir,
    modulePath,
    maxVisits: opts.maxVisits,
    args: opts.args,
  });
  return { runId, blueprint, cwd, scripts, moduleDir, maxVisits: opts.maxVisits, delayMs: opts.delayMs };
}

// ── run/phase rows, events, snapshot ─────────────────────────────

interface InitOptions {
  blueprint: Blueprint;
  cwd: string;
  moduleDir: string | null;
  maxVisits: number;
  delayMs: number;
  now: () => string;
  scripts: ScriptMap;
}

interface LoopState extends InitOptions {
  db: Database;
  dataDir: string;
  runId: string;
  runDir: string;
  phaseIds: Map<string, string>;
  phaseVisits: Map<string, number>;
  phaseSpend: Map<string, number>;
  /** the price roster from {data_dir}/prices.json — the estimate path */
  roster: Roster;
  rawFile: RawOutputFile;
  sink: EventSink;
  /** the pause & control surface (T04) — pauses suspend here, verbs dispatch here */
  control: RunControl;
  /** true when this drive is a resume (from interrupted) — the run's
   * needs_review flag survives a clean finish (the T04 pin: ANY resume from
   * interrupted flags it for a human glance) */
  resumed: boolean;
  emit: (type: EventType, data: unknown, ids?: EventIds) => void;
}

/** Create the run row, pending phase rows, run events, and the snapshot. */
function createRunRows(
  db: Database,
  dataDir: string,
  opts: { blueprint: Blueprint; cwd: string; moduleDir: string | null; modulePath?: string | null; maxVisits?: number; args?: string[] },
): string {
  const runId = randomUUID();
  const runDir = runDirFor(dataDir, runId);
  mkdirSync(runDir, { recursive: true });
  const nowIso = (): string => new Date().toISOString();
  insertRun(db, {
    id: runId,
    blueprint: opts.blueprint.name,
    status: "running",
    cwd: opts.cwd,
    needs_review: 0,
    started_at: nowIso(),
    ended_at: null,
  });
  // (F2): run_submitted fires at ACCEPTANCE — the run row + snapshot
  // exist here, before any driving (the pool may still have the run queued;
  // the submitted→running transition lands at drive start in driveState).
  insertEvent(db, {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "run_submitted",
    ts: nowIso(),
    data: { blueprint: opts.blueprint.name, cwd: opts.cwd },
  });
  opts.blueprint.phases.forEach((phase, ordinal) => {
    insertPhase(db, {
      id: randomUUID(),
      run_id: runId,
      name: phase.name,
      agent: phase.agent.name,
      status: "pending",
      visits: 0,
      corrections: 0,
      budget: phase.budget ?? DEFAULT_BUDGET,
      spend_usd: 0,
      started_at: null,
      ended_at: null,
      ordinal,
      agent_model: phase.agent.model,
      require_approval: phase.require_approval ? 1 : 0,
      on_fail_to: phase.on_fail?.to ?? null,
      gate_names: JSON.stringify(phase.gates.map((g, i) => gateName(g, i))),
      context_entries: JSON.stringify([...phase.agent.context, ...(phase.context ?? [])]),
    });
  });
  // the rendered configuration is snapshotted at submit time, so later
  // edits to the blueprint never mutate an in-flight run
  snapshotBlueprint(runDir, opts.blueprint, opts.maxVisits ?? DEFAULT_MAX_VISITS, opts.modulePath ?? null, opts.args);
  return runId;
}

/** Build the loop state over an existing run (rows already created). */
function initState(db: Database, dataDir: string, opts: InitOptions & { runId: string }): LoopState {
  const runId = opts.runId;
  const runDir = runDirFor(dataDir, runId);
  mkdirSync(runDir, { recursive: true });
  const sink = new EventSink(db, { runId, phaseId: null, agentSessionId: null });
  const phaseIds = new Map<string, string>();
  const phaseVisits = new Map<string, number>();
  for (const phase of opts.blueprint.phases) {
    // rows are created by createRunRows; ids are their own — look them up
    const row = getPhaseByName(db, runId, phase.name);
    phaseIds.set(phase.name, row?.id ?? randomUUID());
    // resume: the interrupted phase's recorded visits ARE the visit to
    // resume (same --session-id); fresh rows have visits=0 → visit 1 as before
    phaseVisits.set(phase.name, row?.visits ?? 0);
  }
  const phaseSpend = new Map<string, number>();
  // the price roster is loaded once per run (a broken prices.json is a
  // config error and throws here — before any run rows are driven to a state)
  const roster = loadRoster(dataDir);
  const rawFile = new RawOutputFile(join(runDir, "raw_output.jsonl"));
  // T04: the pause & control surface — one handle per in-flight run (running
  // or paused). Its emit forwards to state.emit, set below (call-time lookup).
  const control = new RunControl({
    runId,
    db,
    emit: (type, data, ids) => state.emit(type, data, ids),
  });
  const state: LoopState = {
    ...opts,
    db,
    dataDir,
    runId,
    runDir,
    phaseIds,
    phaseVisits,
    phaseSpend,
    roster,
    rawFile,
    sink,
    control,
    resumed: false,
    emit: () => {},
  };
  state.emit = (type: EventType, data: unknown, ids: EventIds = {}): void => {
    if (type === "spend") {
      const spend = data as Spend;
      const phaseId = state.phaseIds.get(spend.phase);
      if (phaseId) {
        const total = (state.phaseSpend.get(spend.phase) ?? 0) + (spend.usd ?? 0);
        state.phaseSpend.set(spend.phase, total);
        updatePhase(db, phaseId, { spend_usd: total });
      }
    }
    sink.push(type, data, ids);
  };
  registerControl(control);
  return state;
}

/** The snapshot: the rendered configuration, stored for drill-in. */
export function snapshotBlueprint(
  runDir: string,
  blueprint: Blueprint,
  maxVisits: number,
  modulePath?: string | null,
  args?: string[] | null,
): void {
  const doc = {
    name: blueprint.name,
    module: modulePath ?? null,
    args: args ?? null,
    max_visits: maxVisits,
    phases: blueprint.phases.map((p) => ({
      name: p.name,
      agent: {
        name: p.agent.name,
        model: p.agent.model,
        prompt: p.agent.prompt,
        tools: p.agent.tools,
        context: p.agent.context,
      },
      budget: p.budget ?? DEFAULT_BUDGET,
      require_approval: p.require_approval ?? false,
      on_fail: p.on_fail ?? null,
      // phase-level additions to the agent's context defaults, recorded as a
      // first-class key (mirrors BlueprintPhase.context) so the snapshot's
      // effective context (agent.context ++ context) agrees with the phase
      // row's context_entries written by createRunRows
      context: p.context ?? [],
      envelope: renderSchema(p.envelope),
      gates: p.gates.map((g, i) => gateName(g, i)),
    })),
    hooks: {
      onPhaseStart: typeof blueprint.onPhaseStart === "function",
      onPhaseEnd: typeof blueprint.onPhaseEnd === "function",
    },
  };
  writeFileSync(join(runDir, "blueprint.json"), JSON.stringify(doc, null, 2) + "\n");
}

// ── the loop ─────────────────────────────────────────────────────────────────

type VisitOutcome =
  | { kind: "success"; envelope: Envelope; raw: string; corrections: number }
  | { kind: "failed"; reason: "budget_exhausted"; corrections: number; lastEnvelopeId?: string }
  | { kind: "blocked"; reason: string; corrections: number }
  | { kind: "hook_failed"; reason: string; corrections: number }
  | { kind: "crash"; reason: string; corrections: number };

/** The resume spec: drive the loop from the interrupted phase's recorded
 * visit, reusing its --session-id and leading with a continue instruction.
 * `handoff` is the predecessor's last accepted envelope (reconstructed from
 * the run's raw record) — phases already success are never re-entered. */
export interface ResumeSpec {
  phase: string;
  /** the recorded visit of the interrupted phase — re-visited as-is (same session id) */
  visit: number;
  /** the continue instruction (sent as the resumed visit's first prompt) */
  continueInstruction: string;
  /** the predecessor's accepted envelope, reconstructed from runDir/envelope.json */
  handoff: Handoff | null;
  /** R2: who requested the resume — mirrors the human_action "resume" by */
  by?: string;
}

async function driveLoop(state: LoopState, resume?: ResumeSpec): Promise<RunResult> {
  const bp = state.blueprint;
  const indexByName = new Map(bp.phases.map((p, i) => [p.name, i]));
  // a resumed run starts at the interrupted phase — everything before
  // it (status success) is not re-run; phases after it stay pending.
  let pending: string | null = resume?.phase ?? bp.phases[0]?.name ?? null;
  let handoff: Handoff | null = resume?.handoff ?? null;
  // R2: why the NEXT driveVisit starts — decided at the site that knows (an
  // on_fail jump, a human redrive) and consumed at the visit-start call
  // below; normal forward execution leaves it unset (the call defaults to
  // flow). A human redrive OVERRIDES a pending on_fail cause (a guard pause
  // can sit between the jump and its target).
  let pendingCause: PhaseStartCause | undefined;

  while (pending !== null) {
    const phase = bp.phases.find((p) => p.name === pending);
    if (!phase) {
      return finalizeRun(state, "failed", true, `internal error: unknown phase "${pending}"`);
    }

    // per-phase visit loop (T04): a human restart-fresh re-enters it with a new visit
    let phaseApproved = false; // step 1 — one approval per phase entry
    // step 3 pin (T13): the guard bypass is ONE-SHOT. A human restart/steer
    // from a guard_exhausted pause earns exactly ONE more visit, then the guard
    // re-asserts (visits >= max_visits → pause) — restart-fresh can never
    // silently exceed max_visits, and guard_exhausted stays reachable through
    // the pause menu. A restart from any OTHER pause (budget/blocked/hook)
    // never bypasses the guard at all.
    let guardBypass = false;
    // the interrupted phase already earned its approval (it spawned) —
    // a resume must not re-pause on require_approval
    if (resume !== undefined && resume.phase === phase.name) phaseApproved = true;

    for (;;) {
      if (abortCheck(state) === "fail") {
        // a mid-visit human fail with no pause waiter — not a crash
        return finalizeRun(state, "failed", false, "failed by human");
      }

      // 1. require_approval? — pause before spawn; approve → spawn
      if (phase.require_approval && !phaseApproved) {
        const action = await pauseAt(state, {
          kind: "approval",
          phase: phase.name,
          reason: `approval required before phase "${phase.name}"`,
        });
        if (action.kind === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        // approve or steer: the visit proceeds (a steer was queued on the
        // control — delivered on the next continuation, T07)
        resumeFromPause(state, action.kind === "approve" ? "approved" : "steered");
        phaseApproved = true;
      }

      // 2. materialize the predecessor handoff (envelope + artifacts)
      materializeInputs(state, phase.name, handoff);

      // 3. visit guard: visits >= max_visits → pause. The
      // RESUME visit is exempt — it re-visits the recorded visit, it does not
      // add one. A pending guardBypass (a restart/steer from a guard pause)
      // is consumed by exactly one visit, then the guard re-asserts.
      const currentVisits = state.phaseVisits.get(phase.name) ?? 0;
      const isResumeVisit = resume !== undefined && resume.phase === phase.name;
      if (!guardBypass && !isResumeVisit && currentVisits >= state.maxVisits) {
        const action = await pauseAt(state, {
          kind: "guard_exhausted",
          phase: phase.name,
          reason: `max_visits (${state.maxVisits}) reached for phase "${phase.name}"`,
        });
        const d = menuDirective(state, action);
        if (d.directive === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        // R2: the human's restart/steer is why the bypassed visit starts — and
        // it OVERRIDES a pending on_fail cause (the guard pause sat between an
        // on_fail jump and its target)
        pendingCause = { kind: "human", action: d.action, by: action.by };
        guardBypass = true; // one new visit, then the guard fires again
        continue;
      }
      guardBypass = false; // consumed — the visit below is the bypassed one
      const visit = isResumeVisit ? currentVisits : currentVisits + 1;

      // R2: the cause of THIS visit — a resumed visit is a human continue
      // (mirrors the pause-control layer's human_action action "resume");
      // a pending on_fail jump is consumed once; otherwise it is plain
      // forward execution (flow)
      let cause: PhaseStartCause;
      if (isResumeVisit) {
        cause =
          resume!.by !== undefined
            ? { kind: "human", action: "resume", by: resume!.by }
            : { kind: "human", action: "resume" };
      } else {
        cause = pendingCause ?? { kind: "flow" };
      }
      pendingCause = undefined;

      const result = await driveVisit(state, phase, visit, handoff, {
        // the resumed visit leads with the continue instruction
        continueInstruction: isResumeVisit ? resume!.continueInstruction : null,
        cause,
      });

      if (result.kind === "success") {
        const ended = await endPhase(state, phase, "success", visit, result.corrections);
        if (ended.hookError) {
          const action = await pauseAt(state, {
            kind: "hook_failed",
            phase: phase.name,
            reason: `phase hook error in "${phase.name}": ${ended.hookError}`,
          });
          const d = menuDirective(state, action);
          if (d.directive === "fail") {
            return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
          }
          // R2: the human redrive is why the next visit starts
          pendingCause = { kind: "human", action: d.action, by: action.by };
          // NOT a guard bypass: the guard re-asserts on the next iteration
          continue;
        }
        handoff = { envelope: result.envelope, raw: result.raw, fromPhase: phase.name };
        // the accepted envelope lands in the run's raw record, verbatim
        recordAcceptedEnvelope(state.runDir, result.raw);
        const idx = indexByName.get(phase.name)!;
        pending = idx + 1 < bp.phases.length ? bp.phases[idx + 1]!.name : null;
        break;
      }

      if (result.kind === "blocked") {
        // never routed through on_fail; the phase stays in_progress on the human
        const action = await pauseAt(state, {
          kind: "blocked",
          phase: phase.name,
          reason: `blocked in phase "${phase.name}": ${result.reason}`,
        });
        const d = menuDirective(state, action);
        if (d.directive === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        // R2: the human redrive is why the next visit starts
        pendingCause = { kind: "human", action: d.action, by: action.by };
        // NOT a guard bypass: the guard re-asserts on the next iteration
        continue;
      }

      if (result.kind === "hook_failed") {
        await endPhase(state, phase, "failed", visit, result.corrections);
        const action = await pauseAt(state, {
          kind: "hook_failed",
          phase: phase.name,
          reason: `phase hook error in "${phase.name}": ${result.reason}`,
        });
        const d = menuDirective(state, action);
        if (d.directive === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        // R2: the human redrive is why the next visit starts
        pendingCause = { kind: "human", action: d.action, by: action.by };
        // NOT a guard bypass: the guard re-asserts on the next iteration
        continue;
      }

      if (result.kind === "failed") {
        // budget exhausted: on_fail routes a failed phase, else the human menu
        await endPhase(state, phase, "failed", visit, result.corrections);
        if (phase.on_fail) {
          pending = phase.on_fail.to;
          // R2: the jump target's next visit starts because THIS phase failed —
          // `visit` is the failed visit's number, in scope at the jump site
          pendingCause = { kind: "on_fail", from_phase: phase.name, from_visit: visit };
          break;
        }
        const action = await pauseAt(state, budgetPauseInfo(state, phase, result));
        if (action.kind === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        if (action.kind === "restart_fresh" || action.kind === "steer") {
          const d = menuDirective(state, action);
          if (d.directive === "fail") {
            // unreachable — the fail branch above handled it; defensive like the
            // original `void d` (never spin past a fail action)
            return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
          }
          // R2: the human's restart/steer is why the next visit starts
          pendingCause = { kind: "human", action: d.action, by: action.by };
          // NOT a guard bypass: a restart from a budget pause re-asserts the
          // guard on the next iteration (visits >= max_visits → pause)
          continue;
        }
        if (action.kind === "override") {
          // T03's dispatch already overrode the failed gates and recorded the
          // acceptance — the envelope becomes the phase's accepted handoff
          if (!action.envelope || action.raw === null || action.raw === undefined) {
            return finalizeRun(state, "failed", true, "override continuation lost the envelope", "paused");
          }
          resumeFromPause(state, "gate overridden");
          handoff = { envelope: action.envelope, raw: action.raw, fromPhase: phase.name };
          recordAcceptedEnvelope(state.runDir, action.raw);
          markPhaseSuccess(state, phase, visit, result.corrections);
          const idx = indexByName.get(phase.name)!;
          pending = idx + 1 < bp.phases.length ? bp.phases[idx + 1]!.name : null;
          break;
        }
      }

      if (result.kind === "crash") {
        // stream died before agent_settled: needs_review for a human
        await endPhase(state, phase, "failed", visit, result.corrections);
        if (abortCheck(state) === "fail") {
          // a mid-visit human fail (the control stopped the driver) — not a crash
          return finalizeRun(state, "failed", false, "failed by human");
        }
        return finalizeRun(state, "failed", true, result.reason);
      }

      // unreachable for valid outcomes — defensive, never spin the visit loop
      return finalizeRun(state, "failed", true, "internal error: unhandled visit outcome");
    }
  }

  return finalizeRun(state, "success", false);
}

/** Drive one visit: phase_start → spawn session → prompt → corrections → settle.
 *
 * `continueInstruction` (T07): when set, the initial prompt is the
 * CONTINUE instruction — the interrupted phase's pi session is relaunched with
 * the SAME --session-id and told to carry on (pi rebuilds the context from the
 * session JSONL); the full composed prompt is only used on a fresh visit.
 */
async function driveVisit(
  state: LoopState,
  phase: BlueprintPhase,
  visit: number,
  handoff: Handoff | null,
  opts: { continueInstruction?: string | null; cause?: PhaseStartCause } = {},
): Promise<VisitOutcome> {
  const db = state.db;
  const phaseId = state.phaseIds.get(phase.name)!;
  const slug = slugFor(phase.name);
  const piSessionId = sessionIdFor(state.runId, phase.name, visit);
  const budget = phase.budget ?? DEFAULT_BUDGET;
  const now = state.now;
  const startedAt = now();
  // R1: the row's started_at is the phase's LIFETIME start (set on the FIRST
  // visit, never overwritten) — read it so a NULL one is stamped and a set
  // one survives a revisit
  const phaseRow = getPhaseByName(db, state.runId, phase.name);

  ctxEmit(state, "phase_start", { phase: phase.name, agent: phase.agent.name, visit, budget, cause: opts.cause }, { phase_id: phaseId });
  // R1: every visit re-opens the row — status in_progress,
  // ended_at NULL (the invariant: a phases row is NEVER in_progress with a
  // non-null ended_at), corrections reset to 0 (they count re-prompts issued
  // IN THE CURRENT VISIT), and started_at kept as the row's lifetime start.
  updatePhase(db, phaseId, {
    status: "in_progress",
    visits: visit,
    corrections: 0,
    started_at: phaseRow?.started_at ?? startedAt,
    ended_at: null,
  });
  state.phaseVisits.set(phase.name, visit);

  // #45: the visit is now a first-class row. It is CREATED here with its
  // cause + started_at (status in_progress, ended_at NULL), links its pi
  // session once one spawns, and transitions to a terminal status with
  // ended_at at the single exit below. The terminal status is derived from
  // the VisitOutcome kind (one source of truth), so a visit is never left
  // in_progress with a non-null ended_at.
  const visitId = randomUUID();
  insertPhaseVisit(db, {
    id: visitId,
    phase_id: phaseId,
    visit_number: visit,
    cause: opts.cause === undefined ? null : JSON.stringify(opts.cause),
    status: "in_progress",
    started_at: startedAt,
    ended_at: null,
    agent_session_id: null,
  });
  const finishVisit = (outcome: VisitOutcome): VisitOutcome => {
    updatePhaseVisit(db, visitId, { status: outcome.kind, ended_at: now() });
    return outcome;
  };

  // hooks: onPhaseStart, with ctx.shell(). A thrown hook is NOT a run
  // crash — the phase ends failed, the failure is audited as a human_action
  // hook_error event, and the loop parks the run at the hook_failed menu.
  if (state.blueprint.onPhaseStart) {
    try {
      await state.blueprint.onPhaseStart(hookContext(state, phase.name));
    } catch (err) {
      const reason = `onPhaseStart threw: ${messageOf(err)}`;
      ctxEmit(
        state,
        "human_action",
        { action: "hook_error", detail: `phase "${phase.name}" ${reason}` },
        { phase_id: phaseId },
      );
      return finishVisit({ kind: "hook_failed", reason, corrections: 0 });
    }
  }

  const outputsDir = outputsDirFor(state.runDir, phase.name);
  mkdirSync(outputsDir, { recursive: true });

  // ── the session driver seam (T02) ─────────────────────────────────────
  // SHOWRUNNER_SMOKE=1 drives the real pi binary; the default build drives
  // scripted FakePi sessions. Both speak the same SessionDriver interface, so
  // this block never touches the child process directly — spawn, RPC command
  // writing, stdout framing, stderr capture, and lifecycle live in
  // packages/daemon/src/pi/.
  const useRealPi = sessionDriverKind() === "real";

  // tracer: folds this visit's stream into tool_call/spend/agent_end
  const tracer = new Tracer({
    phase: phase.name,
    visit,
    agent: phase.agent.name,
    model: phase.agent.model,
    roster: state.roster,
    piSessionId,
    sink: (evt) => ctxEmit(state, evt.type, evt.data, { phase_id: phaseId, agent_session_id: agentSessionId }),
    rawAppend: (line, final) => state.rawFile.append(line, final),
  });

  let settleCount = 0;
  // every raw line is handed to the tracer verbatim (append-before-parse);
  // the driver watches the same lines for agent_settled
  const feedLine = (line: string, final = false): void => {
    tracer.onLine(line, { final });
    if (isSettledLine(line)) settleCount += 1;
  };

  let driver: SessionDriver;
  if (useRealPi) {
    driver = new PiSession({
      sessionId: piSessionId,
      cwd: state.cwd,
      onLine: feedLine,
      stderrLimit: MAX_CAPTURED_STDERR,
    });
  } else {
    const script = state.scripts[phase.name];
    if (!script) {
      // script presence is validated at submit; this guards the direct-API path
      // (#45: route through finishVisit so the phase_visits row inserted above
      // reaches a terminal status + ended_at instead of orphaning in_progress)
      return finishVisit({ kind: "crash", reason: `no scripted session for phase "${phase.name}"`, corrections: 0 });
    }
    // per-visit scripting (R7 fixture seam): byVisit[visit] replaces the
    // default turns for THIS visit — the same ScriptedTurn[] shape, so a
    // phase can behave differently on its first visit vs a redrive (review
    // v1 fails twice, review v2 passes). Strictly additive: absent byVisit
    // (or a missing visit key) falls back to `turns`, and when it does the
    // ORIGINAL session object is passed through untouched — byte-identical
    // to the pre-extension session file for every existing script.
    const turns = script.byVisit?.[visit] ?? script.turns;
    // the scripted session file lives in the run dir — the run record is self-contained
    const sessionFile = join(state.runDir, "sessions", `${slug}-v${visit}.json`);
    driver = new FakeSessionDriver({
      sessionId: piSessionId,
      cwd: state.cwd,
      script: turns === script.turns ? script : { ...script, turns },
      sessionFile,
      outputsDir,
      delayMs: state.delayMs,
      onLine: feedLine,
      stderrLimit: MAX_CAPTURED_STDERR,
    });
  }
  const pid = driver.pid;

  const agentSessionId = randomUUID();
  insertAgentSession(db, {
    id: agentSessionId,
    run_id: state.runId,
    phase_id: phaseId,
    pi_session_id: piSessionId,
    visit,
    pid,
    started_at: now(),
    ended_at: null,
  });
  // #45: link the visit to the pi session that runs it
  updatePhaseVisit(db, visitId, { agent_session_id: agentSessionId });
  insertProcess(db, { id: agentSessionId, pid, kind: "agent", started_at: now() });
  writeAgentMap(state.runDir, phase.name, { pi_session_id: piSessionId, pid, visit, model: phase.agent.model });
  ctxEmit(state, "agent_start", { agent: phase.agent.name, pi_session_id: piSessionId, pid, model: phase.agent.model }, { phase_id: phaseId, agent_session_id: agentSessionId });
  // T04: the live session is reachable through the control surface — steer
  // writes the RPC steer to THIS driver, fail stops it
  state.control.setLiveSession({ driver, piSessionId, agentSessionId });

  // stderr is captured per run by the driver and written to stderr.log
  // on visit end — same convention T01a/T01b used, same byte shape downstream.

  // ── command writers over the same seam ────────────────────────────────────
  const sendCommand = (cmd: RpcCommand): void => {
    // fire-and-forget (corrections) — a dead stream surfaces via waitForSettled
    void driver.send(cmd).catch(() => {});
  };
  const waitForSettled = (): Promise<void> => driver.waitForSettled();
  const sendPrompt = async (message: string): Promise<void> => {
    let res: RpcResponse;
    try {
      res = await driver.send({ type: "prompt", message }, FIRST_PROMPT_ACK_TIMEOUT_MS);
    } catch (err) {
      // ack timeout (the model catalog may refresh on the first command)
      // or a dead stream — neither crashes the run: a dead stream rejects the
      // settle waiter below, and a slow-but-alive agent still settles on its own
      if (driver.exitCode !== null) throw err;
      return;
    }
    if (!res.success) {
      throw new Error(`pi rejected prompt: ${res.error ?? "unknown error"}`);
    }
  };

  // ── the correction loop (steps 4–9) ───────────────────────────────────
  let corrections = 0;
  let outcome: VisitOutcome;
  try {
    await sendPrompt(
      opts.continueInstruction !== undefined && opts.continueInstruction !== null
        ? opts.continueInstruction
        : composePrompt(state, phase, handoff),
    );
    // pin (T13, #8): deliver steers queued while the run was paused —
    // the menu says 'then the visit continues', so the queued messages ride
    // this session's RPC stream (queued between turns, no message id).
    // The drain is per-spawn: a live steer was delivered immediately and never
    // enters the queue, so nothing here double-sends; a queued steer whose
    // continuation spawned no session (gate override) rides the NEXT spawn.
    for (const steerMessage of state.control.drainQueuedSteers()) {
      sendCommand({ type: "steer", message: steerMessage });
    }
    for (;;) {
      await waitForSettled();
      const stage = await runEnvelopeStage({
        db,
        runId: state.runId,
        phaseId,
        phaseName: phase.name,
        agentSessionId,
        visit,
        attempt: corrections,
        cwd: state.cwd,
        runDir: state.runDir,
        envelopePath: join(outputsDir, "envelope.json"),
        schema: phase.envelope,
        gates: phase.gates,
        now,
        emit: state.emit,
        visitId,
      });
      if (stage.kind === "accepted") {
        outcome = { kind: "success", envelope: stage.envelope, raw: stage.raw, corrections };
        break;
      }
      if (stage.kind === "blocked") {
        outcome = { kind: "blocked", reason: stage.reason, corrections };
        break;
      }
      // invalid or gate violations → a correction (same session, one message)
      const reason = stage.kind === "invalid" ? "invalid_envelope" : "gate_violations";
      const message =
        stage.kind === "invalid" ? stage.error : `Gate violations: ${stage.violations.join("; ")}`;
      if (corrections >= budget) {
        outcome = {
          kind: "failed",
          reason: "budget_exhausted",
          corrections,
          // a rejected-by-gates last attempt is the override target
          lastEnvelopeId: stage.kind === "violations" ? stage.envelopeId : undefined,
        };
        break;
      }
      corrections += 1;
      // the correction that followed this attempt lives on its envelope row
      updateEnvelope(db, stage.envelopeId, { correction: message });
      updatePhase(db, phaseId, { corrections });
      ctxEmit(state, "correction", { phase: phase.name, visit, reason, message }, { phase_id: phaseId, agent_session_id: agentSessionId });
      sendCommand({ type: "prompt", message: message });
    }
  } catch (err) {
    // the session stream died while we were waiting for settle
    outcome = { kind: "crash", reason: messageOf(err), corrections };
  }

  // reap the session and finalize its accounting (agent_end, sessions row, processes)
  if (outcome.kind !== "crash") {
    await driver.close(); // stdin EOF → the process reaps itself (exit 0)
  } else if (driver.exitCode === null) {
    // the stream died on an internal error while the child is still alive —
    // never orphan it (fail-run semantics: SIGTERM, SIGKILL after 1s)
    await driver.stop();
  }
  tracer.onEnd({ exitCode: driver.exitCode }, { settled: outcome.kind !== "crash" && settleCount > 0 });
  updateAgentSession(db, agentSessionId, { ended_at: now() });
  deleteProcess(db, agentSessionId);
  state.control.setLiveSession(null);
  if (driver.stderr.length > 0) {
    writeFileSync(join(state.runDir, "stderr.log"), driver.stderr, { flag: "a" });
  }
  return finishVisit(outcome);
}

/** phase_end + row finalization; returns a hook error when onPhaseEnd threw. */
async function endPhase(
  state: LoopState,
  phase: BlueprintPhase,
  status: "success" | "failed",
  visit: number,
  corrections: number,
): Promise<{ hookError: string | null }> {
  let hookError: string | null = null;
  if (state.blueprint.onPhaseEnd) {
    try {
      await state.blueprint.onPhaseEnd(hookContext(state, phase.name));
    } catch (err) {
      hookError = messageOf(err);
      // the failure is audited like a human action — the phase_end below
      // carries status failed and the loop parks at the hook_failed menu
      ctxEmit(
        state,
        "human_action",
        { action: "hook_error", detail: `phase "${phase.name}" onPhaseEnd threw: ${hookError}` },
        { phase_id: state.phaseIds.get(phase.name)! },
      );
    }
  }
  const finalStatus = hookError === null ? status : "failed";
  ctxEmit(state, "phase_end", { phase: phase.name, status: finalStatus, visits: visit, corrections, spend_usd: state.phaseSpend.get(phase.name) ?? 0 }, { phase_id: state.phaseIds.get(phase.name)! });
  updatePhase(state.db, state.phaseIds.get(phase.name)!, {
    status: finalStatus,
    ended_at: state.now(),
    spend_usd: state.phaseSpend.get(phase.name) ?? 0,
  });
  return { hookError };
}

async function finalizeRun(
  state: LoopState,
  status: RunStatus,
  needsReview: boolean,
  reason?: string,
  from: RunStatus = "running",
): Promise<RunResult> {
  ctxEmit(state, "run_status", { from, to: status, reason }, { phase_id: null, agent_session_id: null });
  // T04 pin: a run driven from interrupted keeps its needs_review flag
  // even on a clean finish — the human glance was requested and success
  // does not silently clear it
  const effectiveReview = needsReview || state.resumed;
  updateRun(state.db, state.runId, {
    status,
    ended_at: status === "success" || status === "failed" ? state.now() : undefined,
    needs_review: effectiveReview ? 1 : 0,
  });
  state.rawFile.close();
  await state.sink.flush();
  return { status, needs_review: effectiveReview };
}

// ── the pause layer (T04) ─────────────────────────────────────────

/** Persist + surface a pause: run_status + row, then suspend the loop on
 * the run's control. `done` resolves here (a paused run is a stable state,
 * T01b compat); the run KEEPS its pool slot (F1) — the pool releases on
 * `terminal`, which stays pending until the run reaches a terminal state. */
async function pauseAt(state: LoopState, pause: PauseInfo): Promise<ControlAction> {
  state.control.setPause(pause);
  ctxEmit(state, "run_status", { from: "running", to: "paused", reason: pause.reason }, { phase_id: null, agent_session_id: null });
  updateRun(state.db, state.runId, { status: "paused" }); // ended_at stays null — resumable
  await state.sink.flush();
  state.control.markPaused({ status: "paused", needs_review: false });
  return state.control.waitForAction();
}

/** The run leaves a pause: run_status paused → running, the row back to running. */
function resumeFromPause(state: LoopState, reason: string): void {
  ctxEmit(state, "run_status", { from: "paused", to: "running", reason }, { phase_id: null, agent_session_id: null });
  updateRun(state.db, state.runId, { status: "running" });
}

/** The shared continuation for steer / restart-fresh: re-drive the phase
 * (steer queues its message on the control — delivered on the next
 * continuation, T07; restart-fresh makes a NEW visit/session). */
function menuDirective(
  state: LoopState,
  action: ControlAction,
): { directive: "fail" } | { directive: "redrive"; action: "restart" | "steer" } {
  if (action.kind === "fail") return { directive: "fail" };
  resumeFromPause(state, action.kind === "restart_fresh" ? "phase restarted fresh" : "steered");
  // R2: surface the human verb (mirrors the human_action event's action —
  // RunControl.restartFresh writes "restart", steers write "steer") so the
  // redriven visit's phase_start can stamp its cause
  return { directive: "redrive", action: action.kind === "restart_fresh" ? "restart" : "steer" };
}

/** A phase whose rejected envelope was approved by override records success
 * (the onPhaseEnd hook already ran on the failed end — no second hook). */
function markPhaseSuccess(state: LoopState, phase: BlueprintPhase, visit: number, corrections: number): void {
  ctxEmit(state, "phase_end", { phase: phase.name, status: "success", visits: visit, corrections, spend_usd: state.phaseSpend.get(phase.name) ?? 0 }, { phase_id: state.phaseIds.get(phase.name)! });
  updatePhase(state.db, state.phaseIds.get(phase.name)!, {
    status: "success",
    ended_at: state.now(),
    spend_usd: state.phaseSpend.get(phase.name) ?? 0,
  });
}

/** The budget-exhaustion pause info: the last rejected envelope (gate
 * violations) becomes the override target; an invalid last attempt has no
 * failed gates, so the menu drops override. */
function budgetPauseInfo(
  state: LoopState,
  phase: BlueprintPhase,
  result: Extract<VisitOutcome, { kind: "failed" }>,
): PauseInfo {
  const info: PauseInfo = {
    kind: "budget_exhausted",
    phase: phase.name,
    reason: `correction budget exhausted in phase "${phase.name}" (${result.corrections}/${phase.budget ?? DEFAULT_BUDGET})`,
  };
  if (result.lastEnvelopeId) {
    const row = getEnvelope(state.db, result.lastEnvelopeId);
    if (row && row.valid === 1) {
      info.envelopeId = result.lastEnvelopeId;
      info.envelopeRaw = row.json;
      try {
        info.envelope = JSON.parse(row.json) as Envelope;
      } catch {
        // the row parsed at acceptance; a parse failure keeps override off
      }
      const failed = listFailedGateResults(state.db, result.lastEnvelopeId).map((r) => r.id);
      if (failed.length > 0) info.gateResultIds = failed;
    }
  }
  return info;
}

/** A mid-visit human abort (fail) the loop should honor — checked at visit
 * boundaries and when a stream dies (the control stopped the driver). */
function abortCheck(state: LoopState): "fail" | null {
  return state.control.takeAbort();
}

// ── context & handoff (full protocol — the implementation lives in handoff.ts) ──

/** materialization (handoff.ts): the predecessor's accepted envelope.json
 * and EVERY file it listed in `artifacts` land in <runDir>/<phase>/inputs/
 * — the zero-friction handoff. The first phase has no predecessor.
 */
export function materializeInputs(state: LoopState, phaseName: string, handoff: Handoff | null): void {
  materializeHandoff(state.runDir, phaseName, handoff);
}

/** Resolve context entries: walk agent defaults then phase additions;
 * readable files inline, everything else stays literal (handoff.ts). */
export function resolveContextEntries(state: LoopState, phase: BlueprintPhase): string[] {
  return resolveContext(state.cwd, state.moduleDir, [...phase.agent.context, ...(phase.context ?? [])]);
}

function ctxEmit(state: LoopState, type: EventType, data: unknown, ids?: EventIds): void {
  state.emit(type, data, ids);
}

/** FINDING-1: the run's `--prompt` user instruction. The CLI
 * sends it as `args: ["--prompt", <text>]`; the submit-time snapshot records
 * it verbatim in blueprint.json. The composed prompt renders it as the
 * [User request] section — the agent's actual goal. Null when the run was
 * submitted without a prompt (or the snapshot is unreadable — the helper
 * never throws, so composition stays best-effort). */
function userPromptFromSnapshot(state: LoopState): string | null {
  // tests build the state shape by hand without runDir — stay tolerant
  const runDir = (state as { runDir?: string }).runDir;
  if (typeof runDir !== "string" || runDir === "") return null;
  let snap: { args?: unknown };
  try {
    snap = JSON.parse(readFileSync(join(runDir, "blueprint.json"), "utf8")) as { args?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(snap.args)) return null;
  for (let i = 0; i < snap.args.length; i++) {
    if (snap.args[i] === "--prompt" && typeof snap.args[i + 1] === "string" && snap.args[i + 1] !== "") {
      return snap.args[i + 1]!;
    }
  }
  return null;
}

/** The composed prompt: workspace + phase + agent + context + handoff + envelope contract. */
export function composePrompt(
  state: LoopState,
  phase: BlueprintPhase,
  handoff: Handoff | null,
): string {
  const context = resolveContextEntries(state, phase);
  const handoffJson = handoff === null ? null : JSON.stringify(handoff.envelope, null, 2);
  const lines = [
    `[Phase] ${state.blueprint.name} → ${phase.name}`,
    `[Agent] ${phase.agent.name} (${phase.agent.model})`,
    "",
    phase.agent.prompt,
  ];
  // FINDING-1: the submit-time `--prompt "<goal>"` is the agent's instruction
  // (the skills' `showrunner run <bp> --prompt "…"` contract). It rides right
  // after the agent's own prompt, before any context — the goal comes first.
  const userPrompt = userPromptFromSnapshot(state);
  if (userPrompt !== null) {
    lines.push("", "[User request]", userPrompt);
  }
  // this run's workspace lives in the RUN RECORD DIR, never the repo —
  // the harness writes nothing under the run's cwd. The agent works wherever
  // the run's cwd points (the project); its inputs and outputs live under the
  // named run dir, addressed relative to it.
  const slug = slugFor(phase.name);
  lines.push(
    "",
    "[Workspace]",
    `${state.runDir}   (this run's record dir — your per-phase inputs/outputs live here, addressed relative to it)`,
    `  ${slug}/inputs/    — what the harness materialized for you (read-only)`,
    `  ${slug}/outputs/   — where YOU write your files: envelope.json plus anything you list in artifacts`,
  );
  // [Context] = the context entries plus the materialized handoff
  // inputs — each inputs/ path named with its contents inlined, so the agent
  // never hunts for the predecessor's envelope or artifacts.
  const contextLines: string[] = [...context];
  if (handoff !== null) {
    for (const { rel, contents } of readHandoffInputs(state.runDir, phase.name)) {
      contextLines.push(`${slug}/inputs/${rel}:`, contents);
    }
  }
  if (contextLines.length > 0) {
    lines.push("", "[Context]", ...contextLines);
  }
  lines.push("", "[Handoff from previous phase]", handoffJson ?? "(none — first phase)");
  lines.push(
    "",
    "[Envelope contract]",
    renderSchema(phase.envelope),
    "Return your final result as a JSON object matching this schema, written to",
    `${phaseDirFor(state.runDir, phase.name)}/outputs/envelope.json`,
    "",
    `[Tools available] ${phase.agent.tools.join(", ")}`,
  );
  return lines.join("\n");
}

function hookContext(state: LoopState, phaseName: string): PhaseHookContext {
  return {
    run_id: state.runId,
    cwd: state.cwd,
    phase: phaseName,
    shell: (cmd: string) => runShell(state.cwd, cmd),
  };
}

/** shell(): one subprocess one-liner, full result. Runs TRULY async
 * (spawn, promisified — never spawnSync): a hook command must not block the
 * daemon's event loop (backpressure; the FINDING-1 freeze was the hook
 * shell AND the gate shell both blocking on spawnSync). The 30s cap is kept
 * — a hook that exceeds it returns code -1 (the hook decides how to fail). */
async function runShell(cwd: string, cmd: string): Promise<ShellResult> {
  return createShell(cwd, { timeoutMs: 30_000 })(cmd);
}

// ── agent_map.json ─────────────────────────────────────────────────────
// writeAgentMap/readAgentMap live in handoff.ts (T05): per-visit overwrite
// (a revisited phase records its LATEST session), restart-fresh per run dir.

// ── the schema rendering (human + snapshot + prompt) ─────────────

export function renderSchema(schema: z.ZodTypeAny): string {
  try {
    const merged = EnvelopeBase.merge(schema as z.ZodObject<z.ZodRawShape>);
    return renderType(merged as z.ZodTypeAny);
  } catch {
    return schema.description ?? "any";
  }
}

function renderType(s: z.ZodTypeAny): string {
  // zod schema introspection by typeName, not instanceof — the daemon and the
  // blueprint module resolve different zod copies, so instanceof fails across
  // them while _def.typeName is stable and copy-agnostic
  const typeName = (s as unknown as { _def?: { typeName?: string } })._def?.typeName ?? "unknown";
  switch (typeName) {
    case "ZodOptional": {
      const inner = (s as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
      return `${renderType(inner)} (optional)`;
    }
    case "ZodNullable": {
      const inner = (s as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
      return `${renderType(inner)} | null`;
    }
    case "ZodDefault": {
      const inner = (s as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      return `${renderType(inner)} (default)`;
    }
    case "ZodArray": {
      const element = (s as unknown as { element: z.ZodTypeAny }).element;
      return `${renderType(element)}[]`;
    }
    case "ZodObject": {
      const shape = (s as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      // each field's .describe() text rides into the contract — the agent must
      // see WHAT each field means ("files you WROTE to outputs/", not just
      // `string[]`), or it fills artifacts with files it merely read
      const fields = Object.entries(shape).map(([k, v]) => {
        const doc = describeOf(v);
        return `  ${k}: ${renderType(v)}${doc !== null ? ` — ${doc}` : ""}`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum": {
      const options = (s as unknown as { options: readonly string[] }).options;
      return options.map((o) => JSON.stringify(o)).join(" | ");
    }
    case "ZodLiteral":
      return JSON.stringify((s as unknown as { value: unknown }).value);
    case "ZodRecord": {
      const valueSchema = (s as unknown as { valueSchema: z.ZodTypeAny }).valueSchema;
      return `record<string, ${renderType(valueSchema)}>`;
    }
    default:
      return "any";
  }
}

function describeOf(s: z.ZodTypeAny): string | null {
  const outer = (s as { description?: string | null }).description;
  if (typeof outer === "string" && outer !== "") return outer;
  // optional/nullable wrap the described schema — fall through to the inner
  const unwrap = (s as { unwrap?: () => z.ZodTypeAny }).unwrap;
  if (typeof unwrap === "function") {
    const inner = describeOf(unwrap.call(s));
    if (inner !== null) return inner;
  }
  const defaultOf = (s as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
  if (defaultOf !== undefined) {
    const inner = describeOf(defaultOf);
    if (inner !== null) return inner;
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── entry points ─────────────────────────────────────────────────────────────

/**
 * Run an in-memory blueprint against scripted sessions — the test/direct API.
 * Creates the run rows and drives to a terminal state immediately.
 */
export function runBlueprint(
  db: Database,
  dataDir: string,
  opts: Omit<RunBlueprintOptions, "db" | "dataDir">,
): BlueprintRun {
  const maxVisits = opts.maxVisits ?? DEFAULT_MAX_VISITS;
  const delayMs = opts.delayMs ?? 0;
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = createRunRows(db, dataDir, {
    blueprint: opts.blueprint,
    cwd: opts.cwd,
    moduleDir: opts.moduleDir ?? null,
    maxVisits,
  });
  return driveState(db, dataDir, {
    blueprint: opts.blueprint,
    cwd: opts.cwd,
    moduleDir: opts.moduleDir ?? null,
    maxVisits,
    delayMs,
    now,
    runId,
    scripts: opts.scripts,
  });
}

/** Drive a prepared run (server path — behind the pool). */
export function drivePreparedRun(
  db: Database,
  dataDir: string,
  prepared: PreparedRun,
  opts: { maxVisits?: number; delayMs?: number } = {},
): BlueprintRun {
  const maxVisits = opts.maxVisits ?? prepared.maxVisits ?? DEFAULT_MAX_VISITS;
  const delayMs = opts.delayMs ?? prepared.delayMs ?? 0;
  return driveState(db, dataDir, {
    blueprint: prepared.blueprint,
    cwd: prepared.cwd,
    moduleDir: prepared.moduleDir,
    maxVisits,
    delayMs,
    now: () => new Date().toISOString(),
    runId: prepared.runId,
    scripts: prepared.scripts,
  });
}

/** Prepare + drive immediately (no pool) — convenience for tests and direct use. */
export async function submitBlueprintRun(
  db: Database,
  dataDir: string,
  opts: { modulePath: string; cwd?: string; maxVisits?: number; delayMs?: number },
): Promise<BlueprintRun> {
  const prepared = await prepareBlueprintRun(db, dataDir, opts);
  return drivePreparedRun(db, dataDir, prepared);
}

// ── resume (T07): continue an interrupted run from the last completed phase ─

/**
 * The continue instruction — what the resumed visit's pi session hears
 * instead of the full composed prompt. The session was relaunched with the
 * SAME --session-id, so pi has already rebuilt the context from the session
 * JSONL; this nudge names the phase, the interrupted state, and the envelope
 * contract the agent must still satisfy.
 */
export function composeContinuePrompt(blueprint: Blueprint, phase: BlueprintPhase, runDir: string): string {
  return [
    `[Phase] ${blueprint.name} → ${phase.name}`,
    "[Resume] your previous session for this phase was interrupted by a daemon",
    "restart. The session context has been restored — continue the work from",
    "where you left off, complete the phase, and write your final result to",
    `${phaseDirFor(runDir, phase.name)}/outputs/envelope.json.`,
    "",
    "[Envelope contract]",
    renderSchema(phase.envelope),
  ].join("\n");
}

/** The prepared-resume bundle: the rebuilt PreparedRun plus the resume spec. */
export interface PreparedResume {
  prepared: PreparedRun;
  resume: ResumeSpec;
}

/**
 * Prepare the resume of an INTERRUPTED run: record the attempt + the
 * needs_review pin (T04's resumeInterruptedRun), re-import the blueprint
 * module from the snapshot (the run record is self-contained — the
 * snapshot carries the module path and max_visits), re-resolve the scripted
 * sessions, and compute the resume point: the first phase whose recorded
 * status is not `success` is the interrupted one, and its recorded visit is
 * re-visited as-is (the SAME --session-id). The predecessor's last
 * accepted envelope (runDir/envelope.json) becomes the handoff — phases
 * already success are never re-run. Throws on a non-interrupted run or when
 * the snapshot/module cannot be rebuilt (the run stays interrupted — the
 * human can retry).
 */
export async function prepareResume(
  db: Database,
  dataDir: string,
  runId: string,
  opts: { by?: string } = {},
): Promise<PreparedResume> {
  const run = getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  if (run.status !== "interrupted") {
    throw new Error(`run ${runId} is ${run.status}, not interrupted — resume is the interrupted-run continue verb`);
  }

  // ALL fallible prep first (snapshot read, module import, scripts): a failure
  // here must leave the run interrupted, not a zombie `running` with nothing
  // driving it.
  const runDir = runDirFor(dataDir, runId);
  let snap: { module: string | null; max_visits?: number };
  try {
    snap = JSON.parse(readFileSync(join(runDir, "blueprint.json"), "utf8")) as {
      module: string | null;
      max_visits?: number;
    };
  } catch {
    throw new Error(`run ${runId} has no readable blueprint snapshot — cannot resume`);
  }
  if (typeof snap.module !== "string" || snap.module === "") {
    throw new Error(`run ${runId}'s snapshot carries no module path — cannot resume`);
  }
  const blueprint = await loadBlueprintModule(snap.module);
  const moduleDir = dirname(snap.module);
  const scripts = resolveScriptedSessions(blueprint, join(moduleDir, FAKE_SESSION_DIR));

  // T04 pin: the resume attempt is audited + needs_review is flagged
  resumeInterruptedRun(db, runId, opts.by);
  // the continuation is real — the run leaves interrupted before driving
  updateRun(db, runId, { status: "running" });

  // the resume point: the first phase that did not complete
  const phaseRows = listPhases(db, runId);
  const rowByName = new Map(phaseRows.map((p) => [p.name, p]));
  const resumePhase =
    blueprint.phases.find((p) => rowByName.get(p.name)?.status !== "success") ??
    blueprint.phases[blueprint.phases.length - 1]!;
  const phaseRow = rowByName.get(resumePhase.name);
  const visit = Math.max(1, phaseRow?.visits ?? 1);

  // the handoff: the predecessor's last accepted envelope (runDir/envelope.json
  // is overwritten on every acceptance, so it holds the LAST accepted one — the
  // predecessor's, since the interrupted phase never accepted)
  const predIndex = blueprint.phases.findIndex((p) => p.name === resumePhase.name) - 1;
  let handoff: Handoff | null = null;
  if (predIndex >= 0) {
    const pred = blueprint.phases[predIndex]!;
    try {
      const raw = readFileSync(join(runDir, "envelope.json"), "utf8");
      handoff = { envelope: JSON.parse(raw) as Envelope, raw, fromPhase: pred.name };
    } catch {
      handoff = null; // no accepted predecessor on record — start the phase bare
    }
  }

  return {
    prepared: {
      runId,
      blueprint,
      cwd: run.cwd,
      scripts,
      moduleDir,
      maxVisits: snap.max_visits ?? DEFAULT_MAX_VISITS,
    },
    resume: {
      phase: resumePhase.name,
      visit,
      continueInstruction: composeContinuePrompt(blueprint, resumePhase, runDir),
      handoff,
      by: opts.by,
    },
  };
}

/** Drive a prepared resume (server path — behind the pool, like a fresh run). */
export function driveResumedRun(
  db: Database,
  dataDir: string,
  preparedResume: PreparedResume,
  opts: { delayMs?: number } = {},
): BlueprintRun {
  const { prepared, resume } = preparedResume;
  return driveState(db, dataDir, {
    blueprint: prepared.blueprint,
    cwd: prepared.cwd,
    moduleDir: prepared.moduleDir,
    maxVisits: prepared.maxVisits ?? DEFAULT_MAX_VISITS,
    delayMs: opts.delayMs ?? 0,
    now: () => new Date().toISOString(),
    runId: prepared.runId,
    scripts: prepared.scripts,
  }, resume);
}

function driveState(
  db: Database,
  dataDir: string,
  opts: InitOptions & { runId: string; scripts: ScriptMap },
  resume?: ResumeSpec,
): BlueprintRun {
  // hardening (T13, #12): a synchronous initState throw — e.g. a
  // prices.json that became malformed between submit (validated at the 400)
  // and drive (the roster is re-read once per run, snapshot
  // doctrine) — must NOT strand the run in "running" with nothing driving it.
  let state: LoopState;
  try {
    state = initState(db, dataDir, opts);
  } catch (err) {
    return failRunNoState(db, opts.runId, `internal error: ${messageOf(err)}`);
  }
  if (resume !== undefined) {
    // a resumed run is NOT re-submitted — it leaves `interrupted` and
    // re-enters `running` (the run_submitted event belongs to the
    // original submission only)
    state.resumed = true;
    state.emit(
      "run_status",
      { from: "interrupted", to: "running", reason: "resumed by human (continue verb)" },
      { phase_id: null, agent_session_id: null },
    );
    updateRun(db, opts.runId, { status: "running" });
  } else {
    // the submitted→running transition fires when the run STARTS
    // driving. The run_submitted event fired earlier, at ACCEPTANCE
    // (createRunRows) — F2: a pool-queued run is submitted before it drives.
    state.emit("run_status", { from: "submitted", to: "running" }, { phase_id: null, agent_session_id: null });
  }
  const control = state.control;
  void (async () => {
    try {
      control.markTerminal(await driveLoop(state, resume));
    } catch (err) {
      // never leave a run stuck in "running" on an internal error
      try {
        const from = control.paused ? "paused" : "running";
        control.markTerminal(await finalizeRun(state, "failed", true, `internal error: ${messageOf(err)}`, from));
      } catch {
        control.markTerminal({ status: "failed", needs_review: true });
      }
    } finally {
      unregisterControl(state.runId);
    }
  })();
  return { run_id: opts.runId, done: control.stable, terminal: control.terminal };
}

/**
 * Finalize a run whose loop state could not be constructed (an initState
 * throw — T13 #12). The run row already exists with run_submitted on
 * record (createRunRows), so the honest terminal state is failed, not a
 * zombie "running": a run_status event records the reason and needs_review is
 * flagged (a human should see why the drive could not start). There is no
 * control handle (initState never got that far), so the run's promises are
 * plain resolved-failed promises — the server's pool slot is released via the
 * normal terminal path.
 */
function failRunNoState(db: Database, runId: string, reason: string): BlueprintRun {
  const ts = new Date().toISOString();
  insertEvent(db, {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "run_status",
    ts,
    data: { from: "running", to: "failed", reason },
  });
  updateRun(db, runId, { status: "failed", ended_at: ts, needs_review: 1 });
  const result: RunResult = { status: "failed", needs_review: true };
  const done = Promise.resolve(result);
  return { run_id: runId, done, terminal: done };
}
