import { test, expect, expectTypeOf } from "bun:test";
import { z } from "zod";

import {
  BlueprintValidationError,
  DEFAULT_BUDGET,
  DEFAULT_DATA_DIR_NAME,
  EnvelopeBase,
  PhaseStartData,
  defineAgent,
  defineBlueprint,
  parseEventData,
  resolveDataDir,
  validateBlueprint,
} from "../../src/core/index.ts";
import type {
  Blueprint,
  Envelope,
  PhaseStartCause,
  PhaseStartCauseFlow,
  PhaseStartCauseHuman,
  PhaseStartCauseOnFail,
} from "../../src/core/index.ts";

// ── Envelope ────────────────────────────────────────────────────────────

test("EnvelopeBase accepts a valid envelope", () => {
  const env = EnvelopeBase.parse({
    summary: "did the thing",
    artifacts: ["out/thing.txt"],
    notes_for_next_agent: "next: check the thing",
  });
  expect(env.summary).toBe("did the thing");
  expect(env.blocked).toBeUndefined();
});

test("EnvelopeBase rejects an envelope missing required fields", () => {
  const r = EnvelopeBase.safeParse({ summary: "x" });
  expect(r.success).toBe(false);
});

test("EnvelopeBase accepts optional blocked/blocked_reason", () => {
  const env = EnvelopeBase.parse({
    summary: "s",
    artifacts: [],
    notes_for_next_agent: "n",
    blocked: true,
    blocked_reason: "missing API key",
  });
  expect(env.blocked).toBe(true);
});

// ── Agent ───────────────────────────────────────────────────────────────

test("defineAgent is a pass-through definition helper", () => {
  const a = defineAgent({
    name: "builder",
    model: "claude-sonnet-4",
    prompt: "implement plans",
    tools: ["bash", "edit", "read"],
    context: ["docs/spec/README.md"],
  });
  expect(a.name).toBe("builder");
});

// ── Blueprint load-time validation ──────────────────────────────────────

const agent = defineAgent({
  name: "builder",
  model: "m",
  prompt: "p",
  tools: ["bash"],
  context: [],
});

const baseEnvelope = EnvelopeBase.extend({
  quality_score: z.number().optional(),
});

function validBlueprint(): Blueprint {
  return {
    name: "build",
    phases: [
      {
        name: "plan",
        agent,
        envelope: baseEnvelope,
        gates: [],
        budget: 2,
      },
      {
        name: "build",
        agent,
        envelope: baseEnvelope,
        gates: [],
        budget: 3,
        on_fail: { to: "plan" }, // cycles allowed; the loop guard terminates
      },
    ],
  };
}

test("defineBlueprint validates and returns a valid blueprint", () => {
  const b = defineBlueprint(validBlueprint());
  expect(b.name).toBe("build");
  expect(b.phases).toHaveLength(2);
});

test("duplicate phase names are rejected", () => {
  const b = validBlueprint();
  b.phases[1]!.name = "plan";
  expect(() => defineBlueprint(b)).toThrow(BlueprintValidationError);
  expect(() => defineBlueprint(b)).toThrow(/duplicate phase name "plan"/);
});

test("on_fail.to must name an existing phase", () => {
  const b = validBlueprint();
  b.phases[1]!.on_fail = { to: "nope" };
  expect(() => validateBlueprint(b)).toThrow(/on_fail.to "nope" does not name an existing phase/);
});

test("an empty blueprint is rejected", () => {
  expect(() => defineBlueprint({ name: "empty", phases: [] })).toThrow(
    BlueprintValidationError,
  );
});

test("budget must be a positive integer", () => {
  const b = validBlueprint();
  b.phases[0]!.budget = 0;
  expect(() => validateBlueprint(b)).toThrow(/budget must be a positive integer/);
});

test("a phase envelope with no base conflict but redefined optional type is rejected", () => {
  const b = validBlueprint();
  b.phases[0]!.envelope = z.object({
    summary: z.string(),
    artifacts: z.array(z.number()), // artifacts must be string[]
    notes_for_next_agent: z.string(),
  }) as unknown as z.ZodType<Envelope>;
  expect(() => defineBlueprint(b)).toThrow(BlueprintValidationError);
});

test("a phase envelope extending EnvelopeBase with required extras is accepted", () => {
  const withRequired = EnvelopeBase.extend({ quality_score: z.number() });
  const b = validBlueprint();
  b.phases[0]!.envelope = withRequired;
  expect(() => defineBlueprint(b)).not.toThrow();
});

test("a phase envelope that redefines a base field with an incompatible type is rejected", () => {
  const broken = z.object({
    summary: z.number(), // must be a string
    artifacts: z.array(z.string()),
    notes_for_next_agent: z.string(),
  });
  const b = validBlueprint();
  b.phases[0]!.envelope = broken as unknown as z.ZodType<Envelope>;
  expect(() => defineBlueprint(b)).toThrow(BlueprintValidationError);
  expect(() => defineBlueprint(b)).toThrow(/envelope must extend EnvelopeBase/);
});

test("a non-object phase envelope is rejected", () => {
  const b = validBlueprint();
  b.phases[0]!.envelope = z.string() as unknown as z.ZodType<Envelope>;
  expect(() => defineBlueprint(b)).toThrow(BlueprintValidationError);
});

// ── domain types ────────────────────────────────────────────────────────

test("DEFAULT_BUDGET is 3", () => {
  expect(DEFAULT_BUDGET).toBe(3);
});

