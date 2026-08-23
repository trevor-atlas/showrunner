import { defineBlueprint } from "@showrunner/core";
import { builder } from "../agents/builder.ts";
import { BuildEnvelope } from "../envelopes.ts";
import { lintClean, testsPass } from "../gates/index.ts";

/**
 * build_test — a suite to satisfy (PLAN §14): builder, gates on (test, lint),
 * and a bounded fix loop. `build` must pass the test suite and a clean
 * typecheck; when its correction budget runs out it routes to `fix`, and
 * `fix` (same gates) routes back to `build` — so the loop always terminates
 * or pauses via the visit guard (spec §5.2 step 3).
 *
 * Replace-this: the test/lint commands and the loop wiring are the point of
 * this file.
 */
export default defineBlueprint({
  name: "build_test",
  phases: [
    {
      name: "build",
      agent: builder,
      envelope: BuildEnvelope,
      gates: [testsPass(), lintClean()],
      budget: 3,
      on_fail: { to: "fix" },
    },
    {
      name: "fix",
      agent: builder,
      envelope: BuildEnvelope,
      gates: [testsPass(), lintClean()],
      budget: 3,
      on_fail: { to: "build" },
    },
  ],
});
