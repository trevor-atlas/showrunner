process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "../../src/core/index.ts";
import type { Blueprint, Envelope, Gate } from "../../src/core/index.ts";

import { cleanupDir, freePort, tmpDataDir } from "./helpers.ts";
import { getControl, reconcileInterruptedRuns, resumeInterruptedRun } from "../../src/server/engine/pause-control.ts";
import { FakeSessionDriver } from "../../src/server/engine/pi/index.ts";
import { RunPool } from "../../src/server/engine/pool.ts";
import { runBlueprint } from "../../src/server/engine/runner.ts";
import { daemonEntryPath, startDaemon } from "../../src/server/lifecycle.ts";
import { cursorEvents, getRun, insertRun, listAgentSessions, listEnvelopes, listGateResults, listPhases, openDb } from "../../src/server/repository/db.ts";
import { type BlueprintRun, type ScriptMap, type ScriptedTurn } from "../../src/server/engine/runner.ts";
import { type DaemonHandle } from "../../src/server/lifecycle.ts";

/**
 * The pause & control surface (T04) — human-in-the-loop machinery
 * on top of the T01b loop and T03's override seam: pause states (budget,
 * guard, blocked, approval, hook), the menu actions (steer / approve / override
 * / restart-fresh / fail), the needs_review pin, and the F1 pool-slot
 * hold. FakePi only — deterministic, no pi, no tokens.
 */

const QualityEnvelope = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });

function agent(name = "builder"): ReturnType<typeof defineAgent> {
  return defineAgent({
    name,
    model: "fake-pi",
    prompt: "execute the phase",
    tools: ["bash"],
    context: [],
  });
}

const alwaysFailGate: Gate = async () => ({ pass: false, violations: ["always failing"] });

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  return quality >= 7 ? { pass: true } : { pass: false, violations: [`quality ${quality} below 7`] };
};

function session(turns: ScriptedTurn[]): ScriptMap[string] {
  return { turns };
}

/** A single-turn script whose agent settles and writes an envelope. */
function settledTurn(extra: Record<string, unknown> = {}): ScriptedTurn {
  return {
    events: [
      { type: "agent_start", messageCount: 0, model: "fake-pi" },
      { type: "queue_update", queued: 0 },
      { type: "turn_start" },
      { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_start", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "ls" },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok\n" }] }, isError: false },
      { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
    envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 7, ...extra },
  };
}

/** A turn whose first tool call streams ~N update lines — a wide steer/fail window. */
function slowTurn(extra: Record<string, unknown> = {}, n = 120): ScriptedTurn {
  const events: Record<string, unknown>[] = [
    { type: "agent_start", messageCount: 0, model: "fake-pi" },
    { type: "turn_start" },
    { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
  ];
  for (let i = 0; i < n; i++) {
    events.push({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "slow" });
    events.push({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: `line ${i}` }] } });
  }
  events.push({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  events.push({ type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } });
  events.push({ type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } });
  events.push({ type: "agent_end", messages: [], willRetry: false });
  events.push({ type: "agent_settled" });
  return { events, envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 4, ...extra } };
}

function openEnv(label: string): { dir: string; db: ReturnType<typeof openDb>; cwd: string } {
  const dir = tmpDataDir(label);
  const db = openDb(join(dir, "showrunner.db"));
  const cwd = mkdtempSync(join(tmpdir(), "showrunner-cwd-"));
  return { dir, db, cwd };
}