// ── event data shapes ─────────────────────────────────────────────────────

test("parseEventData validates the twelve event shapes", () => {
  const cases = [
    ["run_submitted", { blueprint: "b", cwd: "/w" }],
    ["run_status", { from: "submitted", to: "running" }],
    ["phase_start", { phase: "build", agent: "builder", visit: 1, budget: 3 }],
    ["phase_end", { phase: "build", status: "success", visits: 1, corrections: 0, spend_usd: 0.01 }],
    ["agent_start", { agent: "builder", pi_session_id: "s1", pid: 42, model: "m" }],
    ["agent_end", { agent: "builder", pi_session_id: "s1", exit: 0, ok: true }],
    ["tool_call", { tool: "bash", tool_call_id: "c1", args: "ls", result_snippet: "src/", ok: true, duration_ms: 12, agent: "builder" }],
    ["envelope", { phase: "build", visit: 1, attempt: 0, valid: true }],
    ["gate_result", { gate: "testsPass", pass: true, violations: [] }],
    ["correction", { phase: "build", visit: 1, reason: "invalid envelope", message: "return valid JSON" }],
    ["human_action", { action: "steer", detail: "check the tests" }],
    ["spend", { phase: "build", tokens_in: 100, tokens_out: 20, cache_read: 0, cache_write: 0, usd: 0.002, estimated: false }],
    ["spend", { phase: "build", tokens_in: 100, tokens_out: 20, cache_read: 0, cache_write: 0, usd: 0.0011, estimated: true }],
  ] as const;
  for (const [type, data] of cases) {
    expect(() => parseEventData(type as never, data)).not.toThrow();
  }
});

test("parseEventData rejects malformed event data", () => {
  expect(() => parseEventData("tool_call", { tool: "bash" })).toThrow();
  expect(() => parseEventData("spend", { phase: "build", usd: "not a number" })).toThrow();
  // every spend event must state its provenance: estimated is required
  expect(() =>
    parseEventData("spend", { phase: "build", tokens_in: 1, tokens_out: 1, cache_read: 0, cache_write: 0, usd: null }),
  ).toThrow();
});

// ── phase_start cause (R2): optional, back-compatible, typed ─────────────

test("R2: an old-style phase_start payload (no cause) still validates (back-compat)", () => {
  const oldStyle = { phase: "build", agent: "builder", visit: 1, budget: 3 };
  // through the canonical validator path AND the schema directly
  expect(parseEventData("phase_start", oldStyle)).toEqual(oldStyle);
  expect(PhaseStartData.parse(oldStyle)).toEqual(oldStyle);
});

test("R2: phase_start cause accepts every stamped shape (flow / on_fail / human)", () => {
  const cases = [
    { phase: "build", agent: "builder", visit: 1, budget: 3, cause: { kind: "flow" } },
    { phase: "rescue", agent: "builder", visit: 1, budget: 3, cause: { kind: "on_fail", from_phase: "build", from_visit: 2 } },
    { phase: "build", agent: "builder", visit: 2, budget: 3, cause: { kind: "human", action: "restart" } },
    { phase: "build", agent: "builder", visit: 2, budget: 3, cause: { kind: "human", action: "restart", by: "operator" } },
    { phase: "build", agent: "builder", visit: 1, budget: 3, cause: { kind: "human", action: "resume" } },
  ];
  for (const data of cases) {
    expect(() => parseEventData("phase_start", data)).not.toThrow();
  }
});

test("R2: malformed causes are rejected (wrong kind / missing fields / wrong types)", () => {
  const base = { phase: "build", agent: "builder", visit: 1, budget: 3 };
  const badCauses = [
    { kind: "steer" }, // not a cause kind
    { kind: "on_fail" }, // missing from_phase + from_visit
    { kind: "on_fail", from_phase: "build" }, // missing from_visit
    { kind: "on_fail", from_phase: "build", from_visit: "1" }, // wrong from_visit type
    { kind: "human" }, // missing action
    { kind: "human", action: 42 }, // wrong action type
  ];
  for (const cause of badCauses) {
    expect(() => parseEventData("phase_start", { ...base, cause })).toThrow();
  }
});

test("R2: the inferred cause types are the three-variant union the spec declares", () => {
  expectTypeOf<PhaseStartCause>().toEqualTypeOf<PhaseStartCauseFlow | PhaseStartCauseOnFail | PhaseStartCauseHuman>();
  expectTypeOf<PhaseStartCauseFlow>().toEqualTypeOf<{ kind: "flow" }>();
  expectTypeOf<PhaseStartCauseOnFail>().toEqualTypeOf<{ kind: "on_fail"; from_phase: string; from_visit: number }>();
  expectTypeOf<PhaseStartCauseHuman>().toEqualTypeOf<{ kind: "human"; action: string; by?: string }>();
});

// ── data dir resolution ─────────────────────────────────────────────────

test("resolveDataDir defaults to ~/.showrunner", () => {
  expect(resolveDataDir({})).toEndWith(`/${DEFAULT_DATA_DIR_NAME}`);
});

test("resolveDataDir honors SHOWRUNNER_DATA_DIR", () => {
  expect(resolveDataDir({ SHOWRUNNER_DATA_DIR: "/tmp/x" })).toBe("/tmp/x");
  // blank value falls back to the default
  expect(resolveDataDir({ SHOWRUNNER_DATA_DIR: "  " })).toEndWith(DEFAULT_DATA_DIR_NAME);
});
