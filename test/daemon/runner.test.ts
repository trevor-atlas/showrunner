process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, runDirFor } from "../../src/core/index.ts";
import type { Blueprint, Envelope, Gate } from "../../src/core/index.ts";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  composeContinuePrompt,
  composePrompt,
  cursorEvents,
  driveResumedRun,
  EventSink,
  getRun,
  isEnvelopeApproved,
  listAgentSessions,
  listEnvelopes,
  listGateOverrides,
  listGateResults,
  listPhases,
  listRuns,
  openDb,
  overrideGateResult,
  prepareBlueprintRun,
  prepareResume,
  recordAcceptedEnvelope,
  recordEnvelopeAcceptance,
  runBlueprint,
  snapshotBlueprint,
  sumRunSpend,
  updatePhase,
  updateRun,
} from "../../src/daemon/index.ts";
import type { ScriptMap, ScriptedTurn } from "../../src/daemon/index.ts";

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

/** A settled turn whose usage reports NO cost — the §11.1 roster estimate path. */
function settledTurnNoCost(extra: Record<string, unknown> = {}): ScriptedTurn {
  const t = settledTurn(extra);
  return {
    ...t,
    events: t.events.map((e) =>
      e.type === "message_update"
        ? { ...e, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } }
        : e,
    ),
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

// ── §11.1 spend aggregation (roster estimates flow into phase/run totals) ────

test("spend: roster estimates accumulate into phase spend_usd, phase_end, and the run total", async () => {
  const env = openEnv("runner-spend");
  try {
    // the roster lives in the SCRATCH data dir (F3) — the run's estimates read it
    writeFileSync(join(env.dir, "prices.json"), JSON.stringify({ "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } }));
    const blueprint = defineBlueprint({
      name: "spendy",
      phases: [
        { name: "plan", agent: agent("planner"), envelope: QualityEnvelope, gates: [], budget: 3 },
        { name: "build", agent: agent("builder"), envelope: QualityEnvelope, gates: [], budget: 3 },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: {
        plan: session([settledTurnNoCost({ quality: 7 })]),
        build: session([settledTurnNoCost({ quality: 8 })]),
      },
    });
    const result = await run.done;
    expect(result.status).toBe("success");

    // each turn's usage (100 in, 20 out) is estimated: (100×3 + 20×15)/1e6 = $0.0006
    const perTurn = 0.0006;
    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => p.spend_usd)).toEqual([perTurn, perTurn]);

    // run total: sumRunSpend (phases) and the runs-list aggregate agree
    expect(sumRunSpend(env.db, run.run_id)).toBeCloseTo(2 * perTurn);
    expect(listRuns(env.db)[0]!.spend_usd).toBeCloseTo(2 * perTurn);

    // the feed carries one spend event per turn, flagged estimated, tokens tracked
    const spends = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "spend");
    expect(spends).toHaveLength(2);
    for (const s of spends) {
      expect((s.data as { estimated: boolean }).estimated).toBe(true);
      expect((s.data as { usd: number | null }).usd).toBeCloseTo(perTurn);
      expect((s.data as { tokens_in: number }).tokens_in).toBe(100);
      expect((s.data as { tokens_out: number }).tokens_out).toBe(20);
    }

    // phase_end carries the accumulated spend_usd per phase (§6 #4)
    const phaseEnds = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "phase_end");
    expect(phaseEnds).toHaveLength(2);
    for (const pe of phaseEnds) {
      expect((pe.data as { spend_usd: number }).spend_usd).toBeCloseTo(perTurn);
    }
  } finally {
    closeEnv(env);
  }
});

test("spend: reported cost still flows through the loop unflagged; the roster never overrides it", async () => {
  const env = openEnv("runner-spend-report");
  try {
    // the roster is present but pi reports cost — pi's number wins (§11.1)
    writeFileSync(join(env.dir, "prices.json"), JSON.stringify({ "fake-pi": { in_per_mtok: 3, out_per_mtok: 15 } }));
    const blueprint = defineBlueprint({
      name: "reported",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [], budget: 3 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 9 })]) }, // usage carries cost 0.0002
    });
    await run.done;

    const spend = cursorEvents(env.db, run.run_id, 0, 10_000).find((e) => e.type === "spend")!.data as {
      usd: number | null;
      estimated: boolean;
    };
    expect(spend.usd).toBe(0.0002); // reported, not the roster's 0.0006
    expect(spend.estimated).toBe(false);

    // the show-side split: total is the reported number
    expect(listPhases(env.db, run.run_id)[0]!.spend_usd).toBeCloseTo(0.0002);
    expect(sumRunSpend(env.db, run.run_id)).toBeCloseTo(0.0002);
  } finally {
    closeEnv(env);
  }
});

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

    // T03: the crash violation is also on the envelope row (§16.8 per-attempt violations)
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.valid)).toEqual([1, 1]);
    expect(JSON.parse(envelopes[0]!.violations)).toEqual(["gate \"explodingGate\" crashed: kaboom: roster missing"]);
    expect(envelopes[0]!.correction).toContain("kaboom: roster missing");

    const correction = cursorEvents(env.db, run.run_id, 0, 10_000).find((e) => e.type === "correction")!
      .data as { message: string };
    expect(correction.message).toContain("kaboom: roster missing");
  } finally {
    closeEnv(env);
  }
});

