import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, runDirFor } from "@showrunner/core";
import type { Blueprint, Envelope, Gate } from "@showrunner/core";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  composePrompt,
  cursorEvents,
  getRun,
  listAgentSessions,
  listEnvelopes,
  listGateResults,
  listPhases,
  openDb,
  runBlueprint,
  snapshotBlueprint,
} from "../src/index.ts";
import type { ScriptMap, ScriptedTurn } from "../src/index.ts";

/**
 * The run loop (spec §5, T01b) — driven against scripted FakePi sessions
 * (spec §17): deterministic, no pi binary, no tokens. The five acceptance
 * fixtures live here (multi-phase success, gate-fail→correction→success,
 * on_fail routing, budget exhaustion → paused, loop guard) plus the seams
 * T03/T04/T05 will extend.
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

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  return quality >= 7 ? { pass: true } : { pass: false, violations: [`quality ${quality} below 7`] };
};

const alwaysFailGate: Gate = async () => ({ pass: false, violations: ["always failing"] });

/** A single-turn scripted session whose agent settles and writes an envelope. */
function settledTurn(extra: Record<string, unknown> = {}): ScriptedTurn {
  return {
    events: [
      { type: "agent_start", messageCount: 0, model: "fake-pi" },
      { type: "queue_update", queued: 0 },
      { type: "turn_start" },
      { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_start", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "message_update", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.0002 } } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "ls" },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok\n" }] }, isError: false },
      { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
    envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 7, ...extra },
  };
}

function session(turns: ScriptedTurn[]): { turns: ScriptedTurn[] } {
  return { turns };
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

function eventTypes(db: ReturnType<typeof openDb>, runId: string): string[] {
  return cursorEvents(db, runId, 0, 10_000).map((e) => e.type);
}

// ── multi-phase success ──────────────────────────────────────────────────────

test("multi-phase blueprint drives both phases to success; statuses, visits, handoff recorded", async () => {
  const env = openEnv("runner-multi");
  try {
    const blueprint = defineBlueprint({
      name: "multi",
      phases: [
        { name: "plan", agent: agent("planner"), envelope: QualityEnvelope, gates: [], budget: 3 },
        { name: "build", agent: agent("builder"), envelope: QualityEnvelope, gates: [], budget: 3 },
      ],
    });
    const scripts: ScriptMap = {
      plan: session([settledTurn({ quality: 7 })]),
      build: session([settledTurn({ quality: 9 })]),
    };
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    const result = await run.done;

    expect(result).toEqual({ status: "success", needs_review: false });
    expect(getRun(env.db, run.run_id)!.status).toBe("success");

    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => [p.name, p.status, p.visits, p.corrections])).toEqual([
      ["plan", "success", 1, 0],
      ["build", "success", 1, 0],
    ]);

    // §9 minimal handoff: build's inputs carry plan's accepted envelope
    const handoff = JSON.parse(
      readFileSync(join(env.cwd, "context_handoff", "build", "inputs", "envelope.json"), "utf8"),
    ) as { quality: number };
    expect(handoff.quality).toBe(7);

    // every validated envelope is an envelopes row
    expect(listEnvelopes(env.db, run.run_id)).toHaveLength(2);

    // events: phase_end(plan) before phase_start(build); run_status running → success
    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    const planEnd = events.findIndex((e) => e.type === "phase_end");
    const buildStart = events.findIndex((e) => e.type === "phase_start" && (e.data as { phase: string }).phase === "build");
    expect(planEnd).toBeGreaterThanOrEqual(0);
    expect(buildStart).toBeGreaterThan(planEnd);
    const statuses = events.filter((e) => e.type === "run_status").map((e) => (e.data as { to: string }).to);
    expect(statuses).toEqual(["running", "success"]);

    // sessions: one per phase, ids derived per §8.1
    const sessions = listAgentSessions(env.db, run.run_id);
    expect(sessions.map((s) => s.pi_session_id).sort()).toEqual([
      `${run.run_id.slice(0, 8)}_build_v1`,
      `${run.run_id.slice(0, 8)}_plan_v1`,
    ]);
  } finally {
    closeEnv(env);
  }
});

