import { defineBlueprint } from "../../core/index.ts";
import { builder } from "../agents/builder.ts";
import { planner } from "../agents/planner.ts";
import { reviewer } from "../agents/reviewer.ts";
import { ship } from "../agents/ship.ts";
import { BuildEnvelope, PlanEnvelope, ReviewEnvelope, ShipEnvelope } from "../envelopes.ts";
import { envelopeShape, lintClean, matchesPlan, reviewApproved, testsPass } from "../gates/index.ts";

/**
 * everything — the work is real and its shape is not obvious:
 * plan, build, test, review, ship. Like plan_build_test but heavier: the plan
 * itself requires a human approval before anything is built (require_approval
 * on the plan phase), and every phase carries a larger correction budget.
 *
 * Replace-this: the phases, gates, and agents are the point of this file.
 */
export default defineBlueprint({
  name: "everything",
  phases: [
    {
      name: "plan",
      agent: planner,
      envelope: PlanEnvelope,
      gates: [envelopeShape(PlanEnvelope)],
      budget: 4,
      require_approval: true, // the shape is not obvious — a human approves the plan first
    },
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      gates: [envelopeShape(BuildEnvelope), matchesPlan(), testsPass(), lintClean()],
      budget: 4,
      on_fail: { to: "plan" },
    },
    {
      name: "review",
      agent: reviewer,
      envelope: ReviewEnvelope,
      gates: [envelopeShape(ReviewEnvelope), reviewApproved()],
      budget: 4,
      on_fail: { to: "build" }, // rejected review → revise
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