// ── attempt history (T03): every attempt, valid/invalid + violations + correction ─

test("attempt history: invalid → gate-fail → accepted records three attempts with violations + corrections", async () => {
  const env = openEnv("runner-attempts");
  try {
    const blueprint = defineBlueprint({
      name: "attempts",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [qualityGate], budget: 3 }],
    });
    const invalidTurn: ScriptedTurn = {
      events: settledTurn().events,
      envelope: { summary: "s", artifacts: [], quality: 4 }, // missing notes_for_next_agent
    };
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([invalidTurn, settledTurn({ quality: 2 }), settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result.status).toBe("success");

    const phase = listPhases(env.db, run.run_id)[0]!;
    expect(phase.corrections).toBe(2);

    // per-attempt history in visit/attempt order: the drill-in list (§16.8)
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.attempt)).toEqual([0, 1, 2]);
    expect(envelopes.map((e) => e.valid)).toEqual([0, 1, 1]);
    // the correction that followed each rejected attempt is stamped on the row
    expect(envelopes[0]!.correction).toContain("notes_for_next_agent"); // invalid → zod issue
    expect(envelopes[1]!.correction).toBe("Gate violations: quality 2 below 7"); // verbatim §3.4
    expect(envelopes[2]!.correction).toBeNull(); // accepted: nothing followed
    // gate violations live on the rejected attempt's row
    expect(JSON.parse(envelopes[1]!.violations)).toEqual(["quality 2 below 7"]);
    expect(JSON.parse(envelopes[2]!.violations)).toEqual([]);

    // the drill-in query: accepted + rejected + violations + the correction issued
    const accepted = envelopes.find((e) => e.attempt === 2)!;
    expect(JSON.parse(accepted.json)).toMatchObject({ quality: 9 });

    const corrections = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "correction");
    expect(corrections.map((c) => (c.data as { reason: string }).reason)).toEqual([
      "invalid_envelope",
      "gate_violations",
    ]);
  } finally {
    closeEnv(env);
  }
});

// ── gate results per gate (T03) ──────────────────────────────────────────────

test("one gate_results row per gate run per envelope, with pass/violations/ran_at + override badge column", async () => {
  const env = openEnv("runner-gates");
  try {
    const passGate: Gate = async () => ({ pass: true });
    const blueprint = defineBlueprint({
      name: "twogates",
      phases: [
        {
          name: "build",
          agent: agent(),
          envelope: QualityEnvelope,
          gates: [passGate, qualityGate],
          budget: 3,
        },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 4 }), settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result.status).toBe("success");

    // two envelopes × two gates = four rows, one per gate run
    const gates = listGateResults(env.db, run.run_id);
    expect(gates).toHaveLength(4);
    expect(gates.map((g) => [g.gate, g.pass])).toEqual([
      ["passGate", 1],
      ["qualityGate", 0], // fail → correction
      ["passGate", 1],
      ["qualityGate", 1], // pass on the corrected attempt
    ]);
    expect(JSON.parse(gates[1]!.violations)).toEqual(["quality 4 below 7"]);
    expect(typeof gates[0]!.ran_at).toBe("string");
    // no overrides yet: the drill-in badge columns are null
    expect(gates.map((g) => g.overridden)).toEqual([0, 0, 0, 0]);
    expect(gates[0]!.override_by).toBeNull();
  } finally {
    closeEnv(env);
  }
});

