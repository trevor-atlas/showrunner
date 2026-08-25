import { defineBlueprint } from "../../core/index.ts";
import { buildPhase } from "./patterns.ts";

/**
 * build — the plan already exists: one builder phase that
 * implements it. No tests/lint here by design — that is build_test's job;
 * this is the "just build it" path. No matchesPlan gate and no on_fail: this
 * flow stands alone (withPlan: false, onFail: null).
 *
 * Replace-this: the shared build phase lives in patterns.ts; edit it (or inline
 * a phase here) to change the agent, envelope, or gates.
 */
export default defineBlueprint({
  name: "build",
  phases: [buildPhase({ withPlan: false, onFail: null })],
});
