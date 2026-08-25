import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EnvelopeBase } from "../../src/core/index.ts";
import type { Envelope, EventType, Gate } from "../../src/core/index.ts";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { overrideGateResult, runEnvelopeStage } from "../../src/server/engine/envelope-runner.ts";
import { EventSink } from "../../src/server/engine/queue.ts";
import { cursorEvents, getEnvelope, insertPhase, insertRun, listEnvelopes, listGateResults, openDb } from "../../src/server/repository/db.ts";
import { type EnvelopeStageOptions } from "../../src/server/engine/envelope-runner.ts";

/**
 * The envelope/gate seam (T03) exercised directly — the loop-level behavior is
 * covered in runner.test.ts; here the stage's contract is pinned: every
 * attempt is a row (missing file, zod-invalid, blocked, accepted), per-gate
 * results land, and the override mechanism audits who + why + when.
 */

const QualityEnvelope = EnvelopeBase.extend({ quality: z.number() });

interface Env {
  db: ReturnType<typeof openDb>;
  dir: string;
  cwd: string;
  runDir: string;
  runId: string;
  phaseId: string;
}

function setup(label: string): Env {
  const dir = tmpDataDir(label);
  const cwd = mkdtempSync(join(tmpdir(), "showrunner-cwd-"));
  const runDir = mkdtempSync(join(tmpdir(), "showrunner-env-runs-"));
  const db = openDb(join(dir, "showrunner.db"));
  const runId = randomUUID();
  const phaseId = randomUUID();
  insertRun(db, {
    id: runId,
    blueprint: "seam",
    status: "running",
    cwd,
    needs_review: 0,
    started_at: "t0",
    ended_at: null,
  });
  insertPhase(db, {
    id: phaseId,
    run_id: runId,
    name: "build",
    agent: "builder",
    status: "in_progress",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: "t0",
    ended_at: null,
  });
  return { db, dir, cwd, runDir, runId, phaseId };
}

function teardown(env: Env): void {
  env.db.close();
  rmSync(env.cwd, { recursive: true, force: true });
  rmSync(env.runDir, { recursive: true, force: true });
  cleanupDir(env.dir);
}

function makeStage(
  env: Env,
  envelopePath: string,
  opts: { schema?: typeof QualityEnvelope; gates?: Gate[] } = {},
): { stage: EnvelopeStageOptions; events: { type: EventType; data: Record<string, unknown> }[] } {
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  const stage: EnvelopeStageOptions = {
    db: env.db,
    runId: env.runId,
    phaseId: env.phaseId,
    phaseName: "build",
    agentSessionId: null,
    visit: 1,
    attempt: 0,
    cwd: env.cwd,
    runDir: env.runDir,
    envelopePath,
    schema: opts.schema ?? QualityEnvelope,
    gates: opts.gates ?? [],
    now: () => "t1",
    emit: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
  };
  return { stage, events };
}

const outputsDir = (env: Env): string => join(env.runDir, "build", "outputs");

function writeEnvelope(env: Env, value: unknown): string {
  const dir = outputsDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "envelope.json");
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

test("a missing envelope.json is still an attempt: valid=0 row, correction-worthy error, no gates", async () => {
  const env = setup("seam-missing");
  try {
    const { stage, events } = makeStage(env, join(env.runDir, "build", "outputs", "envelope.json"));
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.error).toContain("no envelope.json written");

    const rows = listEnvelopes(env.db, env.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt: 0, valid: 0, json: "", violations: "[]", correction: null });
    expect(events).toHaveLength(0); // no envelope/gate_result/correction events for a failed read
  } finally {
    teardown(env);
  }
});

test("a zod-invalid envelope is an attempt row holding the rejected text verbatim", async () => {
  const env = setup("seam-invalid");
  try {
    const path = writeEnvelope(env, { summary: "s", artifacts: [], quality: "nope" }); // missing notes_for_next_agent
    const { stage, events } = makeStage(env, path);
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.error).toContain("notes_for_next_agent");

    const row = listEnvelopes(env.db, env.runId)[0]!;
    expect(row.valid).toBe(0);
    expect(JSON.parse(row.json)).toEqual({ summary: "s", artifacts: [], quality: "nope" });
    expect(listGateResults(env.db, env.runId)).toHaveLength(0); // gates never ran
    expect(events.filter((e) => e.type === "gate_result")).toHaveLength(0);
  } finally {
    teardown(env);
  }
});

test("blocked short-circuits BEFORE gates: recorded attempt, no gate rows, no envelope event", async () => {
  const env = setup("seam-blocked");
  try {
    const bomb: Gate = async () => {
      throw new Error("must not run");
    };
    const path = writeEnvelope(env, {
      summary: "s",
      artifacts: [],
      notes_for_next_agent: "n",
      quality: 1,
      blocked: true,
      blocked_reason: "missing API key",
    });
    const { stage, events } = makeStage(env, path, { gates: [bomb] });
    const outcome = await runEnvelopeStage(stage);
    expect(outcome).toMatchObject({ kind: "blocked" });
    if (outcome.kind === "blocked") expect(outcome.reason).toBe("missing API key");

    const row = listEnvelopes(env.db, env.runId)[0]!;
    expect(row.valid).toBe(1); // it parsed; it just cannot proceed
    expect(listGateResults(env.db, env.runId)).toHaveLength(0);
    expect(events.filter((e) => e.type === "gate_result" || e.type === "envelope")).toHaveLength(0);
  } finally {
    teardown(env);
  }
});