// ── gate overrides (§5.3): the audited mechanism T04/T08 call ────────────────

test("override: a failed gate is marked overridden (row kept, audited), envelope approved, acceptance recorded", async () => {
  const env = openEnv("runner-override");
  try {
    const blueprint = defineBlueprint({
      name: "override",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1 }],
    });
    // budget 1: first failure gets one correction, second failure pauses the run
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 9 }), settledTurn({ quality: 9 })]) },
    });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false }); // parked on the human (T04)

    // the last rejected envelope + its failed gate result are the override targets
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.attempt)).toEqual([0, 1]);
    const rejected = envelopes[1]!; // attempt 1 (no correction followed: budget hit)
    const gates = listGateResults(env.db, run.run_id);
    const failed = gates.find((g) => g.envelope_id === rejected.id)!;
    expect(failed.pass).toBe(0);
    // before the override the envelope is NOT approved (gate treated as failed),
    // and acceptance recording refuses to fire for it (correct-by-construction)
    expect(isEnvelopeApproved(env.db, rejected.id)).toBe(false);
    const earlySink = new EventSink(env.db, { runId: run.run_id, phaseId: null, agentSessionId: null });
    expect(() =>
      recordEnvelopeAcceptance({ db: env.db, envelopeId: rejected.id, emit: (t, d) => earlySink.push(t, d) }),
    ).toThrow(/un-overridden gate violations/);

    // the human overrides the failed gate (who + why, audited)
    const over = overrideGateResult({
      db: env.db,
      gateResultId: failed.id,
      by: "reviewer",
      reason: "quality 9 is acceptable per manual check",
      emit: () => {}, // event sink is a no-op here; the DB row is what matters
    });
    expect(over.approved).toBe(true); // gate treated as passed
    expect(over.gate).toBe("alwaysFailGate");
    expect(isEnvelopeApproved(env.db, rejected.id)).toBe(true);

    // original gate_results row KEPT: pass stays 0, now carrying the override badge
    const after = listGateResults(env.db, run.run_id).find((g) => g.id === failed.id)!;
    expect(after.pass).toBe(0);
    expect(after.overridden).toBe(1);
    expect(after.override_by).toBe("reviewer");
    expect(after.override_reason).toBe("quality 9 is acceptable per manual check");
    expect(after.overridden_at).toBeTypeOf("string");

    // the run-level audit trail: who + why + when
    const trail = listGateOverrides(env.db, run.run_id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ gate: "alwaysFailGate", pass: 0, by: "reviewer" });

    // the resume path: approved → acceptance recorded (§6 #8) → run continues
    const sink = new EventSink(env.db, { runId: run.run_id, phaseId: null, agentSessionId: null });
    const accepted = recordEnvelopeAcceptance({
      db: env.db,
      envelopeId: rejected.id,
      emit: (type, data) => sink.push(type, data),
    });
    await sink.flush();
    expect(accepted.id).toBe(rejected.id);
    const events = cursorEvents(env.db, run.run_id, 0, 10_000);
    // one acceptance: the attempt-0 envelope was rejected (gates failed), so the
    // only envelope event is the post-override acceptance — and it never fired
    // while the run was live (violations path), so exactly one appears
    const envelopeEvents = events.filter((e) => e.type === "envelope");
    expect(envelopeEvents).toHaveLength(1);
    expect(envelopeEvents[0]!.data).toMatchObject({ phase: "build", attempt: 1, valid: true });
  } finally {
    closeEnv(env);
  }
});

