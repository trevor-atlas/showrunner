import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "@showrunner/core";
import type { Envelope, Gate } from "@showrunner/core";

/**
 * The T11 phase-drill-in e2e blueprint (packages/ui test fixtures) — two
 * phases that exercise the FULL drill-in data variety:
 *
 *  - build  — attempt 1 is INVALID (envelope missing `quality` → zod
 *             rejection → correction), attempt 2 is VALID but fails the
 *             quality gate (violations → correction), attempt 3 PASSES →
 *             accepted. usage carries provider-reported cost (reported USD).
 *  - verify — every attempt fails `verifyNeverGreen` → budget exhausted →
 *             the run PAUSES; the e2e overrides the gate (audited, who+why)
 *             and the drill-in shows the override badge. usage reports tokens
 *             but NO cost → the roster estimates USD (the §11.1 estimated
 *             marker path, prices.json lives in the scratch data dir).
 *
 * The e2e mutates this module file AFTER submit to prove the CONFIG card
 * renders the §13.3 snapshot (what actually ran), never the live module.
 */

const qualityGate: Gate = async (envelope: Envelope) => {
  const quality = (envelope as unknown as { quality: number }).quality;
  return quality >= 7 ? { pass: true } : { pass: false, violations: [`quality ${quality} below 7`] };
};

const verifyNeverGreen: Gate = async () => ({
  pass: false,
  violations: ["verify gate always fails by design"],
});

const QualityEnvelope = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });

const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: [
    "You are the builder in the drill-in demo.",
    "Write your final result to context_handoff/build/outputs/envelope.json",
    "matching the [Envelope contract] schema exactly, with quality >= 7.",
    "If a gate rejects your envelope, read the violation and fix it.",
  ].join("\n"),
  tools: ["bash", "edit", "read"],
  context: ["README.md", "demo repo rules"],
});

const verifier = defineAgent({
  name: "verifier",
  model: "fake-pi",
  prompt: "Write your final result to context_handoff/verify/outputs/envelope.json with quality 5.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "drill-in-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [qualityGate],
      budget: 3,
    },
    {
      name: "verify",
      agent: verifier,
      envelope: QualityEnvelope,
      gates: [verifyNeverGreen],
      budget: 2,
    },
  ],
});
