import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  DEFAULT_BUDGET,
  EnvelopeBase,
  validateBlueprint,
} from "@showrunner/core";
import type {
  Blueprint,
  BlueprintPhase,
  Envelope,
  EventType,
  PhaseHookContext,
  RunStatus,
  ShellResult,
  Spend,
} from "@showrunner/core";
import { runDirFor } from "@showrunner/core";

import {
  materializeHandoff,
  readHandoffInputs,
  recordAcceptedEnvelope,
  resolveContext,
  slugFor,
  writeAgentMap,
} from "./handoff.ts";
import type { Handoff } from "./handoff.ts";

import {
  deleteProcess,
  getEnvelope,
  insertAgentSession,
  insertPhase,
  insertProcess,
  insertRun,
  updateAgentSession,
  updateEnvelope,
  updatePhase,
  updateRun,
} from "./db.ts";
import { registerControl, unregisterControl, RunControl } from "./pause-control.ts";
import type { ControlAction, PauseInfo } from "./pause-control.ts";
import { MAX_CAPTURED_STDERR, sessionIdFor } from "./driver.ts";
import { gateName, runEnvelopeStage } from "./envelope-runner.ts";
import { EventSink } from "./queue.ts";
import type { EventIds } from "./queue.ts";
import { RawOutputFile } from "./rawfile.ts";
import { loadRoster } from "./roster.ts";
import type { Roster } from "./roster.ts";
import { Tracer } from "./tracer.ts";
import {
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  sessionDriverKind,
} from "./pi/index.ts";
import type { RpcCommand, RpcResponse, SessionDriver } from "./pi/index.ts";

/**
 * The run loop (spec §5, T01b) — the state machine that drives a blueprint's
 * phases to completion. The loop itself is driver-agnostic: per visit (§5.2)
 * it materializes the predecessor handoff → visit guard (visits >= max_visits
 * → pause) → obtains the session driver (§8, T02: the real pi binary when
 * SHOWRUNNER_SMOKE=1, scripted FakePi sessions otherwise; session id
 * `<run8>_<phase>_v<visit>`, §8.1) → sends the composed prompt → tails/folds
 * events until agent_settled → zod-validates envelope.json → blocked? → gates →
 * records the envelope → next phase. Corrections re-prompt the SAME session
 * (one message naming exactly what was wrong) against the phase's budget
 * (default 3); exhaustion routes through `on_fail` (new visit) or pauses.
 *
 * The envelope/gate stage lives in envelope-runner.ts (T03's seam); the §9
 * context/handoff protocol lives in handoff.ts (T05) — this loop calls
 * materializeHandoff at visit start and recordAcceptedEnvelope on acceptance.
 * Hooks (§14) run in-process with a shell() helper. The §5.4 pool is
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
   * paths listed in envelope.artifacts become the next phase's inputs (§9.3) */
  artifacts?: Record<string, string>;
}

export interface ScriptedSession {
  turns: ScriptedTurn[];
  /** emit the very last event without a trailing newline (§10 byte-identical raw) */
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
   * (§5.4: a paused run keeps its pool slot, cheap — no pi process alive) */
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
  /** the blueprint module's directory, for context-entry file fallback (§9.2) */
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

// ── blueprint module loading + validation (§3.5, §13.3) ──────────────────────

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
 * sessions, create the run/phase rows and the §6 run events. Returns the
 * prepared run; driving it is drivePreparedRun (server-side, behind the pool).
 */
export async function prepareBlueprintRun(
  db: Database,
  dataDir: string,
  opts: { modulePath: string; cwd?: string; maxVisits?: number; delayMs?: number },
): Promise<PreparedRun> {
  const modulePath = isAbsolute(opts.modulePath) ? opts.modulePath : join(process.cwd(), opts.modulePath);
  // fail fast on a malformed prices.json (§11.1): a broken roster is a config
  // error — surface it at submit (a 400), not as a run stuck mid-drive. The
  // roster itself is re-read once per run in initState (the §13.3 snapshot
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
  });
  return { runId, blueprint, cwd, scripts, moduleDir, maxVisits: opts.maxVisits, delayMs: opts.delayMs };
}

// ── run/phase rows, events, snapshot (§4, §13.3) ─────────────────────────────

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
  /** the §11.1 price roster from {data_dir}/prices.json — the estimate path */
  roster: Roster;
  rawFile: RawOutputFile;
  sink: EventSink;
  /** the pause & control surface (T04) — pauses suspend here, verbs dispatch here */
  control: RunControl;
  emit: (type: EventType, data: unknown, ids?: EventIds) => void;
}

