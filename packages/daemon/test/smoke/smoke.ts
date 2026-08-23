/**
 * SHOWRUNNER_SMOKE=1 smoke (spec §17, T02): plan → build on a tiny repo with
 * the REAL pi binary, end to end.
 *
 *   SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun packages/daemon/test/smoke/smoke.ts
 *
 * Drives the §5 run loop (runBlueprint) against a real blueprint — planner +
 * builder phases, a real envelope schema, and real gates (a file-exists gate
 * per phase) — with real pi sessions. Confirms the T02 acceptance criteria:
 * folded events (turns, tool calls, settle), spend recorded, terminal success.
 *
 * The smoke costs a little real spend; that is the ticket's point. Without
 * SHOWRUNNER_SMOKE=1 this script exits 0 having done nothing (so it is safe
 * even if a test runner stumbles on it). The non-smoke suite needs no pi
 * binary at all — FakePi covers it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { EnvelopeBase, defineBlueprint, runDirFor } from "@showrunner/core";
import type { Envelope, Gate } from "@showrunner/core";
import { cursorEvents, getRun, listPhases, openDb, runBlueprint } from "../../src/index.ts";

const SKIP = `skipped: set SHOWRUNNER_SMOKE=1 to run the real-pi smoke (it costs a little real spend)`;

if (process.env.SHOWRUNNER_SMOKE !== "1") {
  console.log(SKIP);
  process.exit(0);
}

// ── resolve the pi binary ────────────────────────────────────────────────────

function resolvePi(): string {
  const fromEnv = process.env.SHOWRUNNER_PI_BINARY ?? process.env.PI_BINARY;
  if (fromEnv) return fromEnv;
  const which = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() !== "") return which.stdout.trim();
  return "pi"; // let the spawn fail loudly with a clear message
}

const piBinary = resolvePi();
console.log(`smoke: pi binary = ${piBinary}`);
const version = spawnSync(piBinary, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error(`smoke: cannot run pi at ${piBinary}: ${version.stderr}`);
  process.exit(1);
}
console.log(`smoke: pi version  = ${version.stdout.trim()}`);

// ── the demo repo and the blueprint ──────────────────────────────────────────

const repo = mkdtempSync(join(tmpdir(), "showrunner-smoke-repo-"));
const dataDir = mkdtempSync(join(tmpdir(), "showrunner-smoke-data-"));
const keep = process.env.SHOWRUNNER_SMOKE_KEEP === "1";

function cleanup(): void {
  if (keep) return;
  rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

console.log(`smoke: repo     = ${repo}`);
console.log(`smoke: data dir = ${dataDir}`);

// a tiny repo: one README describing the whole task
if (!existsSync(join(repo, "README.md"))) {
  writeFileSync(
    join(repo, "README.md"),
    [
      "# smoke repo",
      "",
      "A tiny repo for the Showrunner smoke test. The builder's job: create",
      "context_handoff/build/outputs/result.md containing the line",
      "`implemented by <builder agent>`.",
    ].join("\n") + "\n",
  );
}

const PlanEnvelope = EnvelopeBase.extend({
  plan: z.string().min(10),
});

const BuildEnvelope = EnvelopeBase.extend({
  implemented: z.boolean(),
});

/** A real gate: the plan's artifact file must exist in the outputs dir. */
const planGate: Gate = async (envelope: Envelope, ctx) => {
  const plan = (envelope as unknown as { plan: string }).plan;
  if (plan.trim().length < 10) {
    return { pass: false, violations: ["plan must be at least 10 characters"] };
  }
  if (!existsSync(join(ctx.cwd, "context_handoff", "plan", "outputs", "plan.md"))) {
    return { pass: false, violations: ["plan.md artifact missing (write it to context_handoff/plan/outputs/plan.md)"] };
  }
  return { pass: true };
};

/** A real gate: the build must have actually happened (file-exists). */
const buildGate: Gate = async (envelope: Envelope, ctx) => {
  if ((envelope as unknown as { implemented: boolean }).implemented !== true) {
    return { pass: false, violations: ["implemented must be true"] };
  }
  if (!existsSync(join(ctx.cwd, "context_handoff", "build", "outputs", "result.md"))) {
    return { pass: false, violations: ["result.md artifact missing (write it to context_handoff/build/outputs/result.md)"] };
  }
  return { pass: true };
};