test("override guardrails: passing gates, missing results, and double overrides are rejected", async () => {
  const env = openEnv("runner-override-guards");
  try {
    const blueprint = defineBlueprint({
      name: "ovrguard",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [qualityGate], budget: 1 }],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 9 })]) },
    });
    expect((await run.done).status).toBe("success");

    const gates = listGateResults(env.db, run.run_id);
    const passing = gates[0]!; // quality 9 passes
    expect(() => overrideGateResult({ db: env.db, gateResultId: passing.id, by: "x", reason: "r" })).toThrow(/passed/);
    expect(() => overrideGateResult({ db: env.db, gateResultId: "ghost", by: "x", reason: "r" })).toThrow(/no gate result/);

    // a failing gate result from the run can be overridden exactly once
    const failing: Gate = async () => ({ pass: false, violations: ["nope"] });
    const blueprint2 = defineBlueprint({
      name: "ovrguard2",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [failing], budget: 1 }],
    });
    const run2 = runBlueprint(env.db, env.dir, {
      blueprint: blueprint2,
      cwd: env.cwd,
      scripts: { build: session([settledTurn({ quality: 9 }), settledTurn({ quality: 9 })]) },
    });
    expect((await run2.done).status).toBe("paused");
    const fg = listGateResults(env.db, run2.run_id).find((g) => g.pass === 0)!;
    overrideGateResult({ db: env.db, gateResultId: fg.id, by: "x", reason: "r" });
    expect(() => overrideGateResult({ db: env.db, gateResultId: fg.id, by: "x", reason: "r" })).toThrow(/already overridden/);
  } finally {
    closeEnv(env);
  }
});

// ── loop guard (§19, T03): the exact fixture — 2-phase cycle, max_visits 3 ──

test("loop guard: reviewer → builder → reviewer cycle with max_visits 3 pauses at 3 visits (§19)", async () => {
  const env = openEnv("runner-guard3");
  try {
    const blueprint = defineBlueprint({
      name: "cycle3",
      phases: [
        { name: "review", agent: agent("reviewer"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "build" } },
        { name: "build", agent: agent("builder"), envelope: QualityEnvelope, gates: [alwaysFailGate], budget: 1, on_fail: { to: "review" } },
      ],
    });
    const run = runBlueprint(env.db, env.dir, {
      blueprint,
      cwd: env.cwd,
      scripts: { review: session([settledTurn(), settledTurn()]), build: session([settledTurn(), settledTurn()]) },
      maxVisits: 3,
    });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });

    const statuses = cursorEvents(env.db, run.run_id, 0, 10_000).filter((e) => e.type === "run_status");
    const final = statuses[statuses.length - 1]!.data as { to: string; reason?: string };
    expect(final.to).toBe("paused");
    expect(final.reason).toMatch(/max_visits \(3\)/);

    // each phase visited exactly max_visits times, then the guard fired
    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => [p.name, p.status, p.visits])).toEqual([
      ["review", "failed", 3],
      ["build", "failed", 3],
    ]);
    // §8.1 session ids carry the visit number: review ran v1, v2, and v3
    const sessions = listAgentSessions(env.db, run.run_id).map((s) => s.pi_session_id);
    for (const v of [1, 2, 3]) {
      expect(sessions).toContain(`${run.run_id.slice(0, 8)}_review_v${v}`);
      expect(sessions).toContain(`${run.run_id.slice(0, 8)}_build_v${v}`);
    }
  } finally {
    closeEnv(env);
  }
});

