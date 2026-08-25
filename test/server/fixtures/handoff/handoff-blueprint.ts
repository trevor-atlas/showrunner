import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../../src/core/index.ts";
import type { Envelope, Gate } from "../../../../src/core/index.ts";

/**
 * The context & handoff protocol fixture (T05) — the round-trip proof that
 * runs on FakePi only: two phases, no real pi, no tokens.
 *
 * plan (2 turns): turn 1 fails the quality gate (4 < 7) → one correction →
 * turn 2 passes and "writes" an ARTIFACT (plan.md) next to its envelope.json.
 * build (1 turn): passes; its inputs/ must contain plan's accepted envelope
 * AND plan.md — the zero-friction handoff, no declaration required.
 *
 * Context entries exercise the resolution rule through every branch:
 *   planner.context:
 *     "Context literal: …"      → pure literal (not a path)
 *     "docs/context.md"         → resolves to a FILE in the run's cwd → inlined
 *     "agent-notes.md"          → resolves via the module-dir fallback → inlined
 *     "quality.md"              → collision: a string that IS a real file in
 *                                  the cwd gets read as a file, not as prose
 *   builder.context + build.context (phase additions, appended after agent
 *   defaults): "Build literal: …" and "*.md" (no file named "*.md" exists →
 *   literal, proving exact paths only — no globs).
 *
 * Run it with: showrunner run packages/daemon/test/fixtures/handoff/handoff-blueprint.ts
 */
const QualityEnvelope = EnvelopeBase.extend({
  /** 0..10 self-reported quality — the gate demands >= 7 */
  quality: z.number().min(0).max(10),
});

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  if (quality >= 7) return { pass: true };
  return { pass: false, violations: [`quality ${quality} is below the required 7`] };
};

const planner = defineAgent({
  name: "planner",
  model: "fake-pi",
  prompt: "Plan the work; write your envelope.json and plan.md to your outputs directory.",
  tools: ["bash", "edit", "read"],
  context: [
    "Context literal: the plan must name the module, the slices, and the done criteria.",
    "docs/context.md",
    "agent-notes.md",
    "quality.md",
  ],
});

const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Build from the plan; write your envelope.json to your outputs directory.",
  tools: ["bash", "edit", "read"],
  context: ["Build literal: ship the smallest thing that satisfies the plan."],
});

export default defineBlueprint({
  name: "handoff",
  phases: [
    {
      name: "plan",
      agent: planner,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
    {
      name: "build",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
      // phase-level additions ride after the agent's defaults in the prompt
      context: ["Phase addition literal: prefer green CI over coverage.", "*.md"],
    },
  ],
});