const blueprint = defineBlueprint({
  name: "smoke",
  phases: [
    {
      name: "plan",
      agent: {
        name: "planner",
        model: "smoke-default",
        prompt: [
          "You are the planner in a SMOKE TEST. The repo is a tiny repo with only README.md.",
          "Your ONLY job, in the fewest steps possible:",
          "1. Write a short plan (3-6 sentences) for a builder to create a file",
          "   context_handoff/build/outputs/result.md containing the line",
          "   `implemented by builder`.",
          "2. Write that plan to context_handoff/plan/outputs/plan.md (create the file).",
          "3. Write your final result to context_handoff/plan/outputs/envelope.json as a",
          "   JSON object matching the [Envelope contract] schema exactly, with your plan",
          "   text in the \"plan\" field and the artifact path \"plan.md\".",
          "",
          "Do NOT run git, install anything, or run tests. Do NOT modify README.md.",
          "Keep it minimal — this is a smoke test.",
        ].join("\n"),
        tools: ["bash", "edit", "read", "grep", "find"],
        context: [],
      },
      envelope: PlanEnvelope,
      gates: [planGate],
      budget: 3,
    },
    {
      name: "build",
      agent: {
        name: "builder",
        model: "smoke-default",
        prompt: [
          "You are the builder in a SMOKE TEST. The repo is a tiny repo with only README.md.",
          "The planner's plan is in your [Handoff from previous phase] / inputs.",
          "Your ONLY job, in the fewest steps possible:",
          "1. Create the file context_handoff/build/outputs/result.md containing exactly the",
          "   line `implemented by builder`.",
          "2. Write your final result to context_handoff/build/outputs/envelope.json as a",
          "   JSON object matching the [Envelope contract] schema exactly, with",
          "   \"implemented\": true and the artifact path \"result.md\".",
          "",
          "Do NOT run git, install anything, or run tests. Do NOT modify README.md or the",
          "plan phase's outputs. Keep it minimal — this is a smoke test.",
        ].join("\n"),
        tools: ["bash", "edit", "read", "grep", "find"],
        context: [],
      },
      envelope: BuildEnvelope,
      gates: [buildGate],
      budget: 3,
    },
  ],
});

// ── run it ───────────────────────────────────────────────────────────────────

const db = openDb(join(dataDir, "showrunner.db"));
const startedAt = Date.now();
console.log("smoke: submitting run against the real pi driver (SHOWRUNNER_SMOKE=1)…\n");

const run = runBlueprint(db, dataDir, { blueprint, cwd: repo, scripts: {} });
const result = await run.done;
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

const runId = run.run_id;
const events = cursorEvents(db, runId, 0, 100_000);
const byType = new Map<string, number>();
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

const rawPath = join(runDirFor(dataDir, runId), "raw_output.jsonl");
const rawText = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
const settleLines = rawText.split("agent_settled").length - 1;
const toolCalls = events.filter((e) => e.type === "tool_call");
const spends = events.filter((e) => e.type === "spend");
const spendUsd = spends.reduce((s, e) => s + (((e.data as { usd: number | null }).usd) ?? 0), 0);
const agentEnds = events.filter((e) => e.type === "agent_end");

console.log(`smoke: run ${runId} finished in ${elapsedSec}s`);
console.log(`smoke: result status=${result.status} needs_review=${result.needs_review}`);
console.log("smoke: event counts by type:");
for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(14)} ${n}`);
console.log(`smoke: raw lines=${rawText.split("\n").filter(Boolean).length} agent_settled lines=${settleLines}`);
console.log(`smoke: tool calls=${toolCalls.length} spend events=${spends.length} spend_usd=$${spendUsd.toFixed(6)}`);
for (const a of agentEnds) {
  const d = a.data as { agent: string; pi_session_id: string; exit: number | null; ok: boolean };
  console.log(`smoke: agent_end ${d.agent} session=${d.pi_session_id} exit=${d.exit} ok=${d.ok}`);
}

// ── assertions (the T02 acceptance criteria) ─────────────────────────────────

const failures: string[] = [];
if (result.status !== "success") failures.push(`run status ${result.status} != success`);
if (result.needs_review) failures.push("needs_review set on a clean run");
if (byType.get("agent_start") !== 2) failures.push(`expected 2 agent_start (plan+build), got ${byType.get("agent_start")}`);
if (agentEnds.length !== 2 || !agentEnds.every((a) => (a.data as { ok: boolean }).ok)) {
  failures.push("expected 2 ok agent_end events (settled, clean exit)");
}
if (toolCalls.length === 0) failures.push("no folded tool_call events");
if (settleLines < 2) failures.push(`expected >= 2 agent_settled raw lines, got ${settleLines}`);
if (spends.length === 0) failures.push("no spend events recorded");
const byPhase = new Map<string, { status: string; spend_usd: number }>();
for (const p of listPhases(db, runId)) byPhase.set(p.name, { status: p.status, spend_usd: p.spend_usd });
console.log("smoke: phases:");
for (const [name, p] of byPhase) console.log(`  ${name.padEnd(8)} ${p.status.padEnd(10)} spend=$${p.spend_usd.toFixed(6)}`);
if (byPhase.get("plan")?.status !== "success") failures.push("plan phase did not succeed");
if (byPhase.get("build")?.status !== "success") failures.push("build phase did not succeed");
if (getRun(db, runId)?.status !== "success") failures.push("runs row is not success");

db.close();

if (failures.length > 0) {
  console.error("\nsmoke FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("\nsmoke PASSED: real pi plan → build completed; folded events, settle, and spend recorded.");
console.log(`smoke: raw record at ${rawPath}`);
if (keep) console.log("smoke: SHOWRUNNER_SMOKE_KEEP=1 — artifacts kept");
