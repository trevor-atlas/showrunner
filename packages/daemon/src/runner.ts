import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
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
import { fakeSessionEntryPath } from "@showrunner/core/test/fixtures";
import { runDirFor } from "@showrunner/core";

import {
  deleteProcess,
  insertAgentSession,
  insertPhase,
  insertProcess,
  insertRun,
  updateAgentSession,
  updatePhase,
  updateRun,
} from "./db.ts";
import { MAX_CAPTURED_STDERR, sessionIdFor } from "./driver.ts";
import { gateName, runEnvelopeStage } from "./envelope-runner.ts";
import { LineSplitter } from "./linesplit.ts";
import { EventSink } from "./queue.ts";
import type { EventIds } from "./queue.ts";
import { RawOutputFile } from "./rawfile.ts";
import { Tracer } from "./tracer.ts";

/**
 * The run loop (spec §5, T01b) — the state machine that drives a blueprint's
 * phases to completion against FakePi sessions.
 *
 * Per visit (§5.2): materialize the predecessor handoff → visit guard
 * (visits >= max_visits → pause) → spawn the FakePi session (session id
 * `<run8>_<phase>_v<visit>`, §8.1) → send the composed prompt → tail/fold
 * events until agent_settled → zod-validate envelope.json → blocked? → gates →
 * record envelope → next phase. Corrections re-prompt the SAME session
 * (one message naming exactly what was wrong) against the phase's budget
 * (default 3); exhaustion routes through `on_fail` (new visit) or pauses.
 *
 * The envelope/gate stage lives in envelope-runner.ts (T03's seam). The
 * full §9 context/handoff protocol is T05 — this loop writes only
 * context_handoff/<phase>/inputs/envelope.json (the predecessor's accepted
 * envelope). Hooks (§14) run in-process with a shell() helper. The §5.4 pool
 * is server-side (pool.ts).
 */

export const DEFAULT_MAX_VISITS = 3;
export const FAKE_SESSION_DIR = "fake-pi";

// ── scripted session seam (the FakePi side of the loop) ──────────────────────

