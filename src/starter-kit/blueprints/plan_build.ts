import { defineBlueprint } from "../../core/index.ts";
import { builder } from "../agents/builder.ts";
import { planner } from "../agents/planner.ts";
import { ship } from "../agents/ship.ts";
import { BuildEnvelope, PlanEnvelope, ShipEnvelope } from "../envelopes.ts";
import { envelopeShape, matchesPlan } from "../gates/index.ts";

/**
 * plan_build — small, well-understood work (PLAN §14): plan, build against
 * the plan, then ship. The build phase's matchesPlan gate refuses an envelope
 * that does not reference the plan document, and the ship phase pauses for a
 * human before any commit/PR is made (require_approval).
 *
 * Replace-this: the phases, gates, and agents are the point of this file.
 */
export default defineBlueprint({
  name: "plan_build",
  phases: [
    {
      name: "plan",
      agent: planner,
      envelope: PlanEnvelope,
      gates: [envelopeShape(PlanEnvelope)],
      budget: 3,
    },
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      // the build must reference the plan the planner wrote (a plan file
      // arrives in this phase's inputs via the §9.3 handoff)
      gates: [envelopeShape(BuildEnvelope), matchesPlan()],
      budget: 3,
      on_fail: { to: "plan" }, // a build that cannot pass goes back to planning
    },
    {
      name: "ship",
      agent: ship,
      envelope: ShipEnvelope,
      gates: [envelopeShape(ShipEnvelope)],
      budget: 3,
      require_approval: true, // a human says go before the commit/PR
    },
  ],
});
