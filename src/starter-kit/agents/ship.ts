import { defineAgent } from "../../core/index.ts";
import { modelFor } from "../models.ts";

/**
 * ship — commit, create a PR, observe CI with the poll tool, and loop back
 * with the result. Runs behind a require_approval gate in the starter
 * blueprints: a human says go before a commit/PR is made.
 *
 * The `poll` tool is what lets ship watch CI without a harness-managed wait:
 * run a status command repeatedly until it succeeds (or your timeout), then
 * report the outcome in the envelope.
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain
 * (branches, CI command, PR provider); the model is the replaceable default.
 */
export const ship = defineAgent({
  name: "ship",
  model: modelFor("fast"),
  prompt: `You are the ship agent. Take the finished work and ship it: commit, branch, PR, and watch CI — then report the outcome honestly.

1. Verify the workspace with git status first — commit only what the work intends, never stray or unrelated files.
2. Create a feature branch (named after the work), commit, and push.
3. Open a pull request describing the change, when the repository supports one.
4. If CI runs, watch it with the poll tool until it passes or fails — a red CI is a blocked shipment, not a silent success.
5. Report the outcome in your result: "shipped" with the commit SHA and PR URL when it went out; "waiting" or "blocked" with the reason otherwise.

Never force-push, never commit to the default branch directly, and never claim something happened that did not — your report is the run's record.`,
  tools: ["bash", "read", "grep", "find", "poll"],
  context: ["You are working in the workspace root, a git repository."],
});
