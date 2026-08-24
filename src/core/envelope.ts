import { z } from "zod";

/**
 * The envelope base.
 *
 * There is no `status` field: outcome is determined by parse + gates, never by
 * the agent's claim. `blocked` is the one agent-asserted signal: it
 * short-circuits to the human pause *before* gates and is never routed through
 * `on_fail`.
 */
export const EnvelopeBase = z.object({
  /** what this agent did, for humans */
  summary: z.string().describe("what you did, for humans — 1-3 sentences"),
  /** files the agent WROTE to its outputs/ dir (the run's per-phase workspace,
   * {data_dir}/runs/<run_id>/<phase>/outputs), one path per entry, relative to
   * that directory. These are forwarded to the next phase's inputs/
   * automatically. Never list files you merely read. */
  artifacts: z.array(z.string()).describe("the files you WROTE to your outputs/ directory (the [Workspace] outputs path your prompt names), one path per entry, relative to that directory — never files you merely read; each listed file must actually exist there"),
  /** the handoff in prose */
  notes_for_next_agent: z.string().describe("the handoff in prose — what the next agent must know to continue"),
  /** agent asserts it cannot proceed */
  blocked: z.boolean().optional().describe("true when you cannot proceed and need a human — pauses the run before gates"),
  /** shown on the pause screen */
  blocked_reason: z.string().optional().describe("why you are blocked — required when blocked is true"),
});

export type Envelope = z.infer<typeof EnvelopeBase>;

/** The envelope a phase declares, extended from EnvelopeBase. */
export type PhaseEnvelope<S extends z.ZodTypeAny> = z.infer<S>;
