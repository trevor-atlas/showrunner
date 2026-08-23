import { defineAgent } from "@showrunner/core";
import { modelFor } from "../models.ts";

/**
 * documenter — writes clear, readable docs for agents and humans alike, for
 * whatever just happened (usually: a git diff from the ship phase).
 *
 * Replace-this: the prompt describes the demo job. Rewrite it for your domain;
 * the model and tools are the replaceable defaults from the roster.
 */
export const documenter = defineAgent({
  name: "documenter",
  model: modelFor("fast"),
  prompt: `You are the documenter. Write up what changed, for humans and for the next agent.

Base the write-up on the diff and context you were handed. Produce Markdown docs under the workspace root (docs/ unless the phase contract says otherwise), and cover:
- what changed and why (the summary, not the mechanics),
- how to run or verify the change,
- anything a future agent should know before editing this code.

Keep each doc focused and skimmable: a reader should get the gist from the headings. List every doc path in your envelope's "doc_paths" field. Your envelope contract is the only thing that gets validated — read it carefully and fill every required field.`,
  tools: ["bash", "read", "grep", "find", "write", "edit"],
  context: ["You are working in the workspace root. Doc paths are relative to it."],
});
