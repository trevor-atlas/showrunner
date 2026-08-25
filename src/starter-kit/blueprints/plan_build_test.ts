import { defineBlueprint } from "../../core/index.ts";
import { buildPhase, planPhase, reviewPhase, shipPhase } from "./patterns.ts";

/**
 * plan_build_test — the standard chain: plan, build, gate
 * (test, lint), review, ship. The build must pass tests + typecheck AND
 * reference the plan; the review must approve; a rejected review routes back
 * to the builder (bounded revise loop); and the ship phase pauses for a human
 * before any commit/PR.
 *
 * Replace-this: the shared phases live in patterns.ts; compose a different play
 * by editing the phase list or the helpers.
 */
export default defineBlueprint({
  name: "plan_build_test",
  phases: [planPhase(), buildPhase({ withTests: true }), reviewPhase(), shipPhase()],
});