export interface ScriptedTurn {
  /** raw pi JSONL event objects, streamed verbatim (sessionId is injected) */
  events: Record<string, unknown>[];
  /** the envelope.json the agent "writes" at the end of this turn */
  envelope: Record<string, unknown>;
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
  done: Promise<RunResult>;
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

/** Sanitize a phase name into a URL-safe slug for context_handoff/ (§9.1). */
export function slugFor(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
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
  const modulePath = isAbsolute(opts.modulePath) ? opts.modulePath : join(process.cwd(), opts.modulePath);  const blueprint = await loadBlueprintModule(modulePath);
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
  rawFile: RawOutputFile;
  sink: EventSink;
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
  const rawFile = new RawOutputFile(join(runDir, "raw_output.jsonl"));
  const state: LoopState = {
    ...opts,
    db,
    dataDir,
    runId,
    runDir,
    phaseIds,
    phaseVisits,
    phaseSpend,
    rawFile,
    sink,
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
  | { kind: "failed"; reason: "budget_exhausted"; corrections: number }
  | { kind: "blocked"; reason: string; corrections: number }
  | { kind: "hook_failed"; reason: string; corrections: number }
  | { kind: "crash"; reason: string; corrections: number };

async function driveLoop(state: LoopState): Promise<RunResult> {
  const bp = state.blueprint;
  const indexByName = new Map(bp.phases.map((p, i) => [p.name, i]));
  let pending: string | null = bp.phases[0]?.name ?? null;
  let handoff: { envelope: Envelope; raw: string } | null = null;

  while (pending !== null) {
    const phase = bp.phases.find((p) => p.name === pending);
    if (!phase) {
      return finalizeRun(state, "failed", true, `internal error: unknown phase "${pending}"`);
    }

    // 1. require_approval? (§5.2) — T04 owns the approve action
    if (phase.require_approval) {
      return finalizeRun(state, "paused", false, `approval required before phase "${phase.name}"`);
    }

    // 2. materialize predecessor handoff (minimal §9: envelope.json only)
    materializeInputs(state, phase.name, handoff);

    // 3. visit guard (§5.2, §19): visits >= max_visits → pause
    const currentVisits = state.phaseVisits.get(phase.name) ?? 0;
    if (currentVisits >= state.maxVisits) {
      return finalizeRun(
        state,
        "paused",
        false,
        `max_visits (${state.maxVisits}) reached for phase "${phase.name}"`,
      );
    }
    const visit = currentVisits + 1;

    const result = await driveVisit(state, phase, visit, handoff);

    if (result.kind === "success") {
      const ended = await endPhase(state, phase, "success", visit, result.corrections);
      if (ended.hookError) {
        return finalizeRun(state, "paused", false, `phase hook error in "${phase.name}": ${ended.hookError}`);
      }
      handoff = { envelope: result.envelope, raw: result.raw };
      // §10: envelope.json is the last accepted envelope, verbatim
      writeFileSync(join(state.runDir, "envelope.json"), result.raw);
      const idx = indexByName.get(phase.name)!;
      pending = idx + 1 < bp.phases.length ? bp.phases[idx + 1]!.name : null;
      continue;
    }

    if (result.kind === "blocked") {
      // §3.2: never routed through on_fail; the phase stays in_progress on the human
      return finalizeRun(state, "paused", false, `blocked in phase "${phase.name}": ${result.reason}`);
    }

    if (result.kind === "hook_failed") {
      const ended = await endPhase(state, phase, "failed", visit, result.corrections);
      void ended;
      return finalizeRun(state, "paused", false, `phase hook error in "${phase.name}": ${result.reason}`);
    }

    if (result.kind === "failed") {
      // budget exhausted (§5.2): on_fail routes a failed phase, else pause
      await endPhase(state, phase, "failed", visit, result.corrections);
      if (phase.on_fail) {
        pending = phase.on_fail.to;
        continue;
      }
      return finalizeRun(
        state,
        "paused",
        false,
        `correction budget exhausted in phase "${phase.name}" (${result.corrections}/${phase.budget ?? DEFAULT_BUDGET})`,
      );
    }

    // crash: stream died before agent_settled (§8.3) — needs_review for a human
    await endPhase(state, phase, "failed", visit, result.corrections);
    return finalizeRun(state, "failed", true, result.reason);
  }

  return finalizeRun(state, "success", false);
}

/** Drive one visit: phase_start → spawn session → prompt → corrections → settle. */
async function driveVisit(
  state: LoopState,
  phase: BlueprintPhase,
  visit: number,
  handoff: { envelope: Envelope; raw: string } | null,
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

  const script = state.scripts[phase.name];
  if (!script) {
    // script presence is validated at submit; this guards the direct-API path
    return { kind: "crash", reason: `no scripted session for phase "${phase.name}"`, corrections: 0 };
  }

  // the scripted session file lives in the run dir — the run record is self-contained
  const sessionFile = join(state.runDir, "sessions", `${slug}-v${visit}.json`);
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify(script));

  const outputsDir = join(state.cwd, "context_handoff", slug, "outputs");
  mkdirSync(outputsDir, { recursive: true });

  const child = spawn(
    process.execPath,
    [fakeSessionEntryPath(), sessionFile, "--session-id", piSessionId, "--output", outputsDir],
    { cwd: state.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_PI_DELAY_MS: String(state.delayMs) } },
  );
  const pid = child.pid ?? 0;

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
  writeAgentMap(state, phase.name, { pi_session_id: piSessionId, pid, visit, model: phase.agent.model });
  ctxEmit(state, "agent_start", { agent: phase.agent.name, pi_session_id: piSessionId, pid, model: phase.agent.model }, { phase_id: phaseId, agent_session_id: agentSessionId });

  // tracer: folds this visit's stream into tool_call/spend/agent_end
  const tracer = new Tracer({
    phase: phase.name,
    visit,
    agent: phase.agent.name,
    piSessionId,
    sink: (evt) => ctxEmit(state, evt.type, evt.data, { phase_id: phaseId, agent_session_id: agentSessionId }),
    rawAppend: (line, final) => state.rawFile.append(line, final),
  });

  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_CAPTURED_STDERR) stderrChunks.push(chunk.toString("utf8"));
  });

  // ── the stdout read loop (LF-only framing, §7.1) ───────────────────────────
  const decoder = new StringDecoder("utf8");
  const splitter = new LineSplitter();
  let settleWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  let settleCount = 0;
  const isSettledLine = (line: string): boolean => {
    try {
      const o = JSON.parse(line) as { type?: unknown };
      return o.type === "agent_settled";
    } catch {
      return false;
    }
  };
  const feedLine = (line: string, final: boolean): void => {
    tracer.onLine(line, { final });
    if (isSettledLine(line)) {
      settleCount += 1;
      const w = settleWaiter;
      settleWaiter = null;
      w?.resolve();
    }
  };
  const feedText = (text: string, final = false): void => {
    for (const line of splitter.push(text)) feedLine(line, final);
  };
  child.stdout.on("data", (chunk: Buffer) => feedText(decoder.write(chunk)));

  let finalExit: number | null = null;
  let reaping = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const failPending = (reason: string): void => {
    const w = settleWaiter;
    settleWaiter = null;
    w?.reject(new Error(reason));
  };
  child.on("error", (err: Error) => {
    finalExit = null;
    failPending(`failed to spawn fake session: ${err.message}`);
    resolveClosed();
  });
  child.on("close", (code: number | null) => {
    feedText(decoder.end());
    for (const line of splitter.flush()) feedLine(line, true); // final line: no invented \n
    finalExit = code;
    if (!reaping) failPending(`session died before agent_settled (exit ${code})`);
    resolveClosed();
  });

  const sendCommand = (cmd: Record<string, unknown>): void => {
    try {
      child.stdin.write(JSON.stringify(cmd) + "\n");
    } catch {
      // stdin is closed (crash); the settle waiter will surface it
    }
  };
  const waitForSettled = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      settleWaiter = { resolve, reject };
    });
  const reap = async (): Promise<void> => {
    reaping = true;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    await closed;
  };

  // ── the correction loop (§5.2 steps 4–9) ───────────────────────────────────
  sendCommand({ type: "prompt", message: composePrompt(state, phase, handoff) });

  let corrections = 0;
  let outcome: VisitOutcome;
  try {
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
        outcome = { kind: "failed", reason: "budget_exhausted", corrections };
        break;
      }
      corrections += 1;
      updatePhase(db, phaseId, { corrections });
      ctxEmit(state, "correction", { phase: phase.name, visit, reason, message }, { phase_id: phaseId, agent_session_id: agentSessionId });
      sendCommand({ type: "prompt", message: message });
    }
  } catch (err) {
    // the session stream died while we were waiting for settle
    outcome = { kind: "crash", reason: messageOf(err), corrections };
  }

  // reap the session and finalize its accounting (agent_end, sessions row, processes)
  if (outcome.kind !== "crash") await reap();
  tracer.onEnd({ exitCode: finalExit }, { settled: settleCount > 0 });
  updateAgentSession(db, agentSessionId, { ended_at: now() });
  deleteProcess(db, agentSessionId);
  if (stderrChunks.length > 0) {
    writeFileSync(join(state.runDir, "stderr.log"), stderrChunks.join(""), { flag: "a" });
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

async function finalizeRun(state: LoopState, status: RunStatus, needsReview: boolean, reason?: string): Promise<RunResult> {
  ctxEmit(state, "run_status", { from: "running", to: status, reason }, { phase_id: null, agent_session_id: null });
  updateRun(state.db, state.runId, {
    status,
    ended_at: status === "success" || status === "failed" ? state.now() : undefined,
    needs_review: needsReview ? 1 : 0,
  });
  state.rawFile.close();
  await state.sink.flush();
  return { status, needs_review: needsReview };
}

// ── context & handoff (§9 minimal, §8.2 prompt) ──────────────────────────────

/** Minimal §9 materialization (T05 owns the full protocol): write the
 * predecessor's accepted envelope.json into context_handoff/<phase>/inputs/.
 * The first phase has no predecessor.
 */
export function materializeInputs(state: LoopState, phaseName: string, handoff: { envelope: Envelope; raw: string } | null): void {
  if (!handoff) return;
  const inputsDir = join(state.cwd, "context_handoff", slugFor(phaseName), "inputs");
  mkdirSync(inputsDir, { recursive: true });
  writeFileSync(join(inputsDir, "envelope.json"), handoff.raw);
}

/** Resolve context entries (§9.2): read files in, else literal. Exact paths only. */
export function resolveContextEntries(state: LoopState, phase: BlueprintPhase): string[] {
  const entries = [...phase.agent.context, ...(phase.context ?? [])];
  const out: string[] = [];
  for (const entry of entries) {
    const file = resolveContextFile(state, entry);
    if (file !== null) out.push(readFileSync(file, "utf8"));
    else out.push(entry);
  }
  return out;
}

function resolveContextFile(state: LoopState, entry: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(entry)) candidates.push(entry);
  else {
    candidates.push(join(state.cwd, entry));
    if (state.moduleDir) candidates.push(join(state.moduleDir, entry));
  }
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      // keep walking
    }
  }
  return null;
}

