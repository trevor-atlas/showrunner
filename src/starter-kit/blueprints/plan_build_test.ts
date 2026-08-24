import { defineBlueprint } from "../../core/index.ts";
import { builder } from "../agents/builder.ts";
import { planner } from "../agents/planner.ts";
import { reviewer } from "../agents/reviewer.ts";
import { ship } from "../agents/ship.ts";
import { BuildEnvelope, PlanEnvelope, ReviewEnvelope, ShipEnvelope } from "../envelopes.ts";
import { envelopeShape, lintClean, matchesPlan, reviewApproved, testsPass } from "../gates/index.ts";

/**
 * plan_build_test — the standard chain: plan, build, gate
 * (test, lint), review, ship. The build must pass tests + typecheck AND
 * reference the plan; the review must approve; a rejected review routes back
 * to the builder (bounded revise loop); and the ship phase pauses for a human
 * before any commit/PR.
 *
 * Replace-this: the phases, gates, and agents are the point of this file.
 */
export default defineBlueprint({
  name: "plan_build_test",
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
      gates: [envelopeShape(BuildEnvelope), matchesPlan(), testsPass(), lintClean()],
      budget: 3,
      on_fail: { to: "plan" },
    },
    {
      name: "review",
      agent: reviewer,
      envelope: ReviewEnvelope,
      gates: [envelopeShape(ReviewEnvelope), reviewApproved()],
      budget: 3,
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