test("run-level events carry NULL phase/session ids; phase events carry theirs (§6)", async () => {
  const env = openEnv("runner-nullids");
  try {
    const blueprint = defineBlueprint({
      name: "ids",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts: { build: session([settledTurn()]) } });
    await run.done;

    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    for (const e of events.filter((e) => e.type === "run_submitted" || e.type === "run_status")) {
      expect(e.phase_id, e.type).toBeNull();
      expect(e.agent_session_id, e.type).toBeNull();
    }
    for (const e of events.filter((e) => e.type === "phase_start" || e.type === "phase_end" || e.type === "correction" || e.type === "envelope" || e.type === "gate_result")) {
      expect(e.phase_id, e.type).toBeTruthy();
    }
    const tool = events.find((e) => e.type === "tool_call")!;
    expect(tool.agent_session_id).toBeTruthy();
  } finally {
    closeEnv(env);
  }
});

// ── gate-fail → correction → success (same session id, correction counted) ──

test("gate fail → one correction → success on the SAME session; correction counted", async () => {
  const env = openEnv("runner-gatecorr");
  try {
    const blueprint = defineBlueprint({
      name: "gatecorr",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [qualityGate], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 4 }), settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result).toEqual({ status: "success", needs_review: false });

    const phase = listPhases(env.db, run.run_id)[0]!;
    expect(phase.corrections).toBe(1);
    expect(phase.visits).toBe(1);

    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    const corrections = events.filter((e) => e.type === "correction");
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.data).toMatchObject({ phase: "build", visit: 1, reason: "gate_violations" });
    expect(String((corrections[0]!.data as { message: string }).message)).toContain("quality 4 below 7");

    // the SAME session id across both turns: one agent_session row, v1
    const sessions = listAgentSessions(env.db, run.run_id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.pi_session_id).toBe(`${run.run_id.slice(0, 8)}_build_v1`);
    expect(sessions[0]!.visit).toBe(1);

    // two agent_settled lines in the raw stream (two turns, one process)
    const raw = readFileSync(join(runDirFor(env.dir, run.run_id), "raw_output.jsonl"), "utf8");
    expect(raw.split("agent_settled").length - 1).toBe(2);

    // attempt history: the failing envelope (attempt 0) and the accepted one (attempt 1)
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.attempt)).toEqual([0, 1]);
    const accepted = envelopes.find((e) => e.attempt === 1)!;
    expect(JSON.parse(accepted.json)).toMatchObject({ quality: 9 });

    // gate results: one per gate run, fail then pass
    const gates = listGateResults(env.db, run.run_id);
    expect(gates.map((g) => g.pass)).toEqual([0, 1]);

    // only the accepted envelope fires the §6 #8 event
    expect(events.filter((e) => e.type === "envelope")).toHaveLength(1);
  } finally {
    closeEnv(env);
  }
});

// ── on_fail routing ──────────────────────────────────────────────────────────

test("on_fail routes a budget-exhausted phase to the target phase, which succeeds", async () => {
  const env = openEnv("runner-onfail");
  try {
    const blueprint = defineBlueprint({
      name: "escalate",
      phases: [
        { name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "rescue" } },
        { name: "rescue", agent: agent("rescuer"), envelope: QualityEnvelope, gates: [], budget: 3 },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn(), settledTurn()]), rescue: session([settledTurn({ quality: 8 })]) },
    });
    const result = await run.done;
    // the run succeeds overall — a failed phase was routed through on_fail
    expect(result).toEqual({ status: "success", needs_review: false });

    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => [p.name, p.status, p.visits, p.corrections])).toEqual([
      ["build", "failed", 1, 1],
      ["rescue", "success", 1, 0],
    ]);

    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    const buildEnd = events.findIndex((e) => e.type === "phase_end" && (e.data as { phase: string }).phase === "build");
    const rescueStart = events.findIndex((e) => e.type === "phase_start" && (e.data as { phase: string }).phase === "rescue");
    expect(buildEnd).toBeGreaterThanOrEqual(0);
    expect(rescueStart).toBeGreaterThan(buildEnd);
    expect((events.find((e) => e.type === "phase_end")!.data as { status: string }).status).toBe("failed");
  } finally {
    closeEnv(env);
  }
});