/** Create the run row, pending phase rows, §6 run events, and the §13.3 snapshot. */
function createRunRows(
  db: Database,
  dataDir: string,
  opts: { blueprint: Blueprint; cwd: string; moduleDir: string | null; modulePath?: string | null; maxVisits?: number },
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
  for (const phase of opts.blueprint.phases) {
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
    });
  }
  // §13.3: the rendered configuration is snapshotted at submit time, so later
  // edits to the blueprint never mutate an in-flight run
  snapshotBlueprint(runDir, opts.blueprint, opts.maxVisits ?? DEFAULT_MAX_VISITS, opts.modulePath ?? null);
  return runId;
}

/** Build the loop state over an existing run (rows already created). */
function initState(db: Database, dataDir: string, opts: InitOptions & { runId: string }): LoopState {
  const runId = opts.runId;
  const runDir = runDirFor(dataDir, runId);
  mkdirSync(runDir, { recursive: true });
  const sink = new EventSink(db, { runId, phaseId: null, agentSessionId: null });
  const phaseIds = new Map<string, string>();
  for (const phase of opts.blueprint.phases) {
    // rows are created by createRunRows; ids are their own — look them up
    const row = findPhaseRow(db, runId, phase.name);
    phaseIds.set(phase.name, row?.id ?? randomUUID());
  }
  const phaseVisits = new Map<string, number>();
  const phaseSpend = new Map<string, number>();
  // §11.1: the price roster is loaded once per run (a broken prices.json is a
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

function findPhaseRow(db: Database, runId: string, name: string) {
  return db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM phases WHERE run_id = ? AND name = ? LIMIT 1",
    )
    .get(runId, name) ?? null;
}

