import { defineBlueprint } from "../../core/index.ts";
import { planPhase } from "./patterns.ts";

/**
 * plan — the spec before any code: one planner phase that produces
 * a plan document. The envelope must satisfy PlanEnvelope — a plan_path is
 * required, so a planner that wrote no plan cannot pass.
 *
 * Replace-this: the shared plan phase lives in patterns.ts; edit it (or inline
 * a phase here) to change the agent, envelope, or gates.
 */
export default defineBlueprint({
  name: "plan",
  phases: [planPhase()],
});
