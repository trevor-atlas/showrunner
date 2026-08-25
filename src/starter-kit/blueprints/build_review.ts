import { defineBlueprint } from "../../core/index.ts";
import { buildPhase, reviewPhase } from "./patterns.ts";

/**
 * build_review — "is this what was asked for" matters more than "does it run"
 *: builder, reviewer, bounded revise loop. The reviewer must
 * approve (reviewApproved gate); a rejected review routes back to the builder,
 * and the builder's failures route forward to the reviewer — the loop always
 * terminates or pauses via the visit guard. The build here stands alone
 * (withPlan: false) and gives up forward to the reviewer (onFail → review).
 *
 * Replace-this: the shared phases live in patterns.ts; compose a different play
 * by editing the phase list or the helpers.
 */
export default defineBlueprint({
  name: "build_review",
  phases: [buildPhase({ withPlan: false, onFail: { to: "review" } }), reviewPhase()],
});
