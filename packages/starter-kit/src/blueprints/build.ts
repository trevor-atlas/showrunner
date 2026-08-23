import { defineBlueprint } from "@showrunner/core";
import { builder } from "../agents/builder.ts";
import { BuildEnvelope } from "../envelopes.ts";
import { envelopeShape } from "../gates/index.ts";

/**
 * build — the plan already exists (PLAN §14): one builder phase that
 * implements it. No tests/lint here by design — that is build_test's job;
 * this is the "just build it" path.
 *
 * Replace-this: the agent, envelope, and gates are the point of this file.
 */
export default defineBlueprint({
  name: "build",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      gates: [envelopeShape(BuildEnvelope)],
      budget: 3,
    },
  ],
});
