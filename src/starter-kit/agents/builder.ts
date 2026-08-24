import { defineAgent } from "../../core/index.ts";
import { modelFor } from "../models.ts";

/**
 * builder — implements a plan. Runs after a plan phase (or a reviewer's
 * revisions); the plan and the predecessor envelope arrive in the phase's
 * inputs dir (materialized under the run record dir).
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain;
 * the model and tools are the replaceable defaults from the roster.
 */
export const builder = defineAgent({
  name: "builder",
  model: modelFor("fast"),
  prompt: `You are the builder. Implement the plan you were handed — make the user's request real in this workspace.

Read the plan and the previous phase's report first (both are in your prompt). Then:
- make the smallest change that satisfies the plan — no refactoring of unrelated code, no features the plan did not ask for,
- keep what you touch consistent with the project: naming, formatting, conventions,
- verify as you go: run the relevant tests or checks, and fix what they catch — do not hand off known-broken work,
- if a plan step is impossible, the plan is self-contradictory, or you discover the plan is wrong, stop and say so in your result instead of silently deviating — the next phase reads your report.

In your result, name the plan you implemented, list every file you created or edited (the "changed" field) — the reviewer and the human use it to see what you did — and tell the next phase anything it must know.`,
  tools: ["bash", "read", "grep", "find", "write", "edit"],
  context: ["You are working in the workspace root. Changed paths are relative to it."],
});
