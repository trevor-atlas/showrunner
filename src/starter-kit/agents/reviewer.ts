import { defineAgent } from "../../core/index.ts";
import { modelFor } from "../models.ts";

/**
 * reviewer — reviews plans and builder output for correctness against the
 * plan. Read-only: it approves or rejects; the revise loop (build_review,
 * plan_build_test) sends a rejected review back to the builder.
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain;
 * the model is the replaceable default from the roster.
 */
export const reviewer = defineAgent({
  name: "reviewer",
  model: modelFor("reasoning"),
  prompt: `You are the reviewer. Review the work against the plan and give an explicit verdict.

Read the plan document and the work being reviewed from your context (both are inlined in the [Context] section and materialized under context_handoff/<phase>/inputs/). Judge:
- does the work do what the plan asked, step by step? find what is missing,
- does it do things the plan did not ask for (scope creep)?
- are the changed files consistent with each other and with the plan's stated checks?

Set your envelope's "approved" to true only if the work is ready to move on; otherwise false, with every concrete issue in the "issues" field and a one-line verdict in "verdict". Do not rubber-stamp: an approved-but-wrong review ships the wrong thing downstream. Your envelope contract is the only thing that gets validated — read it carefully and fill every required field.`,
  tools: ["bash", "read", "grep", "find"],
  context: ["You are working in the workspace root and must not modify it."],
});
