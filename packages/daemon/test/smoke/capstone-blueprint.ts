import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint, createShell } from "@showrunner/core";
import type { Gate, GateContext } from "@showrunner/core";
// the starter kit's real-command gates — imported relative so the daemon's
// module loader can resolve them from the monorepo (no workspaces)
import { testsPass, lintClean } from "../../../starter-kit/src/gates/index.ts";

/**
 * The capstone smoke blueprint (T13, spec §17): plan → build → verify → ship
 * on a tiny REAL git repo, proving the §5 wiring end to end against real pi.
 *
 * The repo ships with a deliberately broken `src/add.ts` (a-b instead of a+b)
 * and a failing test. The chain:
 *
 *  - plan    — the planner writes plan.md (real artifact gate).
 *  - build   — the builder must make `bun test` green. `verifyFix` FAILS the
 *              first submitted envelope (arranged per the acceptance: "a gate
 *              that fails until a fix lands"), so a real correction is issued
 *              to the SAME session; on the next attempt it runs the REAL
 *              `bun test`. `testsPass` and `lintClean` (starter-kit) run real
 *              commands in the repo.
 *  - verify  — the verifier is told to report quality 5; `qualityGate`
 *              demands >= 8, so the phase exhausts its budget and PAUSES — the
 *              smoke overrides the failed gate through the CLI (§5.3).
 *  - ship    — require_approval pauses; the smoke approves through the CLI.
 *
 * Every phase spawns a real pi session (SHOWRUNNER_SMOKE=1 in the daemon's
 * env selects the real SessionDriver). Placeholder fake-pi scripts live next
 * to this module because the daemon resolves scripted sessions at submit
 * regardless of driver kind; real mode never reads them.
 */
const planner = defineAgent({
  name: "planner",
  model: "smoke-default",
  prompt: [
    "You are the planner in a SMOKE TEST. The repo is a tiny git repo with a",
    "broken src/add.ts (it subtracts instead of adding) and a failing test in",
    "test/add.test.ts.",
    "Your ONLY job, in the fewest steps possible:",
    "1. Write a short plan (3-5 sentences) for a builder: fix src/add.ts so",
    "   add(1,2) === 3, keep the test suite green (bun test), and keep the",
    "   typecheck clean (bunx tsc --noEmit).",
    "2. Write that plan to context_handoff/plan/outputs/plan.md (create the file).",
    "3. Write your final result to context_handoff/plan/outputs/envelope.json as a",
    "   JSON object matching the [Envelope contract] schema exactly, with your",
    "   plan text in the \"plan\" field and the artifact path \"plan.md\".",
    "Do NOT modify any code. Keep it minimal — this is a smoke test.",
  ].join("\n"),
  tools: ["bash", "edit", "read", "grep", "find"],
  context: [],
});

const builder = defineAgent({
  name: "builder",
  model: "smoke-default",
  prompt: [
    "You are the builder in a SMOKE TEST. The repo is a tiny git repo with a",
    "broken src/add.ts and a failing test in test/add.test.ts.",
    "Your ONLY job, in the fewest steps possible:",
    "1. Read the failing test and fix src/add.ts so the suite passes",
    "   (run `bun test` to verify). Keep `bunx tsc --noEmit` clean too.",
    "2. Write your final result to context_handoff/build/outputs/envelope.json as a",
    "   JSON object matching the [Envelope contract] schema exactly, with",
    "   \"implemented\": true and the artifact path \"src/add.ts\".",
    "If a gate rejects your envelope, read the violation message and follow it.",
    "Do NOT modify README.md or the plan phase's outputs. Keep it minimal.",
  ].join("\n"),
  tools: ["bash", "edit", "read", "grep", "find"],
  context: [],
});

const verifier = defineAgent({
  name: "verifier",
  model: "smoke-default",
  prompt: [
    "You are the verifier in a SMOKE TEST.",
    "Your ONLY job: write your final result to",
    "context_handoff/verify/outputs/envelope.json as a JSON object matching the",
    "[Envelope contract] schema exactly, with \"quality\": 5 and the artifact",
    "path \"plan.md\". Report exactly quality 5 — that is what this test phase",
    "checks. Keep it minimal.",
  ].join("\n"),
  tools: ["bash", "edit", "read"],
  context: [],
});

