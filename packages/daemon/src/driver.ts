import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Database } from "bun:sqlite";
import type { Spend } from "@showrunner/core";
import { runDirFor } from "@showrunner/core";
import {
  FIXTURE_SCENARIOS,
  fakePiEntryPath,
  fixturePath,
  isFixtureName,
} from "@showrunner/core/test/fixtures";
import type { FixtureName } from "@showrunner/core/test/fixtures";

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
import { LineSplitter } from "./linesplit.ts";
import { EventSink } from "./queue.ts";
import { RawOutputFile } from "./rawfile.ts";
import { loadRoster } from "./roster.ts";
import { Tracer } from "./tracer.ts";

/**
 * The minimal submit path (T01a): create a run row + phase + one agent session
 * and drive one scripted FakePi session through it so every folded event
 * lands. There is deliberately no run-loop state machine here (no
 * envelope/gate/correction handling - T01b owns that); this is the
 * observation half of the tracer bullet.
 *
 * The raw record (§10) is written per run under {data_dir}/runs/<run_id>/:
 * raw_output.jsonl (verbatim, appended before parsing), agent_map.json, and
 * stderr.log when the child wrote diagnostics. envelope.json is written by the
 * envelope/gate orchestration (T01b), not here.
 */

export const DEFAULT_FIXTURE_AGENT = "builder";
export const DEFAULT_FIXTURE_MODEL = "fake-pi";
export const DEFAULT_FIXTURE_PHASE = "build";
export const DEFAULT_FIXTURE_DELAY_MS = 10;
export const MAX_CAPTURED_STDERR = 256 * 1024;

export interface SubmitOptions {
  fixture: FixtureName;
  cwd?: string;
  delayMs?: number;
  agent?: string;
  model?: string;
  phase?: string;
  /** diagnostic line for the FakePi child to write to stderr (§8.3 capture) */
  stderrLine?: string;
}

export interface SubmittedRun {
  run_id: string;
  phase_id: string;
  agent_session_id: string;
  /** resolves when the session has fully drained into SQLite */
  done: Promise<{ status: string; needs_review: boolean }>;
}

