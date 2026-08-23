import { defineBlueprint } from "../../core/index.ts";
import { builder } from "../agents/builder.ts";
import { reviewer } from "../agents/reviewer.ts";
import { BuildEnvelope, ReviewEnvelope } from "../envelopes.ts";
import { envelopeShape, reviewApproved } from "../gates/index.ts";

/**
 * build_review — "is this what was asked for" matters more than "does it run"
 * (PLAN §14): builder, reviewer, bounded revise loop. The reviewer must
 * approve (reviewApproved gate); a rejected review routes back to the builder,
 * and the builder's failures route forward to the reviewer — the loop always
 * terminates or pauses via the visit guard (spec §5.2 step 3).
 *
 * Replace-this: the phases, gates, and agents are the point of this file.
 */
export default defineBlueprint({
  name: "build_review",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      gates: [envelopeShape(BuildEnvelope)],
      budget: 3,
      on_fail: { to: "review" }, // give up building, let the reviewer weigh in
    },
    {
      name: "review",
      agent: reviewer,
      envelope: ReviewEnvelope,
      gates: [envelopeShape(ReviewEnvelope), reviewApproved()],
      budget: 3,
      on_fail: { to: "build" }, // rejected review → revise
    },
  ],
});