// ── budget exhaustion → paused (no on_fail) ─────────────────────────────────

test("correction budget exhausted with no on_fail pauses the run", async () => {
  const env = openEnv("runner-budget");
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
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });

    const runRow = getRun(env.db, run.run_id)!;
    expect(runRow.status).toBe("paused");
    expect(runRow.ended_at).toBeNull(); // a paused run can be resumed (T04)

    const statuses = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "run_status");
    const final = statuses[statuses.length - 1]!.data as { to: string; reason?: string };
    expect(final.to).toBe("paused");
    expect(final.reason).toMatch(/budget/);

    const phase = listPhases(env.db, run.run_id)[0]!;
    expect(phase.status).toBe("failed");
    expect(phase.corrections).toBe(2);
  } finally {
    closeEnv(env);
  }
});

// ── loop guard (max_visits) ──────────────────────────────────────────────────

test("loop guard: an on_fail cycle pauses once any phase hits max_visits", async () => {
  const env = openEnv("runner-guard");
  try {
    const blueprint = defineBlueprint({
      name: "cycle",
      phases: [
        { name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "review" } },
        { name: "review", agent: agent("reviewer"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "build" } },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn(), settledTurn()]), review: session([settledTurn(), settledTurn()]) },
      maxVisits: 2,
    });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });

    const statuses = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "run_status");
    const final = statuses[statuses.length - 1]!.data as { to: string; reason?: string };
    expect(final.to).toBe("paused");
    expect(final.reason).toMatch(/max_visits/);

    // each phase visited exactly max_visits times, then the guard fired
    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => [p.name, p.status, p.visits])).toEqual([
      ["build", "failed", 2],
      ["review", "failed", 2],
    ]);
    // §8.1 session ids carry the visit number: build ran v1 and v2
    const sessions = listAgentSessions(env.db, run.run_id).map((s) => s.pi_session_id);
    expect(sessions).toContain(`${run.run_id.slice(0, 8)}_build_v2`);
    expect(sessions).toContain(`${run.run_id.slice(0, 8)}_review_v2`);
  } finally {
    closeEnv(env);
  }
});

// ── envelope/gate seams (T03's module, exercised now) ────────────────────────

test("a throwing gate is a violation, never a daemon crash (§5.5)", async () => {
  const env = openEnv("runner-gatecrash");
  try {
    // throws for low quality (the first envelope), passes for high (the correction)
    const explodingGate: Gate = async (envelope: Envelope) => {
      const quality = (envelope as unknown as { quality: number }).quality;
      if (quality < 7) throw new Error("kaboom: roster missing");
      return { pass: true };
    };
    const blueprint = defineBlueprint({
      name: "boom",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [explodingGate], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 1 }), settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result.status).toBe("success"); // corrected and passed — the daemon survived

    const gates = listGateResults(env.db, run.run_id);
    expect(gates[0]!.pass).toBe(0);
    expect(gates[0]!.violations).toContain("kaboom: roster missing");

    const correction = cursorEvents(env.db, run.run_id, 0, 10_000).find((e) => e.type === "correction")!
      .data as { message: string };
    expect(correction.message).toContain("kaboom: roster missing");
  } finally {
    closeEnv(env);
  }
});