function ctxEmit(state: LoopState, type: EventType, data: unknown, ids?: EventIds): void {
  state.emit(type, data, ids);
}

/** The composed prompt (§8.2): phase + agent + context + handoff + envelope contract. */
export function composePrompt(
  state: LoopState,
  phase: BlueprintPhase,
  handoff: { envelope: Envelope; raw: string } | null,
): string {
  const context = resolveContextEntries(state, phase);
  const handoffJson = handoff === null ? null : JSON.stringify(handoff.envelope, null, 2);
  const lines = [
    `[Phase] ${state.blueprint.name} → ${phase.name}`,
    `[Agent] ${phase.agent.name} (${phase.agent.model})`,
    "",
    phase.agent.prompt,
  ];
  if (context.length > 0) {
    lines.push("", "[Context]", ...context);
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

function writeAgentMap(
  state: LoopState,
  phaseName: string,
  entry: { pi_session_id: string; pid: number; visit: number; model: string },
): void {
  let map: Record<string, unknown> = {};
  const path = join(state.runDir, "agent_map.json");
  try {
    map = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // first entry
  }
  map[phaseName] = entry;
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n");
}

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
  let resolveDone: (r: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });
  void (async () => {
    try {
      resolveDone(await driveLoop(state));
    } catch (err) {
      // never leave a run stuck in "running" on an internal error
      try {
        resolveDone(await finalizeRun(state, "failed", true, `internal error: ${messageOf(err)}`));
      } catch {
        resolveDone({ status: "failed", needs_review: true });
      }
    }
  })();
  return { run_id: opts.runId, done };
}
