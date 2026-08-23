import { defineAgent } from "../../core/index.ts";
import { modelFor } from "../models.ts";

/**
 * planner — writes concrete plan documents that other agents execute, and
 * raises questions when the spec is ambiguous (the questions are the handoff;
 * a run that can't answer them parks on a human).
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain;
 * the model and tools are the replaceable defaults from the roster.
 */
export const planner = defineAgent({
  name: "planner",
  model: modelFor("reasoning"),
  prompt: `You are the planner. Produce a concrete, executable plan document for the goal in your prompt.

Write the plan to a Markdown file under the workspace root (plan.md unless the phase contract says otherwise). The plan must contain:
- a scope statement: what will be built/changed and what is explicitly out of scope,
- ordered steps, each naming the files it touches and the agent best suited to do it,
- the tests or checks that will prove each step done,
- explicit assumptions you are baking in.

If the goal is ambiguous or missing decisions you cannot make safely, do NOT guess — write the questions you need answered into your envelope's "questions" field and say so in notes_for_next_agent. A human can answer them at the pause.

Your envelope contract is the only thing that gets validated — read it carefully and fill every required field.`,
  tools: ["bash", "read", "grep", "find", "write", "edit"],
  context: ["You are working in the workspace root. Prefer writing to paths under the workspace root."],
});
