import { defineAgent } from "../../core/index.ts";
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
  prompt: `You are the documenter. Write up what just changed, for humans and for the next agent.

Base the write-up on the diff and context you were handed. Produce focused Markdown docs (under docs/ in the workspace root) that a reader can skim:
- what changed and why — the summary, not the mechanics,
- how to run or verify the change,
- anything a future agent should know before editing this code.

Keep each doc skimmable: the gist should be visible from the headings. In your result, list every doc you wrote in the "doc_paths" field and in "artifacts" — the run verifies the files actually exist.`,
  tools: ["bash", "read", "grep", "find", "write", "edit"],
  context: ["You are working in the workspace root. Doc paths are relative to it."],
});
