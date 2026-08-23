import { z } from "zod";

/**
 * The event taxonomy (spec §6): exactly twelve event types, each with its data
 * shape. These schemas are the single source of truth - the daemon validates
 * every event's data against them before inserting (no hand-rolled
 * validation).
 */

export const EVENT_TYPES = [
  "run_submitted",
  "run_status",
  "phase_start",
  "phase_end",
  "agent_start",
  "agent_end",
  "tool_call",
  "envelope",
  "gate_result",
  "correction",
  "human_action",
  "spend",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 1 — run accepted by daemon */
export const RunSubmittedData = z.object({
  blueprint: z.string(),
  cwd: z.string(),
});

/** 2 — run-level status change */
export const RunStatusData = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
});

/** 3 — phase begins (after approval, before spawn) */
export const PhaseStartData = z.object({
  phase: z.string(),
  agent: z.string(),
  visit: z.number().int().nonnegative(),
  budget: z.number().int().nonnegative(),
});

/** 4 — phase terminal */
export const PhaseEndData = z.object({
  phase: z.string(),
  status: z.string(),
  visits: z.number().int(),
  corrections: z.number().int(),
  spend_usd: z.number(),
});

/** 5 — pi subprocess spawned */
export const AgentStartData = z.object({
  agent: z.string(),
  pi_session_id: z.string(),
  pid: z.number().int(),
  model: z.string(),
});

/** 6 — the phase's agent fully settled (agent_settled) / the stream died */
export const AgentEndData = z.object({
  agent: z.string(),
  pi_session_id: z.string(),
  exit: z.number().int().nullable(),
  ok: z.boolean(),
});

/** 7 — one row per real tool call (folding, §7.2) */
export const ToolCallData = z.object({
  tool: z.string(),
  tool_call_id: z.string(),
  args: z.unknown(),
  result_snippet: z.string(),
  ok: z.boolean(),
  /** set on mid-tool-call death flush (§7.2) */
  truncated: z.boolean().optional(),
  duration_ms: z.number().nonnegative(),
  agent: z.string(),
});

/** 8 — envelope accepted (valid + gates passed or overridden) */
export const EnvelopeData = z.object({
  phase: z.string(),
  visit: z.number().int(),
  attempt: z.number().int(),
  valid: z.boolean(),
});

/** 9 — each gate run */
export const GateResultData = z.object({
  gate: z.string(),
  pass: z.boolean(),
  violations: z.array(z.string()),
});

/** 10 — a correction is issued */
export const CorrectionData = z.object({
  phase: z.string(),
  visit: z.number().int(),
  reason: z.string(),
  message: z.string(),
});

/** 11 — steer / approve / override / restart / fail */
export const HumanActionData = z.object({
  action: z.string(),
  by: z.string().optional(),
  detail: z.string(),
});

/** 12 — usage deltas folded from pi message/turn usage fields (§7.3) */
export const SpendData = z.object({
  phase: z.string(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  cache_write: z.number().int().nonnegative(),
  /** dollars from pi's reported cost when present; null otherwise (§11.1) */
  usd: z.number().nullable(),
  /** true when `usd` is an ESTIMATE from the local price roster (§11.1) — the
   * numbers are pi's, not ours: the roster only fills gaps, and the UI shows
   * estimated vs reported spend distinctly. False for reported or null usd. */
  estimated: z.boolean(),
});

/** Inferred data payload types, for consumers that carry them around. */
export type Spend = z.infer<typeof SpendData>;
export type ToolCall = z.infer<typeof ToolCallData>;
export type AgentEnd = z.infer<typeof AgentEndData>;
export type PhaseEnd = z.infer<typeof PhaseEndData>;
export type RunStatusEvent = z.infer<typeof RunStatusData>;
export type AgentStart = z.infer<typeof AgentStartData>;

/** Index of data schemas by event type. */
export const EVENT_DATA_SCHEMAS: Record<EventType, z.ZodTypeAny> = {
  run_submitted: RunSubmittedData,
  run_status: RunStatusData,
  phase_start: PhaseStartData,
  phase_end: PhaseEndData,
  agent_start: AgentStartData,
  agent_end: AgentEndData,
  tool_call: ToolCallData,
  envelope: EnvelopeData,
  gate_result: GateResultData,
  correction: CorrectionData,
  human_action: HumanActionData,
  spend: SpendData,
};

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

/** Validate event data against the canonical schema for its type. */
export function parseEventData(type: EventType, data: unknown): unknown {
  return EVENT_DATA_SCHEMAS[type].parse(data);
}

/** One events row as stored (§6). */
export interface EventRow {
  id: number;
  run_id: string;
  phase_id: string | null;
  agent_session_id: string | null;
  type: EventType;
  ts: string; // ISO-8601, daemon wall clock
  data: unknown;
}

/** JSON serialization used by the events table (`data` column). */
export function serializeEventData(data: unknown): string {
  return JSON.stringify(data);
}
