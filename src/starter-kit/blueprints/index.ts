// The ten starter blueprints (PLAN §14's table). Skill name → blueprint:
//   prompt           → prompt           (default: planner; edit to pick the agent)
//   scout            → scout
//   plan             → plan
//   build            → build
//   plan-build       → plan_build
//   build-test       → build_test
//   build-review     → build_review
//   plan-build-test  → plan_build_test
//   document         → document
//   everything       → everything
export { default as prompt } from "./prompt.ts";
export { default as scout } from "./scout.ts";
export { default as plan } from "./plan.ts";
export { default as build } from "./build.ts";
export { default as plan_build } from "./plan_build.ts";
export { default as build_test } from "./build_test.ts";
export { default as build_review } from "./build_review.ts";
export { default as plan_build_test } from "./plan_build_test.ts";
export { default as document } from "./document.ts";
export { default as everything } from "./everything.ts";

import build_test from "./build_test.ts";
import build_review from "./build_review.ts";
import build from "./build.ts";
import document from "./document.ts";
import everything from "./everything.ts";
import plan_build_test from "./plan_build_test.ts";
import plan_build from "./plan_build.ts";
import plan from "./plan.ts";
import prompt from "./prompt.ts";
import scout from "./scout.ts";
import type { Blueprint } from "../../core/index.ts";

/** Blueprint name → blueprint, for name-based lookup (the CLI takes a path;
 * this index is how names resolve to modules). */
export const BLUEPRINTS: Record<string, Blueprint> = {
  prompt,
  scout,
  plan,
  build,
  plan_build,
  build_test,
  build_review,
  plan_build_test,
  document,
  everything,
};