test("a zod-invalid envelope is corrected with the exact issue; EVERY attempt is recorded (T03)", async () => {
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

    // T03: the invalid attempt is a row too — full history, attempt 0 invalid
    // (rejected text stored verbatim), attempt 1 valid + accepted
    const envelopes = listEnvelopes(env.db, run.run_id);
    expect(envelopes.map((e) => e.attempt)).toEqual([0, 1]);
    expect(envelopes.map((e) => e.valid)).toEqual([0, 1]);
    // the invalid attempt's json is the rejected text, verbatim
    expect(JSON.parse(envelopes[0]!.json)).toEqual({ summary: "x", artifacts: [], quality: "not-a-number" });
    // the correction that followed it is stamped on the row; the accepted row has none
    expect(envelopes[0]!.correction).toContain("notes_for_next_agent");
    expect(envelopes[1]!.correction).toBeNull();
    expect(envelopes.map((e) => e.violations)).toEqual(["[]", "[]"]); // no gates ran
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

test("FINDING-1: a run submitted with --prompt composes it as [User request] in the first prompt", async () => {
  const env = openEnv("runner-prompt-args");
  try {
    const blueprint = defineBlueprint({
      name: "prompted_args",
      phases: [{ name: "build", agent: agent(), envelope: QualityEnvelope, gates: [] }],
    });
    // the CLI's §13.3 args channel lands in the run's snapshot (blueprint.json)
    // — build the state by hand over a REAL snapshot written via the public
    // snapshot function, exactly as the submit path records it
    const runDir = runDirFor(env.dir, "f1-snap");
    mkdirSync(runDir, { recursive: true });
    snapshotBlueprint(runDir, blueprint, 3, null, ["--prompt", "map the auth flow"]);
    const state = { blueprint, cwd: env.cwd, moduleDir: null, runDir } as unknown as Parameters<typeof composePrompt>[0];

    const prompt = composePrompt(state, blueprint.phases[0]!, null);
    expect(prompt).toContain("[User request]");
    expect(prompt).toContain("map the auth flow");
    // the instruction is the goal: it rides right after the agent prompt, before any context
    const reqIdx = prompt.indexOf("[User request]");
    expect(reqIdx).toBeGreaterThan(prompt.indexOf("execute the phase"));
    expect(prompt.indexOf("[Context]")).toBe(-1); // no context entries → no [Context] block

    // no --prompt → no [User request] section (the old silent no-op shape)
    snapshotBlueprint(runDir, blueprint, 3, null, ["--go", "fast"]);
    const plain = composePrompt(state, blueprint.phases[0]!, null);
    expect(plain).not.toContain("[User request]");
  } finally {
    closeEnv(env);
  }
});

test("§12 resume: a failed relaunch leaves the run interrupted — never a zombie `running`", async () => {
  const env = openEnv("runner-resume-fail");
  try {
    const runId = await interruptedDemoRun(env);
    // destroy the §13.3 snapshot — the resume cannot rebuild the run
    rmSync(join(runDirFor(env.dir, runId), "blueprint.json"));
    await expect(prepareResume(env.db, env.dir, runId)).rejects.toThrow(/snapshot/);
    // the run stays interrupted and un-driven; no resume attempt was audited
    expect(getRun(env.db, runId)!.status).toBe("interrupted");
    expect(getRun(env.db, runId)!.needs_review).toBe(0);
    const actions = cursorEvents(env.db, runId, 0, 10_000).filter(
      (e) => e.type === "human_action" && (e.data as { action: string }).action === "resume",
    );
    expect(actions).toHaveLength(0);
  } finally {
    closeEnv(env);
  }
});

// ── the session-crash path ───────────────────────────────────────────────────

// ── §12 resume (T07): continue an interrupted run from the last completed phase ─

const demoBlueprintPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "demo-blueprint.ts");

/** Build a run left interrupted mid-build-visit-1: plan success, build in_progress. */
async function interruptedDemoRun(env: { dir: string; db: ReturnType<typeof openDb>; cwd: string }): Promise<string> {
  const prepared = await prepareBlueprintRun(env.db, env.dir, { modulePath: demoBlueprintPath, cwd: env.cwd });
  const runId = prepared.runId;
  const phases = listPhases(env.db, runId);
  const plan = phases.find((p) => p.name === "plan")!;
  const build = phases.find((p) => p.name === "build")!;
  const t = new Date().toISOString();
  updatePhase(env.db, plan.id, { status: "success", visits: 1, started_at: t, ended_at: t });
  updatePhase(env.db, build.id, { status: "in_progress", visits: 1, started_at: t });
  updateRun(env.db, runId, { status: "interrupted" });
  // the predecessor's accepted envelope lands in the run's raw record (§10) —
  // what §12 resume reconstructs the build handoff from
  recordAcceptedEnvelope(
    runDirFor(env.dir, runId),
    JSON.stringify({ summary: "Plan complete.", artifacts: [], notes_for_next_agent: "Proceed to build.", quality: 8 }),
  );
  return runId;
}

test("§12 resume continues from the interrupted phase: success phases not re-run, same session id, needs_review preserved", async () => {
  const env = openEnv("runner-resume");
  try {
    const runId = await interruptedDemoRun(env);
    const runRow = getRun(env.db, runId)!;
    expect(runRow.status).toBe("interrupted");

    const pr = await prepareResume(env.db, env.dir, runId, { by: "operator" });
    expect(pr.resume.phase).toBe("build"); // plan already success — the interrupted one
    expect(pr.resume.visit).toBe(1); // re-visited as-is (the crashed visit)
    expect(pr.resume.continueInstruction).toContain("[Resume]");
    expect(pr.resume.continueInstruction).toContain("build");
    expect(pr.resume.continueInstruction).toContain("envelope.json");
    expect(pr.resume.handoff).not.toBeNull();
    expect(pr.resume.handoff!.fromPhase).toBe("plan");
    // the §12.3 continue instruction is NOT the fresh composed prompt
    expect(pr.resume.continueInstruction).not.toContain("[Context]");

    const run = driveResumedRun(env.db, env.dir, pr, { delayMs: 0 });
    const result = await run.terminal;
    expect(result).toEqual({ status: "success", needs_review: true });

    // T04 pin: the resumed run KEEPS needs_review through the clean finish
    expect(getRun(env.db, runId)!.needs_review).toBe(1);
    // phases already success are NOT re-run: plan stayed at visit 1, its row untouched
    const phases = listPhases(env.db, runId);
    const plan = phases.find((p) => p.name === "plan")!;
    const build = phases.find((p) => p.name === "build")!;
    expect(plan.status).toBe("success");
    expect(plan.visits).toBe(1);
    expect(build.status).toBe("success");
    // the interrupted phase re-visits with the SAME session id (§12.3): the new
    // build session is v1 — never a v2 spawn
    const buildSessions = listAgentSessions(env.db, runId).filter((s) =>
      s.pi_session_id.includes("_build_"),
    );
    expect(buildSessions).toHaveLength(1);
    expect(buildSessions[0]!.pi_session_id).toBe(`${runId.slice(0, 8)}_build_v1`);
    expect(buildSessions[0]!.visit).toBe(1);
    // plan was never re-driven: no plan sessions at all (it completed pre-crash)
    expect(listAgentSessions(env.db, runId).some((s) => s.pi_session_id.includes("_plan_"))).toBe(false);

    // the resume attempt is audited (§6 #11) and the run_status shows interrupted→running
    const events = cursorEvents(env.db, runId, 0, 10_000);
    expect(
      events.some((e) => e.type === "human_action" && (e.data as { action: string }).action === "resume"),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "run_status" &&
          (e.data as { from: string; to: string }).from === "interrupted" &&
          (e.data as { from: string; to: string }).to === "running",
      ),
    ).toBe(true);
  } finally {
    closeEnv(env);
  }
});