function closeEnv(env: { dir: string; db: { close(): void }; cwd: string }): void {
  env.db.close();
  rmSync(env.cwd, { recursive: true, force: true });
  cleanupDir(env.dir);
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 8000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function humanActions(db: ReturnType<typeof openDb>, runId: string): { action: string; by?: string; detail: string }[] {
  return cursorEvents(db, runId, 0, 10_000)
    .filter((e) => e.type === "human_action")
    .map((e) => e.data as { action: string; by?: string; detail: string });
}

// ── budget exhaustion: persisted + visible; terminal only via a control verb ─

test("budget exhaustion pauses the run (persisted, visible); done resolves paused; fail reaches terminal", async () => {
  const env = openEnv("pause-budget");
  try {
    const blueprint = defineBlueprint({
      name: "stuck",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 2 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn(), settledTurn()]) },
    });

    // T01b compat: a paused run is a STABLE state — done resolves paused
    const stable = await run.done;
    expect(stable).toEqual({ status: "paused", needs_review: false });

    // persisted + visible via the DB (runs/show)
    const row = getRun(env.db, run.run_id)!;
    expect(row.status).toBe("paused");
    expect(row.ended_at).toBeNull(); // resumable — never a terminal end

    // events: corrections issued + run_status with from/to/reason
    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    const corrections = events.filter((e) => e.type === "correction");
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    const statuses = events.filter((e) => e.type === "run_status");
    const final = statuses[statuses.length - 1]!.data as { to: string; reason?: string };
    expect(final.to).toBe("paused");
    expect(final.reason).toMatch(/budget/);

    // F1: while paused the run is NOT terminal — the slot is still held
    let terminalResolved = false;
    void run.terminal.then(() => (terminalResolved = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(terminalResolved).toBe(false);

    // the pause menu's fail verb → terminal
    const control = getControl(run.run_id)!;
    expect(control.paused).toBe(true);
    expect(control.pauseInfo!.kind).toBe("budget_exhausted");
    control.fail("operator");
    const result = await run.terminal;
    expect(result).toEqual({ status: "failed", needs_review: false });
    const failed = getRun(env.db, run.run_id)!;
    expect(failed.status).toBe("failed");
    expect(failed.ended_at).toBeTruthy();
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "fail", by: "operator" }),
    );
    // fail at a pause: run_status from 'paused'
    const lastStatus = cursorEvents(env.db, run.run_id, 0, 10_000)
      .filter((e) => e.type === "run_status")
      .at(-1)!.data as { from: string; to: string };
    expect(lastStatus).toMatchObject({ from: "paused", to: "failed" });
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── restart phase fresh: a NEW visit, session id v<visit+1> ──────────────────

test("restart-fresh re-drives the phase as a NEW visit with session id v<visit+1>, audited", async () => {
  const env = openEnv("pause-restart");
  try {
    const blueprint = defineBlueprint({
      name: "fresh",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn(), settledTurn()]) },
    });
    expect((await run.done).status).toBe("paused");
    expect(listAgentSessions(env.db, run.run_id)).toHaveLength(1); // visit 1

    const control = getControl(run.run_id)!;
    control.restartFresh("operator");
    // the restarted visit also fails its budget → pauses again
    await waitFor(() => getControl(run.run_id)?.paused === true, 8000, "second pause");

    // a NEW visit: the new session is v2 with the id
    const sessions = listAgentSessions(env.db, run.run_id);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.pi_session_id).sort()).toEqual([
      `${run.run_id.slice(0, 8)}_build_v1`,
      `${run.run_id.slice(0, 8)}_build_v2`,
    ]);
    expect(sessions.map((s) => s.visit)).toEqual([1, 2]);

    // audited: the restart writes a human_action
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "restart", by: "operator", detail: expect.stringContaining("build") }),
    );

    control.fail("operator");
    expect((await run.terminal).status).toBe("failed");
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── approve: the require_approval pause proceeds to spawn ────────────────────

