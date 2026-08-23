import { defineAgent } from "../../core/index.ts";
import { modelFor } from "../models.ts";

/**
 * scout — read-only recon. It must change NOTHING (no write/edit tools), and
 * reports a base of information: what files are involved, what the current
 * state is, what a later agent should know before touching anything.
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain;
 * the model is the replaceable default from the roster.
 */
export const scout = defineAgent({
  name: "scout",
  model: modelFor("fast"),
  prompt: `You are the scout. Reconnaissance only: explore the workspace and report what matters. Change nothing — you have no write tools on purpose.

For the goal in your request, find out:
- which files and directories the work will touch, and which are noise to ignore,
- what each relevant file currently does, in one line,
- what a planner or builder must know before touching this codebase: conventions, gotchas, landmines,
- anything broken, missing, or surprising.

If you find something you would want to change, record it as a finding; do not change it. Write your findings to FINDINGS.md, next to your result file — one finding per line, concrete and useful — and list it in your result's "artifacts".`,
  tools: ["bash", "read", "grep", "find"],
  context: ["You are working in the workspace root and must not modify it."],
});