test("a zod-invalid envelope is corrected with the exact issue; only valid envelopes are recorded", async () => {
  const env = openEnv("runner-invalid");
  try {
    const blueprint = defineBlueprint({
      name: "typed",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    // turn 1: missing required base field (notes_for_next_agent) + wrong quality type
    const badTurn: ScriptedTurn = {
      events: settledTurn().events,
      envelope: { summary: "x", artifacts: [], quality: "not-a-number" },
    };
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([badTurn, settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result.status).toBe("success");

    const correction = cursorEvents(env.db, run.run_id, 0, 10_000).find((e) => e.type === "correction")!
      .data as { reason: string; message: string };
    expect(correction.reason).toBe("invalid_envelope");
    expect(correction.message).toContain("notes_for_next_agent");

    // only the VALID envelope got a row (attempt = 1 after one correction)
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.attempt)).toEqual([1]);
  } finally {
    closeEnv(env);
  }
});

test("blocked envelope pauses the run pre-gate, burning no corrections (§3.2)", async () => {
  const env = openEnv("runner-blocked");
  try {
    const blueprint = defineBlueprint({
      name: "blocked",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 1, blocked: true, blocked_reason: "missing API key" })]) },
    });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });

    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    expect(events.filter((e) => e.type === "correction")).toHaveLength(0);
    expect(events.filter((e) => e.type === "envelope")).toHaveLength(0);
    const final = events.filter((e) => e.type === "run_status").at(-1)!.data as { to: string; reason?: string };
    expect(final.to).toBe("paused");
    expect(final.reason).toMatch(/missing API key/);
    // the phase is left in_progress, parked on the human (T04 owns the menu)
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("in_progress");
  } finally {
    closeEnv(env);
  }
});

test("require_approval pauses before the phase starts (§5.2 step 1)", async () => {
  const env = openEnv("runner-approval");
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
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });
    const final = cursorEvents(env.db, run.run_id, 0, 10_000)
      .filter((e) => e.type === "run_status")
      .at(-1)!.data as { reason?: string };
    expect(final.reason).toMatch(/approval/);
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("pending"); // never started
    expect(listAgentSessions(env.db, run.run_id)).toHaveLength(0); // no spawn
  } finally {
    closeEnv(env);
  }
});

// ── snapshot (§13.3) ─────────────────────────────────────────────────────────

test("the blueprint snapshot records the rendered config (§13.3)", async () => {
  const env = openEnv("runner-snapshot");
  try {
    const blueprint = defineBlueprint({
      name: "snap",
      phases: [
        {
          name: "plan",
          agent: agent("planner"),
          envelope: QualityEnvelope,
          gates: [qualityGate],
          budget: 2,
          on_fail: { to: "plan" },
        },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { plan: session([settledTurn()]) },
      maxVisits: 4,
    });
    await run.done;

    const snap = JSON.parse(readFileSync(join(runDirFor(env.dir, run.run_id), "blueprint.json"), "utf8")) as {
      name: string;
      max_visits: number;
      phases: { name: string; agent: { name: string; model: string }; gates: string[]; envelope: string; budget: number }[];
    };
    expect(snap.name).toBe("snap");
    expect(snap.max_visits).toBe(4);
    expect(snap.phases[0]).toMatchObject({ name: "plan", budget: 2, gates: ["qualityGate"] });
    expect(snap.phases[0]!.agent.name).toBe("planner");
    // the rendered envelope contract names the phase's field
    expect(snap.phases[0]!.envelope).toContain("quality");
    expect(snap.phases[0]!.envelope).toContain("summary");
  } finally {
    closeEnv(env);
  }
});

// ── raw record (§10): byte-identical, incl. an unterminated final line ───────

test("raw_output.jsonl is byte-identical to the stream, incl. an unterminated final line", async () => {
  const env = openEnv("runner-raw");
  try {
    const blueprint = defineBlueprint({
      name: "raw",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: { turns: [settledTurn({ quality: 8 })], unterminatedFinalLine: true, exitAfterLastTurn: { code: 0 } } },
    });
    await run.done;

    const piSessionId = `${run.run_id.slice(0, 8)}_build_v1`;
    const events = settledTurn({ quality: 8 }).events;
    const expected = events.map((e) => JSON.stringify({ ...e, sessionId: piSessionId })).join("\n");
    const raw = readFileSync(join(runDirFor(env.dir, run.run_id), "raw_output.jsonl"), "utf8");
    expect(raw).toBe(expected); // identical, and NO trailing newline
    expect(raw.endsWith("\n")).toBe(false);

    // without the flag the stream is newline-terminated as usual
    const run2 = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 8 })]) },
    });
    await run2.done;
    const raw2 = readFileSync(join(runDirFor(env.dir, run2.run_id), "raw_output.jsonl"), "utf8");
    expect(raw2.endsWith("\n")).toBe(true);
  } finally {
    closeEnv(env);
  }
});