test("approve proceeds the require_approval pause to a real spawn; audited", async () => {
  const env = openEnv("pause-approve");
  try {
    const blueprint = defineBlueprint({
      name: "approve",
      phases: [{ name: "ship", agent: agent(), envelope: QualityEnvelope, gates: [], require_approval: true }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { ship: session([settledTurn()]) },
    });
    expect((await run.done).status).toBe("paused");
    // before approval: no spawn, phase still pending
    expect(listAgentSessions(env.db, run.run_id)).toHaveLength(0);
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("pending");

    const control = getControl(run.run_id)!;
    expect(control.pauseInfo!.kind).toBe("approval");
    control.approve("operator");

    const result = await run.terminal;
    expect(result).toEqual({ status: "success", needs_review: false });
    expect(listAgentSessions(env.db, run.run_id)).toHaveLength(1); // the spawn happened
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("success");

    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "approve", by: "operator", detail: expect.stringContaining("ship") }),
    );
    // the run left the pause before the phase started
    const approveIdx = events.findIndex((e) => e.type === "human_action" && (e.data as { action: string }).action === "approve");
    const phaseStartIdx = events.findIndex((e) => e.type === "phase_start");
    expect(approveIdx).toBeGreaterThanOrEqual(0);
    expect(phaseStartIdx).toBeGreaterThan(approveIdx);
    // approval pauses do not offer override/restart-fresh (nothing to restart)
    expect(control.pauseInfo).toBeNull(); // cleared after the action
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── override gate: the rejected envelope is approved and the run continues ───

test("override gate continues the run from the rejected envelope (row kept, acceptance recorded)", async () => {
  const env = openEnv("pause-override");
  try {
    const blueprint = defineBlueprint({
      name: "override",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 9 }), settledTurn({ quality: 9 })]) },
    });
    expect((await run.done).status).toBe("paused");

    // the pause carries the override target: the last rejected envelope + its failed gate
    const control = getControl(run.run_id)!;
    const info = control.pauseInfo!;
    expect(info.kind).toBe("budget_exhausted");
    expect(info.envelopeId).toBeTruthy();
    expect(info.gateResultIds).toHaveLength(1);

    control.overrideGate({ gate: "alwaysFailGate", by: "reviewer", reason: "manual review accepts quality 9" });

    const result = await run.terminal;
    expect(result).toEqual({ status: "success", needs_review: false });
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("success");

    // audit: the override human_action + the acceptance event
    const actions = humanActions(env.db, run.run_id);
    expect(actions).toContainEqual(
      expect.objectContaining({ action: "override_gate", by: "reviewer", detail: expect.stringContaining("alwaysFailGate") }),
    );
    const envelopeEvents = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "envelope");
    expect(envelopeEvents).toHaveLength(1); // recorded only on the overridden acceptance
    expect(envelopeEvents[0]!.data).toMatchObject({ phase: "build", valid: true });

    // T03: the original gate_results row is KEPT (pass 0) + the override badge
    const gates = listGateResults(env.db, run.run_id).filter((g) => g.envelope_id === info.envelopeId);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.pass).toBe(0);
    expect(gates[0]!.overridden).toBe(1);
    expect(gates[0]!.override_reason).toBe("manual review accepts quality 9");

    // the accepted envelope landed in the run's raw record
    const rawEnvelope = JSON.parse(
      readFileSync(join(env.dir, "runs", run.run_id, "envelope.json"), "utf8"),
    ) as { quality: number };
    expect(rawEnvelope.quality).toBe(9);
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── fail mid-run: kills the live child + terminal + audited ─────────────────

test("fail mid-run stops the live child (SIGTERM → SIGKILL) and reaches terminal", async () => {
  const env = openEnv("pause-fail-live");
  try {
    const blueprint = defineBlueprint({
      name: "slow",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([slowTurn()]) },
      delayMs: 3, // ~120 lines × 3ms: a wide window to fail mid-stream
    });

    // wait until the session is live (spawned, streaming)
    await waitFor(() => getControl(run.run_id)?.liveSessionId !== null, 8000, "live session");
    const pid = listAgentSessions(env.db, run.run_id)[0]!.pid;
    expect(pidAlive(pid)).toBe(true);

    getControl(run.run_id)!.fail("operator");

    const result = await run.terminal;
    expect(result).toEqual({ status: "failed", needs_review: false }); // deliberate, not a crash
    const row = getRun(env.db, run.run_id)!;
    expect(row.ended_at).toBeTruthy();
    // the child was killed (SIGTERM, SIGKILL after 1s via SessionDriver.stop())
    await waitFor(() => !pidAlive(pid), 5000, "child death");
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "fail", by: "operator" }),
    );
    // the processes row is gone (the loop reaps on visit end)
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("failed");
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the slow turn + child death needs more than the 5s default