/** The §13.3 snapshot: the rendered configuration, stored for drill-in. */
export function snapshotBlueprint(
  runDir: string,
  blueprint: Blueprint,
  maxVisits: number,
  modulePath?: string | null,
): void {
  const doc = {
    name: blueprint.name,
    module: modulePath ?? null,
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

async function driveLoop(state: LoopState): Promise<RunResult> {
  const bp = state.blueprint;
  const indexByName = new Map(bp.phases.map((p, i) => [p.name, i]));
  let pending: string | null = bp.phases[0]?.name ?? null;
  let handoff: Handoff | null = null;

  while (pending !== null) {
    const phase = bp.phases.find((p) => p.name === pending);
    if (!phase) {
      return finalizeRun(state, "failed", true, `internal error: unknown phase "${pending}"`);
    }

    // per-phase visit loop (T04): a human restart-fresh re-enters it with a new visit
    let phaseApproved = false; // §5.2 step 1 — one approval per phase entry
    let restarted = false; // a human restart bypasses the visit guard for this phase

    for (;;) {
      if (abortCheck(state) === "fail") {
        // a mid-visit human fail with no pause waiter — not a crash
        return finalizeRun(state, "failed", false, "failed by human");
      }

      // 1. require_approval? (§5.2 step 1) — pause before spawn; approve → spawn
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

      // 2. materialize the predecessor handoff (§9.3: envelope + artifacts)
      materializeInputs(state, phase.name, handoff);

      // 3. visit guard (§5.2 step 3, §19): visits >= max_visits → pause
      const currentVisits = state.phaseVisits.get(phase.name) ?? 0;
      if (!restarted && currentVisits >= state.maxVisits) {
        const action = await pauseAt(state, {
          kind: "guard_exhausted",
          phase: phase.name,
          reason: `max_visits (${state.maxVisits}) reached for phase "${phase.name}"`,
        });
        const d = menuDirective(state, action);
        if (d.directive === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        restarted = true;
        continue;
      }
      const visit = currentVisits + 1;

      const result = await driveVisit(state, phase, visit, handoff);

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
          restarted = true;
          continue;
        }
        handoff = { envelope: result.envelope, raw: result.raw, fromPhase: phase.name };
        // §10: the accepted envelope lands in the run's raw record, verbatim
        recordAcceptedEnvelope(state.runDir, result.raw);
        const idx = indexByName.get(phase.name)!;
        pending = idx + 1 < bp.phases.length ? bp.phases[idx + 1]!.name : null;
        break;
      }

      if (result.kind === "blocked") {
        // §3.2: never routed through on_fail; the phase stays in_progress on the human
        const action = await pauseAt(state, {
          kind: "blocked",
          phase: phase.name,
          reason: `blocked in phase "${phase.name}": ${result.reason}`,
        });
        const d = menuDirective(state, action);
        if (d.directive === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        restarted = true;
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
        restarted = true;
        continue;
      }

      if (result.kind === "failed") {
        // budget exhausted (§5.2): on_fail routes a failed phase, else the human menu
        await endPhase(state, phase, "failed", visit, result.corrections);
        if (phase.on_fail) {
          pending = phase.on_fail.to;
          break;
        }
        const action = await pauseAt(state, budgetPauseInfo(state, phase, result));
        if (action.kind === "fail") {
          return finalizeRun(state, "failed", false, `failed by ${action.by ?? "human"}`, "paused");
        }
        if (action.kind === "restart_fresh" || action.kind === "steer") {
          const d = menuDirective(state, action);
          void d;
          restarted = true;
          continue;
        }
        if (action.kind === "override") {
          // T03's dispatch already overrode the failed gates and recorded the
          // acceptance (§6 #8) — the envelope becomes the phase's accepted handoff
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
        // stream died before agent_settled (§8.3): needs_review for a human
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

/** Drive one visit: phase_start → spawn session → prompt → corrections → settle. */
async function driveVisit(
  state: LoopState,
  phase: BlueprintPhase,
  visit: number,
  handoff: Handoff | null,
): Promise<VisitOutcome> {
  const db = state.db;
  const phaseId = state.phaseIds.get(phase.name)!;
  const slug = slugFor(phase.name);
  const piSessionId = sessionIdFor(state.runId, phase.name, visit);
  const budget = phase.budget ?? DEFAULT_BUDGET;
  const now = state.now;
  const startedAt = now();

  ctxEmit(state, "phase_start", { phase: phase.name, agent: phase.agent.name, visit, budget }, { phase_id: phaseId });
  updatePhase(db, phaseId, { status: "in_progress", visits: visit, started_at: startedAt });
  state.phaseVisits.set(phase.name, visit);

  // hooks (§14): onPhaseStart, with ctx.shell()
  if (state.blueprint.onPhaseStart) {
    try {
      await state.blueprint.onPhaseStart(hookContext(state, phase.name));
    } catch (err) {
      return { kind: "hook_failed", reason: `onPhaseStart threw: ${messageOf(err)}`, corrections: 0 };
    }
  }

  const outputsDir = join(state.cwd, "context_handoff", slug, "outputs");
  mkdirSync(outputsDir, { recursive: true });

  // ── the session driver seam (§8, T02) ─────────────────────────────────────
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
  const isSettledLine = (line: string): boolean => {
    try {
      const o = JSON.parse(line) as { type?: unknown };
      return o.type === "agent_settled";
    } catch {
      return false;
    }
  };
  // every raw line is handed to the tracer verbatim (append-before-parse, §10);
  // the driver watches the same lines for agent_settled (§8.3)
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
      return { kind: "crash", reason: `no scripted session for phase "${phase.name}"`, corrections: 0 };
    }
    // the scripted session file lives in the run dir — the run record is self-contained
    const sessionFile = join(state.runDir, "sessions", `${slug}-v${visit}.json`);
    driver = new FakeSessionDriver({
      sessionId: piSessionId,
      cwd: state.cwd,
      script,
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
  insertProcess(db, { id: agentSessionId, pid, kind: "agent", started_at: now() });
  writeAgentMap(state.runDir, phase.name, { pi_session_id: piSessionId, pid, visit, model: phase.agent.model });
  ctxEmit(state, "agent_start", { agent: phase.agent.name, pi_session_id: piSessionId, pid, model: phase.agent.model }, { phase_id: phaseId, agent_session_id: agentSessionId });
  // T04: the live session is reachable through the control surface — steer
  // writes the RPC steer to THIS driver (§8.4), fail stops it (§8.3)
  state.control.setLiveSession({ driver, piSessionId, agentSessionId });

  // stderr is captured per run by the driver (§8.3) and written to stderr.log
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
      // ack timeout (the model catalog may refresh on the first command, §8.1)
      // or a dead stream — neither crashes the run: a dead stream rejects the
      // settle waiter below, and a slow-but-alive agent still settles on its own
      if (driver.exitCode !== null) throw err;
      return;
    }
    if (!res.success) {
      throw new Error(`pi rejected prompt: ${res.error ?? "unknown error"}`);
    }
  };

  // ── the correction loop (§5.2 steps 4–9) ───────────────────────────────────
  let corrections = 0;
  let outcome: VisitOutcome;
  try {
    await sendPrompt(composePrompt(state, phase, handoff));
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
        envelopePath: join(outputsDir, "envelope.json"),
        schema: phase.envelope,
        gates: phase.gates,
        now,
        emit: state.emit,
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
          // a rejected-by-gates last attempt is the override target (§5.3)
          lastEnvelopeId: stage.kind === "violations" ? stage.envelopeId : undefined,
        };
        break;
      }
      corrections += 1;
      // §16.8: the correction that followed this attempt lives on its envelope row
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
    await driver.close(); // stdin EOF → the process reaps itself (exit 0, §8.3)
  } else if (driver.exitCode === null) {
    // the stream died on an internal error while the child is still alive —
    // never orphan it (fail-run semantics: SIGTERM, SIGKILL after 1s, §8.3)
    await driver.stop();
  }
  tracer.onEnd({ exitCode: driver.exitCode }, { settled: settleCount > 0 });
  updateAgentSession(db, agentSessionId, { ended_at: now() });
  deleteProcess(db, agentSessionId);
  state.control.setLiveSession(null);
  if (driver.stderr.length > 0) {
    writeFileSync(join(state.runDir, "stderr.log"), driver.stderr, { flag: "a" });
  }
  return outcome;
}

/** phase_end + row finalization; returns a hook error when onPhaseEnd threw (§14). */
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
  updateRun(state.db, state.runId, {
    status,
    ended_at: status === "success" || status === "failed" ? state.now() : undefined,
    needs_review: needsReview ? 1 : 0,
  });
  state.rawFile.close();
  await state.sink.flush();
  return { status, needs_review: needsReview };
}

// ── the pause layer (T04, spec §5.3) ─────────────────────────────────────────

/** Persist + surface a pause (§5.1): run_status + row, then suspend the loop on
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

/** The shared §5.3 continuation for steer / restart-fresh: re-drive the phase
 * (steer queues its message on the control — delivered on the next
 * continuation, T07; restart-fresh makes a NEW visit/session). */
function menuDirective(state: LoopState, action: ControlAction): { directive: "fail" | "redrive" } {
  if (action.kind === "fail") return { directive: "fail" };
  resumeFromPause(state, action.kind === "restart_fresh" ? "phase restarted fresh" : "steered");
  return { directive: "redrive" };
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
      const failed = state.db
        .query<{ id: string }, [string]>("SELECT id FROM gate_results WHERE envelope_id = ? AND pass = 0")
        .all(result.lastEnvelopeId)
        .map((r) => r.id);
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

// ── context & handoff (§9 full protocol — the implementation lives in handoff.ts) ──

/** §9.3 materialization (handoff.ts): the predecessor's accepted envelope.json
 * and EVERY file it listed in `artifacts` land in context_handoff/<phase>/inputs/
 * — the zero-friction handoff. The first phase has no predecessor.
 */
export function materializeInputs(state: LoopState, phaseName: string, handoff: Handoff | null): void {
  materializeHandoff(state.cwd, phaseName, handoff);
}

/** Resolve context entries (§9.2): walk agent defaults then phase additions;
 * readable files inline, everything else stays literal (handoff.ts). */
export function resolveContextEntries(state: LoopState, phase: BlueprintPhase): string[] {
  return resolveContext(state.cwd, state.moduleDir, [...phase.agent.context, ...(phase.context ?? [])]);
}

function ctxEmit(state: LoopState, type: EventType, data: unknown, ids?: EventIds): void {
  state.emit(type, data, ids);
}

/** The composed prompt (§8.2): phase + agent + context + handoff + envelope contract. */
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
  // §8.2 [Context] = the §9.2 context entries plus the §9.3 materialized handoff
  // inputs — each inputs/ path named with its contents inlined, so the agent
  // never hunts for the predecessor's envelope or artifacts (§9.3).
  const contextLines: string[] = [...context];
  if (handoff !== null) {
    for (const { rel, contents } of readHandoffInputs(state.cwd, phase.name)) {
      contextLines.push(`context_handoff/${slugFor(phase.name)}/inputs/${rel}:`, contents);
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
    `context_handoff/${slugFor(phase.name)}/outputs/envelope.json`,
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

/** §3.7 shell(): one subprocess one-liner, full result. */
async function runShell(cwd: string, cmd: string): Promise<ShellResult> {
  const res = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: 30_000 });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ── agent_map.json (§10) ─────────────────────────────────────────────────────
// writeAgentMap/readAgentMap live in handoff.ts (T05): per-visit overwrite
// (a revisited phase records its LATEST session), restart-fresh per run dir.

// ── the §3.5 / §8.2 schema rendering (human + snapshot + prompt) ─────────────

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
      const fields = Object.entries(shape).map(([k, v]) => `  ${k}: ${renderType(v)}`);
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

function driveState(
  db: Database,
  dataDir: string,
  opts: InitOptions & { runId: string; scripts: ScriptMap },
): BlueprintRun {
  const state = initState(db, dataDir, opts);
  // §6 #1/#2: run-level events, tagged with NULL phase/session ids
  state.emit("run_submitted", { blueprint: state.blueprint.name, cwd: state.cwd }, { phase_id: null, agent_session_id: null });
  state.emit("run_status", { from: "submitted", to: "running" }, { phase_id: null, agent_session_id: null });
  const control = state.control;
  void (async () => {
    try {
      control.markTerminal(await driveLoop(state));
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
