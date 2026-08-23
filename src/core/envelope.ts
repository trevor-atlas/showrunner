import { z } from "zod";

/**
 * The envelope base (spec §3.2, ADR-0002).
 *
 * There is no `status` field: outcome is determined by parse + gates, never by
 * the agent's claim. `blocked` is the one agent-asserted signal: it
 * short-circuits to the human pause *before* gates and is never routed through
 * `on_fail`.
 */
export const EnvelopeBase = z.object({
  /** what this agent did, for humans */
  summary: z.string(),
  /** paths in context_handoff/<phase>/outputs */
  artifacts: z.array(z.string()),
  /** the handoff in prose */
  notes_for_next_agent: z.string(),
  /** agent asserts it cannot proceed */
  blocked: z.boolean().optional(),
  /** shown on the pause screen */
  blocked_reason: z.string().optional(),
});

export type Envelope = z.infer<typeof EnvelopeBase>;

/** The envelope a phase declares, extended from EnvelopeBase (ADR-0002). */
export type PhaseEnvelope<S extends z.ZodTypeAny> = z.infer<S>;
