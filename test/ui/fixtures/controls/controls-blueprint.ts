import { z } from "zod";
import { EnvelopeBase, defineAgent, defineBlueprint } from "../../../../src/core/index.ts";
import type { Envelope, Gate } from "../../../../src/core/index.ts";

/**
 * The T10b run-controls e2e fixture — a one-phase blueprint whose gate ALWAYS
 * fails: the correction budget (1) exhausts on the second attempt and the run
 * PAUSES at the budget_exhausted menu (steer / override / restart-fresh /
 * fail — every pause-menu action except approve). Driven by fake-pi/build.json
 * (a 2-turn script; both turns write a valid envelope with quality 4, which
 * parses fine but fails `neverGreen`).
 *
 * The same script serves the approval + resume fixtures: with gates: [] (or a
 * happy blueprint) the quality-4 envelope is simply accepted and the phase
 * succeeds.
 *
 * NOTE: zod appears here ONLY because this is a BLUEPRINT FIXTURE — the daemon
 * imports blueprint modules at submit (§13.3) and blueprints are core-side
 * artifacts. The UI runtime (app/) does not import zod (§16.12).
 */
const neverGreen: Gate = async () => ({ pass: false, violations: ["never green by design"] });

const QualityEnvelope = EnvelopeBase.extend({ quality: z.number().min(0).max(10) });

const builder = defineAgent({
  name: "builder",
  model: "fake-pi",
  prompt: "Execute the phase goal and write your final result to envelope.json in your outputs directory.",
  tools: ["bash"],
  context: [],
});

export default defineBlueprint({
  name: "controls-demo",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: QualityEnvelope,
      gates: [neverGreen],
      budget: 1,
    },
  ],
});

// keep the Envelope import for TS consumers of this fixture
export type { Envelope };