// ── needs_review pin: mid-tool-call death, and ANY resume from interrupted ─

test("needs_review pin 1/2: mid-tool-call death (unsettled stream) flags needs_review", async () => {
  const env = openEnv("pause-review-death");
  try {
    const blueprint = defineBlueprint({
      name: "crashy",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    // a turn that dies mid tool call: the stream ends without agent_settled
    const crashingTurn: ScriptedTurn = {
      events: [
        { type: "agent_start", messageCount: 0, model: "fake-pi" },
        { type: "turn_start" },
        { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
        { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "hang" },
      ],
      envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 1 },
    };
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: { turns: [crashingTurn], exitAfterLastTurn: { code: 1 } } },
    });
    const result = await run.terminal;
    expect(result).toEqual({ status: "failed", needs_review: true });
    expect(getRun(env.db, run.run_id)!.needs_review).toBe(1);
    // the open tool call was flushed truncated
    const truncated = cursorEvents(env.db, run.run_id, 0, 10_000).filter(
      (e) => e.type === "tool_call" && (e.data as { truncated?: boolean }).truncated,
    );
    expect(truncated.length).toBeGreaterThanOrEqual(1);
  } finally {
    closeEnv(env);
  }
});

test("needs_review pin 2/2: daemon restart surfaces a running run as interrupted; ANY resume flags needs_review", async () => {
  const env = openEnv("pause-review-resume");
  try {
    // a run left 'running' by a dead daemon (no live children) — what recovery sees
    const runId = crypto.randomUUID();
    insertRun(env.db, {
      id: runId,
      blueprint: "crash-test",
      status: "running",
      cwd: env.cwd,
      needs_review: 0,
      started_at: new Date().toISOString(),
      ended_at: null,
    });

    const interrupted = reconcileInterruptedRuns(env.db);
    expect(interrupted).toContain(runId);
    const run = getRun(env.db, runId)!;
    expect(run.status).toBe("interrupted");
    const statusEvents = cursorEvents(env.db, runId, 0, 100).filter((e) => e.type === "run_status");
    expect(statusEvents.at(-1)!.data).toMatchObject({ from: "running", to: "interrupted" });
    // interruption itself does NOT flag needs_review (only mid-tool-call death
    // does — the pin) — the resume below is what flags it
    expect(getRun(env.db, runId)!.needs_review).toBe(0);

    // ANY resume from interrupted flags needs_review and leaves the run resumable
    const out = resumeInterruptedRun(env.db, runId, "operator");
    expect(out.needs_review).toBe(1);
    expect(getRun(env.db, runId)!.needs_review).toBe(1);
    expect(getRun(env.db, runId)!.status).toBe("interrupted"); // continuation is T07

    const resumeEvent = cursorEvents(env.db, runId, 0, 100).find(
      (e) => e.type === "human_action" && (e.data as { action: string }).action === "resume",
    )!;
    expect(resumeEvent.data).toMatchObject({ action: "resume", by: "operator" });

    // resume is the interrupted-run verb only — a non-interrupted run refuses it
    const doneRunId = crypto.randomUUID();
    insertRun(env.db, {
      id: doneRunId,
      blueprint: "crash-test",
      status: "success",
      cwd: env.cwd,
      needs_review: 0,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
    expect(() => resumeInterruptedRun(env.db, doneRunId, "x")).toThrow(/not interrupted/);
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── steer: same session between turns (queued, no message id), shows in the feed ─

test("steer mid-run reaches the SAME session between turns and shows in the feed", async () => {
  const env = openEnv("pause-steer-live");
  try {
    const blueprint = defineBlueprint({
      name: "steerable",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [qualityGate], budget: 3 }],
    });
    // turn 1 is slow (quality 4 → gate fail) so the steer lands mid-stream;
    // turn 2 passes. The steered turn's response is what the loop consumes.
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([slowTurn({ quality: 4 }, 120), settledTurn({ quality: 9 })]) },
      delayMs: 3,
    });

    await waitFor(() => getControl(run.run_id)?.liveSessionId !== null, 8000, "live session");
    getControl(run.run_id)!.steer("focus on the acceptance criteria", "operator");

    const result = await run.terminal;
    expect(result).toEqual({ status: "success", needs_review: false });

    // audited + in the feed
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "steer", by: "operator", detail: "focus on the acceptance criteria" }),
    );

    // the SAME session received it: one agent_session row, v1 (no new visit)
    const sessions = listAgentSessions(env.db, run.run_id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pi_session_id).toBe(`${run.run_id.slice(0, 8)}_build_v1`);

    // the steer actually reached the session: the fake consumed it as another
    // turn, so the raw stream has THREE agent_settled lines (turn1, steered
    // turn2, correction turn2) instead of two without the steer
    const raw = readFileSync(join(env.dir, "runs", run.run_id, "raw_output.jsonl"), "utf8");
    expect(raw.split("agent_settled").length - 1).toBe(3);
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the slow turn + steer window needs more than the 5s default

