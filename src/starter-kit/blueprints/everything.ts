import { defineBlueprint } from "../../core/index.ts";
import { buildPhase, planPhase, reviewPhase, shipPhase } from "./patterns.ts";

/**
 * everything — the work is real and its shape is not obvious:
 * plan, build, test, review, ship. Like plan_build_test but heavier: the plan
 * itself requires a human approval before anything is built (require_approval
 * on the plan phase), and every phase but ship carries a larger correction
 * budget.
 *
 * Replace-this: the shared phases live in patterns.ts; compose a different play
 * by editing the phase list or the helpers.
 */
export default defineBlueprint({
  name: "everything",
  phases: [
    planPhase({ budget: 4, requireApproval: true }),
    buildPhase({ withTests: true, budget: 4 }),
    reviewPhase({ budget: 4 }),
    shipPhase(),
  ],
});