test("accepted: recorded attempt, per-gate rows, and the envelope event", async () => {
  const env = setup("seam-accepted");
  try {
    const path = writeEnvelope(env, { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 8 });
    const { stage, events } = makeStage(env, path);
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") expect(outcome.raw).toBe(JSON.stringify({ summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 8 }, null, 2) + "\n");

    const row = getEnvelope(env.db, (outcome as { envelopeId: string }).envelopeId)!;
    expect(row.valid).toBe(1);
    expect(row.correction).toBeNull();
    expect(events).toEqual([
      { type: "envelope", data: { phase: "build", visit: 1, attempt: 0, valid: true } },
    ]);
  } finally {
    teardown(env);
  }
});

test("a throwing gate is a per-gate violation row + envelope-row violation, never a crash", async () => {
  const env = setup("seam-crash");
  try {
    const bomb: Gate = async () => {
      throw new Error("gate blew up");
    };
    const path = writeEnvelope(env, { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 8 });
    const { stage } = makeStage(env, path, { gates: [bomb] });
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("violations");
    if (outcome.kind === "violations") expect(outcome.violations).toEqual(['gate "bomb" crashed: gate blew up']);

    const gates = listGateResults(env.db, env.runId);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ pass: 0 });
    expect(gates[0]!.violations).toContain("gate blew up");
    const row = listEnvelopes(env.db, env.runId)[0]!;
    // the exact violation (gate name + crash text) is on the envelope row
    expect(JSON.parse(row.violations)).toEqual(['gate "bomb" crashed: gate blew up']);
  } finally {
    teardown(env);
  }
});

test("the phase.envelope parse is the backstop: malformed is rejected with EMPTY gates (no shape gate required)", async () => {
  const env = setup("seam-backstop");
  try {
    // gates is EMPTY, so nothing here can reject the envelope except the
    // stage's own phase.envelope (schema) parse. The malformed envelope
    // violates QualityEnvelope's `quality: z.number()` (it's a string).
    const path = writeEnvelope(env, { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: "not-a-number" });
    const { stage, events } = makeStage(env, path, { gates: [] });
    const outcome = await runEnvelopeStage(stage);

    // rejection comes from the schema parse (references the offending field),
    // NOT from any gate — there are none.
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.error).toContain("quality");

    // no gate ever ran (there were none) and no gate rows exist — so if this
    // test ever passes with a "violations" outcome, the rejection came from a
    // gate, not the backstop. It cannot: gates is empty.
    expect(listGateResults(env.db, env.runId)).toHaveLength(0);
    expect(events.filter((e) => e.type === "gate_result")).toHaveLength(0);
    const row = listEnvelopes(env.db, env.runId)[0]!;
    expect(row.valid).toBe(0); // the backstop marked it invalid before gates
  } finally {
    teardown(env);
  }
});

test("the phase.envelope parse is the backstop: well-formed passes with EMPTY gates", async () => {
  const env = setup("seam-backstop-ok");
  try {
    // same empty-gates setup, but a well-formed envelope: it must pass the
    // parse stage purely on the schema, proving malformed-vs-well-formed is
    // decided by the backstop and not by any gate.
    const path = writeEnvelope(env, { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 9 });
    const { stage } = makeStage(env, path, { gates: [] });
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("accepted");
    expect(listGateResults(env.db, env.runId)).toHaveLength(0);
  } finally {
    teardown(env);
  }
});

test("overrideGateResult audits who + why + when and emits the human_action event", async () => {
  const env = setup("seam-override");
  try {
    const failGate: Gate = async () => ({ pass: false, violations: ["bad output"] });
    const path = writeEnvelope(env, { summary: "s", artifacts: [], notes_for_next_agent: "n", quality: 2 });
    const { stage } = makeStage(env, path, { gates: [failGate] });
    const outcome = await runEnvelopeStage(stage);
    expect(outcome.kind).toBe("violations");
    const failed = listGateResults(env.db, env.runId)[0]!;

    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const sink = new EventSink(env.db, { runId: env.runId, phaseId: null, agentSessionId: null });
    const over = overrideGateResult({
      db: env.db,
      gateResultId: failed.id,
      by: "operator-9",
      reason: "verified the output by hand",
      now: () => "t-now",
      emit: (type, data) => {
        events.push({ type, data: data as Record<string, unknown> });
        sink.push(type, data);
      },
    });
    await sink.flush();
    expect(over.approved).toBe(true);

    // the original row is KEPT — pass unchanged, badge added
    const after = listGateResults(env.db, env.runId)[0]!;
    expect(after).toMatchObject({ id: failed.id, pass: 0, overridden: 1, override_by: "operator-9" });
    expect(after.overridden_at).toBe("t-now");

    // the audit trail + the human_action event
    const trail = env.db.query("SELECT by, reason, created_at FROM gate_overrides").all() as {
      by: string;
      reason: string;
      created_at: string;
    }[];
    expect(trail).toHaveLength(1);
    expect(trail[0]).toEqual({ by: "operator-9", reason: "verified the output by hand", created_at: "t-now" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("human_action");
    expect(events[0]!.data).toMatchObject({ action: "override_gate", by: "operator-9" });
    const detail = String(events[0]!.data.detail);
    expect(detail).toContain('gate "failGate" overridden');
    expect(detail).toContain("verified the output by hand");
    const stored = cursorEvents(env.db, env.runId, 0, 100).find((e) => e.type === "human_action")!;
    expect(stored).toBeDefined();
    expect((stored.data as { action: string }).action).toBe("override_gate");
  } finally {
    teardown(env);
  }
});