test("steer on a paused run: audited + queued, the run stays paused", async () => {
  const env = openEnv("pause-steer-paused");
  try {
    const blueprint = defineBlueprint({
      name: "stuck",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn(), settledTurn()]) },
    });
    expect((await run.done).status).toBe("paused");

    const control = getControl(run.run_id)!;
    control.steer("try harder", "operator");

    // the run STAYS paused; the steer is queued (delivery lands with the
    // continuation machinery — T07) and visible on the control
    expect(getRun(env.db, run.run_id)!.status).toBe("paused");
    expect(control.queuedSteerCount).toBe(1);
    expect(control.queuedSteerMessages).toEqual(["try harder"]);
    expect(humanActions(env.db, run.run_id)).toContainEqual(
      expect.objectContaining({ action: "steer", by: "operator", detail: "try harder" }),
    );
    // an empty message is rejected
    expect(() => control.steer("   ")).toThrow(/non-empty/);

    control.fail("operator");
    expect((await run.terminal).status).toBe("failed");
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

test("FakeSessionDriver speaks the RPC steer command: queued turns, no message id", async () => {
  const env = openEnv("pause-steer-driver");
  try {
    const settles: string[] = [];
    // the fake writes envelope.json to the runDir/phase/outputs path
    const outputsDir = join(env.dir, "runs", "steer-run", "build", "outputs");
    mkdirSync(outputsDir, { recursive: true });
    const driver = new FakeSessionDriver({
      sessionId: "steer_sess_v1",
      cwd: env.cwd,
      script: { turns: [settledTurn({ quality: 7 }), settledTurn({ quality: 8 })] },
      sessionFile: join(env.dir, "sessions", "steer.json"),
      outputsDir,
      onLine: (line) => {
        if (line.includes("agent_settled")) settles.push(line);
      },
    });
    // a steer command with NO message id is accepted and queued (FIFO) —
    // each queued steer advances the session one turn, like pi's queue
    const first = await driver.send({ type: "steer", message: "first" });
    expect(first.success).toBe(true);
    await waitFor(() => settles.length >= 1, 5000, "first steered turn");
    await driver.send({ type: "steer", message: "second" });
    await waitFor(() => settles.length >= 2, 5000, "second steered turn");
    await driver.close(); // stdin EOF → the fake drains its queue, then exits 0
    expect(settles).toHaveLength(2);
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // #9: the 5s default trips under parallel load

// ── F1: a paused run KEEPS its pool slot until terminal ──────────────

test("F1 (pool): a paused run holds its slot; the next queued run spawns only after terminal", async () => {
  const env = openEnv("pause-f1-pool");
  try {
    const stuckBp = defineBlueprint({
      name: "stuck",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
    });
    const happyBp = defineBlueprint({
      name: "happy",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });

    const pool = new RunPool(1);
    const started: string[] = [];
    let pausedControl: ReturnType<typeof getControl> = null;
    const bSlot: { run: BlueprintRun | null } = { run: null };

    // A: pauses on budget exhaustion; its slot frees only at TERMINAL (the
    // server wires run.terminal → pool.release, exactly like server.ts)
    pool.enqueue("A", () => {
      started.push("A");
      const run = runBlueprint(env.db, env.dir, {
        blueprint: stuckBp,
        cwd: env.cwd,
        scripts: { build: session([settledTurn(), settledTurn()]) },
      });
      pausedControl = getControl(run.run_id);
      void run.terminal.finally(() => pool.release("A"));
    });
    pool.enqueue("B", () => {
      started.push("B");
      bSlot.run = runBlueprint(env.db, env.dir, {
        blueprint: happyBp,
        cwd: env.cwd,
        scripts: { build: session([settledTurn({ quality: 9 })]) },
      });
      void bSlot.run.terminal.finally(() => pool.release("B"));
    });

    // A must be paused AND parked on its action waiter before we dispatch a
    // verb. The wait-for-condition polls `paused`, which flips at setPause —
    // BEFORE pauseAt() reaches waitForAction(): an async sink.flush() (a
    // setImmediate yield) sits between them. A fail() dispatched in that
    // window sets the mid-visit abort slot the parked loop never reads → the
    // loop hangs waiting for an action nobody resolves → the next waitFor
    // times out (~8s) under parallel load. Awaiting `stable` closes the race:
    // markPaused resolves it in the same synchronous continuation that then
    // registers the waiter, so the await resuming means fail() below lands on
    // the parked waiter.
    await waitFor(
      async () => {
        if (!started.includes("A")) return false;
        const control = pausedControl;
        if (control === null || !control.paused) return false;
        try {
          await control.stable;
        } catch {
          return false;
        }
        return true;
      },
      10_000,
      "A paused and parked on its action waiter",
    );
    expect(started).toEqual(["A"]);
    expect(pool.runningIds).toEqual(["A"]); // A holds the slot WHILE PAUSED
    expect(pool.queuedIds).toEqual(["B"]); // B is blocked behind paused A

    // fail A → terminal → the slot frees → B starts
    pausedControl!.fail("operator");
    await waitFor(() => started.includes("B"), 10_000, "B started");
    expect(pool.queuedIds).toEqual([]);
    expect(pool.runningIds).toEqual(["B"]);
    if (bSlot.run) await bSlot.run.terminal;
    await waitFor(() => pool.runningIds.length === 0, 5_000, "slot freed");
  } finally {
    closeEnv(env);
  }
}, { timeout: 30_000 }); // the internal waits total >5s — the 5s default trips under parallel load

// ── HTTP surface (the daemon's control endpoints behind the CLI verbs) ─

/** Raw probe over the daemon's merged HTTP server: every path below is
 * `/api`-prefixed (the web server dispatches /api/* to the api core). */
function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = new URL("/api" + path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port === "" ? undefined : url.port,
        method,
        path: url.pathname + url.search,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // keep raw text
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForStatus(baseUrl: string, runId: string, status: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(baseUrl, "GET", `/runs/${runId}`);
    const run = (json as { run: { status: string } }).run;
    if (run.status === status) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach ${status} in time`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Spawned daemons bind a FIXED port (SHOWRUNNER_PORT=<freePort> in the child
 * env) — there is no discovery file, so the test picks its port up front and
 * the base URL is that known port. Poll until the daemon answers /api/health
 * (a killed daemon's socket is released, so a reboot rebinds the same port). */
async function waitForDaemonUp(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  await waitFor(async () => {
    try {
      await api(baseUrl, "GET", "/health");
      return true;
    } catch {
      return false;
    }
  }, timeoutMs, "daemon up");
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("HTTP: approve + the pause viewer + steer land on a require_approval pause", async () => {
  const dir = tmpDataDir("pause-http");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-http-cwd-"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon({ dataDir: dir, port: 0 });
    // unix-mode daemon: the handle always binds a socket here (string)
    const baseUrl = daemon.baseUrl;
    const approvalBp = join(fixturesDir, "approval-blueprint.ts");
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: approvalBp, cwd: runCwd, delayMs: 0 });
    expect(sub.status).toBe(201);
    const runId = (sub.json as { run_id: string }).run_id;
    await waitForStatus(baseUrl, runId, "paused");

    // the pause viewer (the CLI's `pause` verb): kind, phase, menu, feed
    const viewer = (await api(baseUrl, "GET", `/runs/${runId}/pause`)).json as {
      paused: boolean;
      kind: string;
      phase: string;
      actions: string[];
    };
    expect(viewer.paused).toBe(true);
    expect(viewer.kind).toBe("approval");
    expect(viewer.phase).toBe("build");
    expect(viewer.actions).toContain("approve");

    // steer on the paused run: audited + queued, still paused
    const steered = await api(baseUrl, "POST", `/runs/${runId}/steer`, { message: "be careful", by: "cli" });
    expect(steered.status).toBe(200);
    expect((steered.json as { queued_steers: number }).queued_steers).toBe(1);

    // approve → the run proceeds to spawn and succeeds
    const approved = await api(baseUrl, "POST", `/runs/${runId}/approve`, { by: "cli" });
    expect(approved.status).toBe(200);
    await waitForStatus(baseUrl, runId, "success");

    const detail = (await api(baseUrl, "GET", `/runs/${runId}`)).json as { event_count: number };
    expect(detail.event_count).toBeGreaterThan(0);
    const events = (await api(baseUrl, "GET", `/runs/${runId}/events?cursor=0&limit=500`)).json as {
      events: { type: string; data: { action?: string; to?: string } }[];
    };
    const actions = events.events.filter((e) => e.type === "human_action").map((e) => e.data.action);
    expect(actions).toEqual(expect.arrayContaining(["steer", "approve"]));
    expect(events.events.some((e) => e.type === "run_status" && e.data.to === "paused")).toBe(true);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("F1 (server): a paused run blocks the next queued spawn while holding the slot", async () => {
  const dir = tmpDataDir("pause-f1-srv");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-f1-cwd-"));
  let daemon: DaemonHandle | null = null;
  try {
    // a 1-slot pool: the paused run occupies the only slot
    daemon = await startDaemon({ dataDir: dir, port: 0, poolSlots: 1 });
    // unix-mode daemon: the handle always binds a socket here (string)
    const baseUrl = daemon.baseUrl;
    const pauseBp = join(fixturesDir, "pause-blueprint.ts");
    const happyBp = join(fixturesDir, "happy-blueprint.ts");

    const a = await api(baseUrl, "POST", "/runs", { blueprint: pauseBp, cwd: runCwd, delayMs: 0 });
    const aId = (a.json as { run_id: string }).run_id;
    await waitForStatus(baseUrl, aId, "paused");

    const b = await api(baseUrl, "POST", "/runs", { blueprint: happyBp, cwd: runCwd, delayMs: 0 });
    const bId = (b.json as { run_id: string }).run_id;
    // B is queued behind paused A: its row exists (status 'running') and the
    // run_submitted event fired at ACCEPTANCE (F2) — but NO phase has
    // started, so the cursor holds exactly that one event
    await new Promise((r) => setTimeout(r, 60));
    const bQueued = (await api(baseUrl, "GET", `/runs/${bId}`)).json as {
      run: { status: string };
      event_count: number;
    };
    expect(bQueued.run.status).toBe("running");
    const bEvents = (await api(baseUrl, "GET", `/runs/${bId}/events?cursor=0&limit=10`)).json as {
      events: { type: string }[];
    };
    expect(bEvents.events).toHaveLength(1);
    expect(bEvents.events[0]!.type).toBe("run_submitted");

    // fail A → terminal → the slot frees → B spawns and completes. The fail
    // POST can land in the dispatch window (the run row says paused while
    // the loop is still between setPause and waitForAction — an async flush
    // yields in between), which would set the mid-visit abort slot the
    // parked loop never reads and leave A paused forever. The verb is
    // idempotent (audit + dispatch), so retry until A is actually terminal.
    await waitFor(
      async () => {
        await api(baseUrl, "POST", `/runs/${aId}/fail`, { by: "operator" });
        const { json } = await api(baseUrl, "GET", `/runs/${aId}`);
        return (json as { run: { status: string } }).run.status === "failed";
      },
      15_000,
      "A terminal after the fail POST",
    );
    await waitForStatus(baseUrl, bId, "success");
    const bDone = (await api(baseUrl, "GET", `/runs/${bId}`)).json as { event_count: number };
    expect(bDone.event_count).toBeGreaterThan(0);

    const aDone = (await api(baseUrl, "GET", `/runs/${aId}`)).json as {
      run: { status: string; ended_at: string | null };
    };
    expect(aDone.run.status).toBe("failed");
    expect(aDone.run.ended_at).toBeTruthy();
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test(
  " over HTTP: a daemon restart interrupts a running run; resume relaunches it to success (T07)",
  async () => {
    const dir = tmpDataDir("pause-restart-http");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-restart-cwd-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let daemonPid = 0;
  try {    // a SUBPROCESS daemon so we can actually kill it (in-process would kill the test)
    const boot = (): void => {
      const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dir], {
        stdio: "ignore",
        env: { ...process.env, SHOWRUNNER_POOL_SIZE: "1", SHOWRUNNER_PORT: String(port) },
      });
      child.unref();
      daemonPid = child.pid ?? 0;
    };
    boot();
    await waitForDaemonUp(baseUrl, 10_000);

    const happyBp = join(fixturesDir, "happy-blueprint.ts");
    const sub = await api(baseUrl, "POST", "/runs", { blueprint: happyBp, cwd: runCwd, delayMs: 60 });
    const runId = (sub.json as { run_id: string }).run_id;
    // wait until the agent is actually streaming (events exist), then SIGKILL
    await waitFor(async () => {
      const { json } = await api(baseUrl, "GET", `/runs/${runId}`);
      return ((json as { event_count: number }).event_count ?? 0) > 0;
    }, 10_000, "run started");
    process.kill(daemonPid, "SIGKILL");
    // wait for the listener to go DOWN — SIGKILL releases the socket, so the
    // restart re-binds the SAME fixed port cleanly
    await waitFor(async () => {
      try {
        await api(baseUrl, "GET", "/health");
        return false;
      } catch {
        return true;
      }
    }, 10_000, "daemon down");

    // restart: recovery surfaces the run as interrupted
    boot();
    await waitForDaemonUp(baseUrl, 10_000);
    await waitForStatus(baseUrl, runId, "interrupted");

    // resume: the pin — any resume from interrupted flags needs_review;
    // and the continuation is REAL (T07) — the interrupted phase's session is
    // relaunched with the same --session-id and the run drives to success
    const resume = await api(baseUrl, "POST", `/runs/${runId}/resume`, { by: "operator" });
    expect(resume.status).toBe(200);
    expect((resume.json as { needs_review: number }).needs_review).toBe(1);
    await waitForStatus(baseUrl, runId, "success");
    const detail = (await api(baseUrl, "GET", `/runs/${runId}`)).json as {
      run: { status: string; needs_review: number };
      sessions: { pi_session_id: string; visit: number }[];
    };
    expect(detail.run.status).toBe("success");
    // T04 pin: the resumed run KEEPS needs_review — success does not clear it
    expect(detail.run.needs_review).toBe(1);
    // the resumed visit reused the SAME session id — the crashed visit's
    // row (never ended) plus the resumed incarnation, both `..._build_v1` (no v2)
    const sessionIds = detail.sessions.map((s) => s.pi_session_id);
    expect(sessionIds).toHaveLength(2);
    expect(new Set(sessionIds)).toEqual(new Set([`${runId.slice(0, 8)}_build_v1`]));

    // resume is the interrupted-run verb only (409 for a paused/terminal run)
    const bad = await api(baseUrl, "POST", `/runs/${runId}/resume`, {});
    expect(bad.status).toBe(409);
  } finally {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runCwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });
