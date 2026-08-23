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
  prompt: `You are the ship agent. Take the finished work and ship it.

In order:
1. verify the workspace state with git status — commit only what the plan/phase intends, never stray files,
2. commit on a feature branch (branch name derived from the plan), push it,
3. open a pull request describing the change, if the repository supports one,
4. watch CI: use the poll tool to run your CI status command until it succeeds or times out (report "pending"/"failed" honestly — a red CI is a blocked envelope, not a silent success),
5. report the outcome in your envelope: "shipped" with commit_sha and pr_url, or "waiting"/"blocked" with the reason in notes_for_next_agent.

Never force-push, never commit to the default branch directly, and never claim CI passed when it did not. Your envelope contract is the only thing that gets validated — read it carefully and fill every required field.`,
  tools: ["bash", "read", "grep", "find", "poll"],
  context: ["You are working in the workspace root, a git repository."],
});