const shipper = defineAgent({
  name: "shipper",
  model: "smoke-default",
  prompt: [
    "You are the shipper in a SMOKE TEST. The build passed its gates; the",
    "envelope is in your [Handoff from previous phase].",
    "Your ONLY job: write your final result to",
    "context_handoff/ship/outputs/envelope.json as a JSON object matching the",
    "[Envelope contract] schema exactly, with \"shipped\": true and the",
    "artifact path \"src/add.ts\". Keep it minimal — do NOT commit or push.",
  ].join("\n"),
  tools: ["bash", "edit", "read"],
  context: [],
});

const PlanEnvelope = EnvelopeBase.extend({ plan: z.string().min(10) });
const BuildEnvelope = EnvelopeBase.extend({ implemented: z.boolean() });
const VerifyEnvelope = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });
const ShipEnvelope = EnvelopeBase.extend({ shipped: z.boolean() });

/** The planner's plan artifact must exist (§9.3 feeds it to build). */
const planArtifactGate: Gate = async (_envelope, ctx) => {
  const planFile = join(ctx.cwd, "context_handoff", "plan", "outputs", "plan.md");
  if (!existsSync(planFile)) {
    return { pass: false, violations: ["plan.md artifact missing (write it to context_handoff/plan/outputs/plan.md)"] };
  }
  return { pass: true };
};

/**
 * "A gate that fails until a fix lands" (the acceptance): the FIRST submitted
 * envelope is rejected deterministically so the correction path is exercised
 * with real pi on the SAME --session-id; every later attempt is judged by the
 * REAL `bun test` in the workspace — the run can only succeed once the agent
 * genuinely fixed the repo.
 */
const verifyFix: Gate = (() => {
  let first = true;
  return async (_envelope, ctx: GateContext) => {
    if (first) {
      first = false;
      return {
        pass: false,
        violations: [
          "the repository's test suite is not green yet — run `bun test` and make it pass (fix src/add.ts) before resubmitting",
        ],
      };
    }
    const res = await createShell(ctx.cwd)("bun test");
    if (res.code === 0) return { pass: true };
    return {
      pass: false,
      violations: [`bun test failed (exit ${res.code}): ${(res.stderr || res.stdout || "no output").slice(0, 300)}`],
    };
  };
})();

/**
 * The verify phase's quality bar. Deterministic by design (T13): the gate
 * fails the phase's first two envelopes — the verifier is instructed to report
 * quality 5 and a HELPFUL real model may bump it anyway, so the failure cannot
 * depend on the model. The violation names the bar; the smoke then overrides
 * the failed gate through the CLI (§5.3) exactly like a human would accept a
 * borderline review.
 */
const qualityGate: Gate = (() => {
  let calls = 0;
  return async function qualityGate(envelope) {
    calls += 1;
    const quality = (envelope as unknown as { quality: number }).quality;
    if (calls <= 2) {
      return { pass: false, violations: [`quality ${quality} is below the required 8 — manual review required`] };
    }
    return { pass: true };
  };
})();

export default defineBlueprint({
  name: "smoke_capstone",
  phases: [
    {
      name: "plan",
      agent: planner,
      envelope: PlanEnvelope,
      gates: [planArtifactGate],
      budget: 2,
    },
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      // the arranged first-fail gate + the starter kit's REAL-COMMAND gates
      gates: [verifyFix, testsPass(), lintClean({ command: "bunx tsc --noEmit" })],
      budget: 2,
    },
    {
      name: "verify",
      agent: verifier,
      envelope: VerifyEnvelope,
      gates: [qualityGate],
      budget: 1,
    },
    {
      name: "ship",
      agent: shipper,
      envelope: ShipEnvelope,
      gates: [],
      budget: 2,
      require_approval: true,
    },
  ],
});