/** Sanitize a phase name into the pi session-id character set (§8.1). */
export function sessionIdFor(runId: string, phase: string, visit: number): string {
  const safe = phase.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${runId.slice(0, 8)}_${safe}_v${visit}`;
}

export function submitFixture(db: Database, dataDir: string, opts: SubmitOptions): SubmittedRun {
  if (!isFixtureName(opts.fixture)) {
    throw new Error(`unknown fixture "${String(opts.fixture)}" (expected one of: happy, gate-fail, crash)`);
  }

  const runId = randomUUID();
  const phaseId = randomUUID();
  const agentSessionId = randomUUID();
  const nowIso = (): string => new Date().toISOString();
  const cwd = opts.cwd ?? process.cwd();
  const agent = opts.agent ?? DEFAULT_FIXTURE_AGENT;
  const model = opts.model ?? DEFAULT_FIXTURE_MODEL;
  const phase = opts.phase ?? DEFAULT_FIXTURE_PHASE;
  const visit = 1;
  const budget = 3;
  const piSessionId = sessionIdFor(runId, phase, visit);
  // §11.1: the roster is read BEFORE any row is created — a malformed
  // prices.json is a config error that must fail fast with NO run row left
  // behind (a fixture submit returning 500 must not strand a zombie 'running'
  // run; the daemon survives either way — §13, T13 #5). The blueprint path
  // validates at submit (a clean 400); this path validates here, before insert.
  const roster = loadRoster(dataDir);
  const runDir = runDirFor(dataDir, runId);
  const startedAt = nowIso();

  mkdirSync(runDir, { recursive: true });

  insertRun(db, {
    id: runId,
    blueprint: `fixture:${opts.fixture}`,
    status: "running",
    cwd,
    needs_review: 0,
    started_at: startedAt,
    ended_at: null,
  });
  insertPhase(db, {
    id: phaseId,
    run_id: runId,
    name: phase,
    agent,
    status: "in_progress",
    visits: visit,
    corrections: 0,
    budget,
    spend_usd: 0,
    started_at: startedAt,
    ended_at: null,
  });
  insertAgentSession(db, {
    id: agentSessionId,
    run_id: runId,
    phase_id: phaseId,
    pi_session_id: piSessionId,
    visit,
    pid: 0,
    started_at: startedAt,
    ended_at: null,
  });

  const sink = new EventSink(db, { runId, phaseId: null, agentSessionId: null });
  let spendTotal = 0;
  // reviewer nit (T01b): run-level events carry NULL phase/session ids (§6);
  // phase/session events carry theirs. `emit` takes per-event overrides.
  const emit = (type: Parameters<EventSink["push"]>[0], data: unknown, ids?: { phase_id?: string | null; agent_session_id?: string | null }): void => {
    if (type === "spend") {
      spendTotal += (data as Spend).usd ?? 0;
    }
    sink.push(type, data, ids);
  };

  emit("run_submitted", { blueprint: `fixture:${opts.fixture}`, cwd }, { phase_id: null, agent_session_id: null });
  emit("run_status", { from: "submitted", to: "running" }, { phase_id: null, agent_session_id: null });
  emit("phase_start", { phase, agent, visit, budget }, { phase_id: phaseId });

  const rawFile = new RawOutputFile(join(runDir, "raw_output.jsonl"));
  const tracer = new Tracer({
    phase,
    visit,
    agent,
    model,
    roster,
    piSessionId,
    sink: (evt) => emit(evt.type as Parameters<EventSink["push"]>[0], evt.data, { phase_id: phaseId, agent_session_id: agentSessionId }),
    rawAppend: (line, final) => rawFile.append(line, final),
  });

  const fixture = opts.fixture;
  const scenario = FIXTURE_SCENARIOS[fixture];
  const delayMs = opts.delayMs ?? DEFAULT_FIXTURE_DELAY_MS;

  let finalized = false;
  let resolveDone: (v: { status: string; needs_review: boolean }) => void = () => {};
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<{ status: string; needs_review: boolean }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const child = spawn(process.execPath, [fakePiEntryPath(), fixturePath(fixture)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FAKE_PI_DELAY_MS: String(delayMs),
      FAKE_PI_EXIT_CODE: String(scenario.exitCode),
      ...(opts.stderrLine !== undefined ? { FAKE_PI_STDERR: opts.stderrLine } : {}),
    },
  });

  emit("agent_start", { agent, pi_session_id: piSessionId, pid: child.pid ?? 0, model }, { phase_id: phaseId, agent_session_id: agentSessionId });
  insertProcess(db, { id: agentSessionId, pid: child.pid ?? 0, kind: "agent", started_at: nowIso() });
  writeFileSync(
    join(runDir, "agent_map.json"),
    JSON.stringify({ [phase]: { pi_session_id: piSessionId, pid: child.pid ?? 0, visit, model } }, null, 2) + "\n",
  );

  // stderr: real diagnostics live here (§8.3) - capture per run for crash debugging
  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_CAPTURED_STDERR) stderrChunks.push(chunk.toString("utf8"));
  });

  // The read loop (spec §7.1): split on `\n` only (StringDecoder keeps UTF-8
  // multi-byte sequences intact across chunk boundaries), append raw lines
  // verbatim before parsing, and never block on SQLite - the EventSink queue
  // drains on later ticks.
  const decoder = new StringDecoder("utf8");
  const splitter = new LineSplitter();
  const feedLines = (text: string, final = false): void => {
    for (const line of splitter.push(text)) tracer.onLine(line, { final });
  };
  child.stdout.on("data", (chunk: Buffer) => feedLines(decoder.write(chunk)));

  const finish = (exitCode: number | null, errorReason: string | null): void => {
    deleteProcess(db, agentSessionId);
    updateAgentSession(db, agentSessionId, { ended_at: nowIso() });
    rawFile.close();
    if (stderrChunks.length > 0) {
      writeFileSync(join(runDir, "stderr.log"), stderrChunks.join(""));
    }
    const settled = tracer.hasSettled;
    const succeeded = errorReason === null && settled && exitCode === 0;
    const status = succeeded ? "success" : "failed";
    const needsReview = !settled ? 1 : 0;
    const reason =
      errorReason ??
      (succeeded
        ? undefined
        : settled
          ? `agent exited after agent_settled with code ${exitCode}`
          : "agent stream ended before agent_settled");
    emit("phase_end", { phase, status, visits: 1, corrections: 0, spend_usd: spendTotal }, { phase_id: phaseId });
    updatePhase(db, phaseId, { status, ended_at: nowIso(), spend_usd: spendTotal });
    emit("run_status", { from: "running", to: status, reason }, { phase_id: null, agent_session_id: null });
    updateRun(db, runId, { status, ended_at: nowIso(), needs_review: needsReview });
    sink
      .flush()
      .then(() => resolveDone({ status, needs_review: needsReview === 1 }))
      .catch((err: unknown) => rejectDone(err instanceof Error ? err : new Error(String(err))));
  };

  child.on("error", (err: Error) => {
    if (finalized) return;
    finalized = true;
    tracer.onEnd({ exitCode: null });
    finish(null, `failed to spawn fake pi: ${err.message}`);
  });

  child.on("close", (code: number | null) => {
    if (finalized) return;
    finalized = true;
    // flush any partial final line (unterminated: no invented trailing \n), then close the stream
    feedLines(decoder.end());
    for (const line of splitter.flush()) tracer.onLine(line, { final: true });
    tracer.onEnd({ exitCode: code });
    finish(code, null);
  });

  return { run_id: runId, phase_id: phaseId, agent_session_id: agentSessionId, done };
}