test("§12 resume: the build handoff is the predecessor's accepted envelope; the continue instruction renders the envelope contract; resume refuses non-interrupted runs", async () => {
  const env = openEnv("runner-resume-handoff");
  try {
    const runId = await interruptedDemoRun(env);
    const pr = await prepareResume(env.db, env.dir, runId);
    // handoff reconstructed from runDir/envelope.json — the predecessor's
    // envelope becomes build's §9.3 materialized input
    const handoff = pr.resume.handoff!;
    expect((handoff.envelope as { summary: string }).summary).toBe("Plan complete.");
    // composeContinuePrompt is a standalone seam: phase + envelope contract
    const bp = pr.prepared.blueprint;
    const build = bp.phases.find((p) => p.name === "build")!;
    const prompt = composeContinuePrompt(bp, build);
    expect(prompt).toContain("[Phase] demo → build");
    expect(prompt).toContain("[Resume]");
    expect(prompt).toContain("quality: number"); // the envelope contract renders
    // resume is the interrupted-run verb only
    const prepared = await prepareBlueprintRun(env.db, env.dir, { modulePath: demoBlueprintPath, cwd: env.cwd });
    const runningRun = runBlueprint(env.db, env.dir, {
      blueprint: prepared.blueprint,
      cwd: env.cwd,
      scripts: prepared.scripts,
    });
    await runningRun.done;
    await expect(prepareResume(env.db, env.dir, prepared.runId)).rejects.toThrow(/not interrupted/);
  } finally {
    closeEnv(env);
  }
});


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
