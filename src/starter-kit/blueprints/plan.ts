import { defineBlueprint } from "../../core/index.ts";
import { planner } from "../agents/planner.ts";
import { PlanEnvelope } from "../envelopes.ts";
import { envelopeShape } from "../gates/index.ts";

/**
 * plan — the spec before any code (PLAN §14): one planner phase that produces
 * a plan document. The envelope must satisfy PlanEnvelope — a plan_path is
 * required, so a planner that wrote no plan cannot pass.
 *
 * Replace-this: the agent, envelope, and gates are the point of this file.
 */
export default defineBlueprint({
  name: "plan",
  phases: [
    {
      name: "plan",
      agent: planner,
      envelope: PlanEnvelope,
      gates: [envelopeShape(PlanEnvelope)],
      budget: 3,
    },
  ],
});
