import { z } from "zod";
import { EnvelopeBase } from "../core/index.ts";

/**
 * The six agents' output contracts: each extends EnvelopeBase with
 * the fields its phase's gates care about. Outcome is decided by parse + gates,
 * never by the agent's claim — these schemas are what a phase's envelope
 * parse enforces and what `envelopeShape` can double-check.
 *
 * Replace-this: the starter envelopes describe a demo app. Edit the fields to
 * match your domain and the gates (and the agent prompts) follow.
 */

/** planner — a concrete plan document, with open questions surfaced. */
export const PlanEnvelope = EnvelopeBase.extend({
  /** path to the plan document (relative to the workspace root) */
  plan_path: z.string().describe("path to the plan document you wrote, relative to the workspace root"),
  /** what the plan covers — a one-line scope statement */
  scope: z.string().optional().describe("what the plan covers — a one-line scope statement"),
  /** questions the planner could not answer; they pause the run for a human */
  questions: z.array(z.string()).optional().describe("questions you could not answer; they pause the run for a human"),
  /** explicit assumptions the plan bakes in */
  assumptions: z.array(z.string()).optional().describe("explicit assumptions the plan bakes in"),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelope>;

/** builder — what changed, for the reviewer and the human. */
export const BuildEnvelope = EnvelopeBase.extend({
  /** paths (relative to the workspace root) that this build created/edited */
  changed: z.array(z.string()).describe("paths (relative to the workspace root) that this build created or edited — the reviewer and the human read this"),
});
export type BuildEnvelope = z.infer<typeof BuildEnvelope>;

/**
 * scout — read-only recon; nothing in the workspace changes. The findings are
 * the payload: the scout writes them to its outputs/ dir (FINDINGS.md, listed
 * in `artifacts`) — the `findingsReported` gate insists the file exists and is
 * non-empty, so "a scout that reported nothing cannot pass" is actually true.
 */
export const ScoutEnvelope = EnvelopeBase.extend({});
export type ScoutEnvelope = z.infer<typeof ScoutEnvelope>;

/** reviewer — an explicit verdict against the plan. */
export const ReviewEnvelope = EnvelopeBase.extend({
  /** the verdict gates on: approved must be true for the phase to pass */
  approved: z.boolean().describe("the verdict — must be true for the phase to pass"),
  /** one-line verdict, shown to humans */
  verdict: z.string().describe("one-line verdict, shown to humans"),
  /** concrete issues; non-empty when not approved */
  issues: z.array(z.string()).optional().describe("concrete issues — non-empty when not approved"),
});
export type ReviewEnvelope = z.infer<typeof ReviewEnvelope>;

/** documenter — what docs were written. */
export const DocumentEnvelope = EnvelopeBase.extend({
  /** doc paths (relative to the workspace root) that were written/updated */
  doc_paths: z.array(z.string()).describe("doc paths (relative to the workspace root) that you wrote or updated"),
  /** who the docs are for — humans, agents, or both */
  audience: z.enum(["humans", "agents", "both"]).optional().describe("who the docs are for — humans, agents, or both"),
});
export type DocumentEnvelope = z.infer<typeof DocumentEnvelope>;

/** ship — the shipment outcome; `blocked` carries the reason (CI red, etc.). */
export const ShipEnvelope = EnvelopeBase.extend({
  /** what happened with the shipment */
  outcome: z.enum(["shipped", "waiting", "blocked"]).describe("what happened with the shipment"),
  /** the commit that was pushed, when there is one */
  commit_sha: z.string().optional().describe("the commit that was pushed, when there is one"),
  /** the pull request URL, when one was opened */
  pr_url: z.string().optional().describe("the pull request URL, when one was opened"),
  /** CI state as last seen by the poll tool */
  ci_status: z.enum(["pending", "passed", "failed", "unknown"]).optional().describe("CI state as last seen by the poll tool"),
});
export type ShipEnvelope = z.infer<typeof ShipEnvelope>;
