import { defineBlueprint } from "../../core/index.ts";
import { buildPhase, planPhase, shipPhase } from "./patterns.ts";

/**
 * plan_build — small, well-understood work: plan, build against
 * the plan, then ship. The build phase's matchesPlan gate refuses an envelope
 * that does not reference the plan document, and the ship phase pauses for a
 * human before any commit/PR is made (require_approval).
 *
 * Replace-this: the shared phases live in patterns.ts; compose a different play
 * by editing the phase list or the helpers.
 */
export default defineBlueprint({
  name: "plan_build",
  phases: [planPhase(), buildPhase(), shipPhase()],
});
