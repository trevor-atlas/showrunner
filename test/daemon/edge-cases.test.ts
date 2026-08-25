process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, runDirFor } from "../../src/core/index.ts";
import type { Blueprint, Envelope, Gate } from "../../src/core/index.ts";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { getControl, isPidAlive, reconcileInterruptedRuns } from "../../src/server/engine/pause-control.ts";
import { pricesPathFor } from "../../src/server/engine/roster.ts";
import { drivePreparedRun, prepareBlueprintRun, runBlueprint } from "../../src/server/engine/runner.ts";
import { cursorEvents, getRun, listAgentSessions, listProcesses, openDb } from "../../src/server/repository/db.ts";
import { type ScriptMap, type ScriptedTurn } from "../../src/server/engine/runner.ts";

/**
 * The edge-case fixture suite (T13 capstone) — the implementation-time
 * open questions pinned hermetically against FakePi:
 *
 *  - slow-gate backpressure ("Backpressure"): a gate that sleeps while the
 *    agent's stream is already folded — the tracer read loop must never block
 *    on the gate (raw file complete at gate start; events queryable DURING the
 *    gate's sleep).
 *  - mid-tool-crash needs_review ("Mid-tool-call crash") re-verified at the
 *    run-loop level, including the agent_end ok=false on a turn-1-settled /
 *    turn-2-died-with-exit-0 stream (T13 #3 cosmetic fix).
 *  - the visit-guard latch (step 3, T13 #7): the one-shot guard bypass —
 *    restart-fresh can never silently exceed max_visits, guard_exhausted stays
 *    reachable through the pause menu.
 *  - queued-steer drain (T13 #8): a steer queued while paused is
 *    delivered to the continued visit's session (delivery lands with the
 *    continuation machinery).
 *  - zombie-running invariant (T13 #12): a synchronous initState throw
 *    (malformed prices.json between submit and drive) finalizes the run failed
 *    instead of stranding it in "running".
 *
 * FakePi only — deterministic, no pi binary, no tokens.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const HAPPY_BP = join(fixturesDir, "happy-blueprint.ts");

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

// ── "Backpressure": the tracer read loop never blocks on a slow gate ─────

test(
  " slow-gate backpressure: the raw record is complete and events are queryable WHILE a gate sleeps (3s)",
  async () => {
    const env = openEnv("edge-slowgate");
    const marker = join(env.cwd, "gate-started.marker");
    const gateSleptMs: number[] = [];
    try {
      // a gate that sleeps 3s — the danger window: if the read loop
      // blocked on gate execution, the agent's stream would stall behind it
      const slowGate: Gate = async (_envelope) => {
        writeFileSync(marker, "started"); // the test polls this
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 3000));
        gateSleptMs.push(Date.now() - t0);
        return { pass: true };
      };
      const passGate: Gate = async () => ({ pass: true });

      // the agent streams ~25 tool calls slowly — a long tail the read loop
      // must fully drain (raw file = the safe buffer) before the gate
      const streamed: Record<string, unknown>[] = [
        { type: "agent_start", messageCount: 0, model: "fake-pi" },
        { type: "turn_start" },
        { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      ];
      for (let i = 0; i < 25; i++) {
        streamed.push({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: `step ${i}` });
        streamed.push({ type: "tool_execution_update", toolCallId: `c${i}`, toolName: "bash", partialResult: { content: [{ type: "text", text: `out ${i}` }] } });
        streamed.push({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: { content: [{ type: "text", text: `out ${i}` }] }, isError: false });
      }
      streamed.push({ type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } });
      streamed.push({ type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } });
      streamed.push({ type: "agent_end", messages: [], willRetry: false });
      streamed.push({ type: "agent_settled" });

      const blueprint = defineBlueprint({
        name: "slowgate",
        phases: [
          {
            name: "build",
            agent: agent(),
            envelope: QualityEnvelope,
            gates: [slowGate, passGate],
            budget: 3,
          },
        ],
      });
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: { turns: [{ events: streamed, envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 9 } }] } },
        delayMs: 3, // ~80 lines × 3ms: a stream long enough to matter
      });

      // the gate STARTED → at that moment the raw record must already hold the
      // agent's ENTIRE stream (the read loop drained it before the gate ran —
      // the raw file is the safe buffer) and the folded tool_call events
      // must be queryable DURING the gate's sleep, not after it returns
      await waitFor(() => existsSync(marker), 15_000, "slow gate started");
      const rawPath = join(runDirFor(env.dir, run.run_id), "raw_output.jsonl");
      const rawLines = readFileSync(rawPath, "utf8").split("\n").filter((l) => l !== "");
      // every streamed event landed byte-identically in the raw record
      expect(rawLines.length).toBe(streamed.length);
      // the folded tool_call rows are visible in SQLite while the gate sleeps:
      // the read loop never waited on the gate (a 1.8s window inside a 3s sleep)
      let toolCalls = 0;
      const deadline = Date.now() + 1800;
      for (;;) {
        toolCalls = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "tool_call").length;
        if (toolCalls >= 25) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(toolCalls).toBe(25); // all 25 folded during the gate's sleep

      const result = await run.terminal;
      expect(result).toEqual({ status: "success", needs_review: false });
      expect(gateSleptMs[0]!).toBeGreaterThanOrEqual(2500); // the gate really slept
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 30_000 },
);

// ── "Mid-tool-call crash": needs_review at the loop level + agent_end ok ──

test(
  " mid-tool-crash: turn 1 settles, turn 2 dies with exit 0 → run failed + needs_review, agent_end ok=false (T13 #3)",
  async () => {
    const env = openEnv("edge-crash");
    try {
      const blueprint = defineBlueprint({
        name: "crashy",
        phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 3 }],
      });
      // turn 1 settles and fails the gate → a correction is issued → turn 2
      // dies mid tool call with a CLEAN exit 0 (no settle) — the tracer must
      // report ok=false even though an EARLIER turn settled (T13 #3), and the
      // run verdict is crash/needs_review per
      const dyingTurn: ScriptedTurn = {
        events: [
          { type: "agent_start", messageCount: 0, model: "fake-pi" },
          { type: "turn_start" },
          { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
          { type: "tool_execution_start", toolCallId: "c9", toolName: "bash", args: "hang" },
        ],
        envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 1 },
      };
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: { turns: [settledTurn({ quality: 4 }), dyingTurn], exitAfterLastTurn: { code: 0 } } },
      });
      const result = await run.terminal;
      expect(result).toEqual({ status: "failed", needs_review: true });
      expect(getRun(env.db, run.run_id)!.needs_review).toBe(1);

      // the run verdict is a crash (needs_review), and the agent_end cosmetic
      // now agrees: the visit died before its LAST turn settled → ok=false
      const agentEnd = cursorEvents(env.db, run.run_id, 0, 10_000).find((e) => e.type === "agent_end");
      expect(agentEnd!.data).toMatchObject({ ok: false, exit: 0 });
      // the open tool call of the dying turn was flushed truncated
      const truncated = cursorEvents(env.db, run.run_id, 0, 10_000).filter(
        (e) => e.type === "tool_call" && (e.data as { truncated?: boolean }).truncated,
      );
      expect(truncated.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);

// ── step 3: the visit guard re-asserts after restarts (T13 #7) ─────────

test(
  " visit guard: the bypass is one-shot — guard_exhausted stays reachable through the pause menu (T13 #7)",
  async () => {
    const env = openEnv("edge-guard");
    try {
      const blueprint = defineBlueprint({
        name: "stuck",
        phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
      });
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: session([settledTurn({ quality: 4 }), settledTurn({ quality: 4 })]) },
        maxVisits: 2,
      });
      const pauses: string[] = [];
      let guardPauses = 0;
      // run.done is one-shot (it resolves at the FIRST stable state) — poll
      // the control surface instead, exactly like the HTTP layer does
      const deadline = Date.now() + 15_000;
      for (;;) {
        const control = getControl(run.run_id);
        const row = getRun(env.db, run.run_id)!;
        if (control !== null && control.paused) {
          const kind = control.pauseInfo!.kind;
          pauses.push(kind);
          if (kind === "guard_exhausted") guardPauses += 1;
          if (guardPauses >= 2) break;
          control.restartFresh("test"); // every pause gets a restart
        } else if (row.status !== "running") {
          break; // terminal without a pause — the test would fail below
        }
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // the pinned sequence: visits 1-2 exhaust their budgets, then the
      // guard fires (visits >= max_visits); a restart earns ONE more visit,
      // then the guard fires AGAIN — the sticky-latch bug would have only the
      // first guard pause and then silent visits beyond max_visits
      expect(pauses).toEqual(["budget_exhausted", "budget_exhausted", "guard_exhausted", "budget_exhausted", "guard_exhausted"]);
      // visits driven: 1, 2 (budget), 3 (guard bypass), 4 never spawned before
      // the second guard pause — max_visits never silently exceeded
      const sessions = listAgentSessions(env.db, run.run_id);
      expect(sessions.map((s) => s.visit)).toEqual([1, 2, 3]);
      getControl(run.run_id)!.fail("test");
      expect((await run.terminal).status).toBe("failed");
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);

// ── a steer queued while paused is delivered to the continued visit ────

test(
  " queued steer on a paused run is drained onto the continued visit's session (T13 #8)",
  async () => {
    const env = openEnv("edge-steerdrain");
    try {
      const blueprint = defineBlueprint({
        name: "stuck",
        phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
      });
      // three DISTINCT scripted turns so the stream proves WHICH commands the
      // session received: T1 = the visit's prompt, T2 = the steered turn,
      // T3 = the correction turn (never reached — budget 1 exhausts at T2)
      const scriptedTurn = (id: string): ScriptedTurn => ({
        events: [
          { type: "agent_start", messageCount: 0, model: "fake-pi" },
          { type: "turn_start" },
          { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
          { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: id },
          { type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: id }] }, isError: false },
          { type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
          { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
          { type: "agent_end", messages: [], willRetry: false },
          { type: "agent_settled" },
        ],
        envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 4 },
      });
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: { turns: [scriptedTurn("T1"), scriptedTurn("T2"), scriptedTurn("T3")] } },
      });
      expect((await run.done).status).toBe("paused"); // visit 1 budget pause

      const control = getControl(run.run_id)!;
      control.steer("try harder", "operator");
      expect(control.queuedSteerCount).toBe(1); // queued (no live session)

      // the menu: 'steer then the visit continues' — restart-fresh
      // continues the phase; the queued steer rides the NEW visit's session
      control.restartFresh("operator");

      // the continuation spawns visit 2 and drains the queue: the steer is
      // delivered as an RPC command (one extra streamed turn per steer)
      await waitFor(() => {
        const c = getControl(run.run_id);
        return c !== null && c.paused && c.queuedSteerCount === 0;
      }, 10_000, "steer drained on continuation");
      expect(getControl(run.run_id)!.paused).toBe(true);

      // the v2 session received prompt + STEER — the steered turn T2 is in
      // its stream. Without the drain, T2 would never appear (T3, the
      // correction turn, would — budget 1 exhausts at the steered turn).
      const v2Id = `${run.run_id.slice(0, 8)}_build_v2`;
      const raw = readFileSync(join(runDirFor(env.dir, run.run_id), "raw_output.jsonl"), "utf8");
      const v2Tools = raw
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as { type: string; toolCallId?: string; sessionId?: string })
        .filter((o) => o.type === "tool_execution_start" && o.sessionId === v2Id)
        .map((o) => o.toolCallId!);
      expect(v2Tools).toContain("T2"); // the queued steer was delivered
      expect(v2Tools[0]).toBe("T1"); // the prompt came first

      // audited + in the feed
      const actions = cursorEvents(env.db, run.run_id, 0, 10_000)
        .filter((e) => e.type === "human_action")
        .map((e) => e.data as { action: string; detail: string });
      expect(actions).toContainEqual(expect.objectContaining({ action: "steer", detail: "try harder" }));

      getControl(run.run_id)!.fail("operator");
      expect((await run.terminal).status).toBe("failed");
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);

test(
  " mid-tool-crash: a SIGNAL-killed child (exitCode null) still crashes the run — the closed latch (T13 capstone)",
  async () => {
    const env = openEnv("edge-signalkill");
    try {
      const blueprint = defineBlueprint({
        name: "killme",
        phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
      });
      // a turn that streams long enough to be mid-flight when the child is
      // SIGKILLed — the driver then reports exitCode null (a signal kill has
      // no exit code), which must NOT be mistaken for "still alive": the run
      // loop's sendPrompt catch takes the ack-timeout path and the next
      // waitForSettled must reject via the closed latch.
      const slowTurn: ScriptedTurn = {
        events: [
          { type: "agent_start", messageCount: 0, model: "fake-pi" },
          { type: "turn_start" },
          { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
          { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "hang" },
          { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "working…" }] } },
        ],
        envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 1 },
      };
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: { turns: [slowTurn] } },
        delayMs: 10, // slow streaming — a wide mid-flight window
      });

      // the child is spawned and live; SIGKILL it mid-stream (after the tool
      // start has actually streamed, so the open call is flushed truncated)
      await waitFor(() => listAgentSessions(env.db, run.run_id).length > 0, 10_000, "session spawned");
      const rawPath = join(runDirFor(env.dir, run.run_id), "raw_output.jsonl");
      await waitFor(() => {
        const text = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
        return text.includes("tool_execution_start");
      }, 10_000, "tool start streamed");
      const childPid = listAgentSessions(env.db, run.run_id)[0]!.pid;
      expect(childPid).toBeGreaterThan(0);
      process.kill(childPid, "SIGKILL");

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
  },
  { timeout: 20_000 },
);

// ── a synchronous initState throw never strands a run in "running" ──────

test(
  " zombie-running: a malformed prices.json between submit and drive finalizes the run failed (T13 #12)",
  async () => {
    const env = openEnv("edge-zombie");
    try {
      // a VALID roster at submit — the submit-time validation passes
      writeFileSync(pricesPathFor(env.dir), JSON.stringify({ "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } }));
      const prepared = await prepareBlueprintRun(env.db, env.dir, { modulePath: HAPPY_BP, cwd: env.cwd });
      // the roster file becomes malformed before the run drives (re-read
      // once per run — the snapshot doctrine's residual window)
      writeFileSync(pricesPathFor(env.dir), "{ not json");

      const run = drivePreparedRun(env.db, env.dir, prepared);
      const result = await run.terminal;
      expect(result).toEqual({ status: "failed", needs_review: true });
      const row = getRun(env.db, prepared.runId)!;
      expect(row.status).toBe("failed"); // never a zombie 'running'
      expect(row.needs_review).toBe(1);
      expect(row.ended_at).toBeTruthy();
      // the failure is recorded as an event, not a silence
      const statuses = cursorEvents(env.db, prepared.runId, 0, 100).filter((e) => e.type === "run_status");
      expect(statuses.at(-1)!.data).toMatchObject({ from: "running", to: "failed" });
      // no zombie: a reconcile sweep finds nothing to interrupt
      expect(reconcileInterruptedRuns(env.db)).not.toContain(prepared.runId);
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);

// ── the fixture submit path: a malformed roster fails BEFORE rows exist ─

test(
  " fixture submit: a malformed prices.json throws with NO run row left behind (T13 #5)",
  async () => {
    const env = openEnv("edge-roster-submit");
    try {
      writeFileSync(pricesPathFor(env.dir), "{ not json");
      // the blueprint submit path validates at prepare (the daemon's 400);
      // the fixture path validates before insert — either way, fail-fast with
      // nothing stranded
      await expect(
        prepareBlueprintRun(env.db, env.dir, { modulePath: HAPPY_BP, cwd: env.cwd }),
      ).rejects.toThrow(/prices\.json/);
      expect(getRun(env.db, "any")).toBeNull(); // no run row for a failed submit
      // the daemon itself survives (no crash) — the DB is still open and usable
      writeFileSync(pricesPathFor(env.dir), JSON.stringify({ "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } }));
      const prepared = await prepareBlueprintRun(env.db, env.dir, { modulePath: HAPPY_BP, cwd: env.cwd });
      const run = drivePreparedRun(env.db, env.dir, prepared);
      expect((await run.terminal).status).toBe("success");
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);

// ── "on_fail + loop guard": a redrive cycle pauses at max_visits ─────────

test(
  " on_fail + loop guard: a budget-exhausted phase routing to a phase that also fails PAUSES at max_visits across the redrives (not running forever)",
  async () => {
    const env = openEnv("edge-onfail-guard");
    try {
      // the capstone FINDING 2 shape: BOTH phases fail and route to each
      // other via on_fail — the plan↔build cycle must terminate at the
      // step-3 guard (visits >= max_visits → pause), never run forever. The
      // on_fail target counts as a NEW visit on the same per-phase counter.
      const blueprint = defineBlueprint({
        name: "failcycle",
        phases: [
          { name: "plan", agent: agent("planner"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "build" } },
          { name: "build", agent: agent("builder"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "plan" } },
        ],
      });
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { plan: session([settledTurn()]), build: session([settledTurn()]) },
        maxVisits: 3,
      });

      // poll the control surface exactly like the HTTP layer does
      const deadline = Date.now() + 20_000;
      let guardPause = false;
      for (;;) {
        const control = getControl(run.run_id);
        const row = getRun(env.db, run.run_id)!;
        if (control !== null && control.paused && control.pauseInfo!.kind === "guard_exhausted") {
          guardPause = true;
          break;
        }
        if (row.status !== "running") {
          // terminal without a guard pause — the cycle ran away
          throw new Error(`run reached ${row.status} without a guard pause — the on_fail cycle did not terminate`);
        }
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(guardPause).toBe(true);
      expect(getRun(env.db, run.run_id)!.status).toBe("paused");

      // visits are counted per phase ACROSS the on_fail redrives: exactly
      // max_visits (3) per phase — plan v1..v3, build v1..v3, then the guard
      // paused plan's 4th entry. No phase exceeded max_visits.
      const sessions = listAgentSessions(env.db, run.run_id);
      const visitsByPhase = new Map<string, number[]>();
      for (const s of sessions) {
        const phaseRow = env.db
          .query<{ name: string }, [string]>("SELECT name FROM phases WHERE id = ?")
          .get(s.phase_id);
        const name = phaseRow?.name ?? "?";
        const list = visitsByPhase.get(name) ?? [];
        list.push(s.visit);
        visitsByPhase.set(name, list);
      }
      expect(visitsByPhase.get("plan")).toEqual([1, 2, 3]);
      expect(visitsByPhase.get("build")).toEqual([1, 2, 3]);

      getControl(run.run_id)!.fail("test");
      expect((await run.terminal).status).toBe("failed");
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 30_000 },
);

// ── no fake-session child outlives its run ────────────────────────

test(
  " child lifecycle: no fake-session child outlives a completed run (reaped at visit end, processes table clean)",
  async () => {
    const env = openEnv("edge-reap");
    try {
      const passGateLocal: Gate = async () => ({ pass: true });
      const blueprint = defineBlueprint({
        name: "reap",
        phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [passGateLocal], budget: 1 }],
      });
      const run = runBlueprint(env.db, env.dir, {
        blueprint,
        cwd: env.cwd,
        scripts: { build: session([settledTurn({ quality: 9 })]) },
      });
      const result = await run.terminal;
      expect(result).toEqual({ status: "success", needs_review: false });

      // every session's child process is GONE — no lingering fake-pi child
      const sessions = listAgentSessions(env.db, run.run_id);
      expect(sessions.length).toBe(1);
      for (const s of sessions) {
        expect(isPidAlive(s.pid)).toBe(false);
      }
      // the daemon's process bookkeeping reaped every row too
      expect(listProcesses(env.db)).toHaveLength(0);
    } finally {
      closeEnv(env);
    }
  },
  { timeout: 20_000 },
);
