import { z } from "zod";
import { EnvelopeBase } from "../core/index.ts";

/**
 * The six agents' output contracts (ADR-0002): each extends EnvelopeBase with
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
  plan_path: z.string(),
  /** what the plan covers — a one-line scope statement */
  scope: z.string().optional(),
  /** questions the planner could not answer; they pause the run for a human */
  questions: z.array(z.string()).optional(),
  /** explicit assumptions the plan bakes in */
  assumptions: z.array(z.string()).optional(),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelope>;

/** builder — what changed, for the reviewer and the human. */
export const BuildEnvelope = EnvelopeBase.extend({
  /** paths (relative to the workspace root) that this build created/edited */
  changed: z.array(z.string()),
});
export type BuildEnvelope = z.infer<typeof BuildEnvelope>;

/** scout — read-only recon; nothing changes, findings are the payload. */
export const ScoutEnvelope = EnvelopeBase.extend({
  /** one finding per entry: what the file/dir is and why it matters */
  findings: z.array(z.string()),
  /** paths inspected, for the next agent's reference */
  touched: z.array(z.string()).optional(),
});
export type ScoutEnvelope = z.infer<typeof ScoutEnvelope>;

/** reviewer — an explicit verdict against the plan. */
export const ReviewEnvelope = EnvelopeBase.extend({
  /** the verdict gates on: approved must be true for the phase to pass */
  approved: z.boolean(),
  /** one-line verdict, shown to humans */
  verdict: z.string(),
  /** concrete issues; non-empty when not approved */
  issues: z.array(z.string()).optional(),
});
export type ReviewEnvelope = z.infer<typeof ReviewEnvelope>;

/** documenter — what docs were written. */
export const DocumentEnvelope = EnvelopeBase.extend({
  /** doc paths (relative to the workspace root) that were written/updated */
  doc_paths: z.array(z.string()),
  /** who the docs are for — humans, agents, or both */
  audience: z.enum(["humans", "agents", "both"]).optional(),
});
export type DocumentEnvelope = z.infer<typeof DocumentEnvelope>;

/** ship — the shipment outcome; `blocked` carries the reason (CI red, etc.). */
export const ShipEnvelope = EnvelopeBase.extend({
  /** what happened with the shipment */
  outcome: z.enum(["shipped", "waiting", "blocked"]),
  /** the commit that was pushed, when there is one */
  commit_sha: z.string().optional(),
  /** the pull request URL, when one was opened */
  pr_url: z.string().optional(),
  /** CI state as last seen by the poll tool */
  ci_status: z.enum(["pending", "passed", "failed", "unknown"]).optional(),
});
export type ShipEnvelope = z.infer<typeof ShipEnvelope>;