// ── hooks (§14) ──────────────────────────────────────────────────────────────

test("a throwing onPhaseStart pauses the run instead of dying silently (§14)", async () => {
  const env = openEnv("runner-hook");
  try {
    const blueprint = defineBlueprint({
      name: "hook",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
      onPhaseStart: async () => {
        throw new Error("hook boom");
      },
    });
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts: { build: session([settledTurn()]) } });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });
    const reason = cursorEvents(env.db, run.run_id, 0, 10_000)
      .filter((e) => e.type === "run_status")
      .at(-1)!.data as { reason?: string };
    expect(reason.reason).toMatch(/hook boom/);
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("failed");
  } finally {
    closeEnv(env);
  }
});

test("onPhaseStart gets ctx.shell() and can act on the workspace", async () => {
  const env = openEnv("runner-shellhook");
  try {
    let sawShell = false;
    const blueprint = defineBlueprint({
      name: "shellhook",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
      onPhaseStart: async (ctx) => {
        const res = await ctx.shell(`printf 'hello' > ${env.cwd}/hook-marker.txt`);
        expect(res.code).toBe(0);
        sawShell = true;
      },
    });
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts: { build: session([settledTurn()]) } });
    const result = await run.done;
    expect(result.status).toBe("success");
    expect(sawShell).toBe(true);
    expect(readFileSync(join(env.cwd, "hook-marker.txt"), "utf8")).toBe("hello");
  } finally {
    closeEnv(env);
  }
});

// ── the composed prompt (§8.2) ───────────────────────────────────────────────

test("composePrompt renders the §8.2 prompt: phase, agent, context, handoff, envelope contract", async () => {
  const env = openEnv("runner-prompt");
  try {
    const blueprint = defineBlueprint({
      name: "prompted",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], context: ["literal context line", "brief.md"] }],
    });
    // a context entry that resolves to a real file gets inlined (§9.2)
    writeFileSync(join(env.cwd, "brief.md"), "# brief\ninline this file\n");
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn()]) },
      moduleDir: null,
    });
    await run.done;

    const prompt = composePrompt(
      { blueprint, cwd: env.cwd, moduleDir: null } as unknown as Parameters<typeof composePrompt>[0],
      blueprint.phases[0]!,
      null,
    );
    expect(prompt).toContain("[Phase] prompted → build");
    expect(prompt).toContain("[Agent] builder (fake-pi)");
    expect(prompt).toContain("literal context line");
    expect(prompt).toContain("inline this file"); // file inlined, not the path
    expect(prompt).toContain("[Handoff from previous phase]");
    expect(prompt).toContain("quality: number"); // envelope contract rendered
    expect(prompt).toContain("context_handoff/build/outputs/envelope.json");
  } finally {
    closeEnv(env);
  }
});

// ── the session-crash path ───────────────────────────────────────────────────

test("a session that dies before agent_settled fails the run with needs_review", async () => {
  const env = openEnv("runner-crash");
  try {
    const blueprint = defineBlueprint({
      name: "crashy",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    // a scripted session whose ONLY turn ends without agent_settled — the
    // session process streams it and exits; the loop sees stream death
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
    const result = await run.done;
    expect(result).toEqual({ status: "failed", needs_review: true });
    expect(getRun(env.db, run.run_id)!.needs_review).toBe(1);
    expect(listPhases(env.db, run.run_id)[0]!.status).toBe("failed");
    // the open tool call was flushed truncated (§7.2)
    const truncated = cursorEvents(env.db, run.run_id, 0, 10_000).filter(
      (e) => e.type === "tool_call" && (e.data as { truncated?: boolean }).truncated,
    );
    expect(truncated.length).toBeGreaterThanOrEqual(1);
  } finally {
    closeEnv(env);
  }
});
