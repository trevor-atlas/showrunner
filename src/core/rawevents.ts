import { z } from "zod";

/**
 * Raw pi event shapes (Appendix A, verified against pi 0.84.2).
 *
 * These describe the JSONL lines pi writes to stdout in `--mode rpc`. The
 * tracer uses them to *identify* and extract raw events; unrecognized or
 * malformed lines are recorded to raw_output.jsonl verbatim and skipped for
 * folding.
 *
 * Content blocks: `{type:"text",text}` blocks appear in `partialResult.content`
 * / `result.content`; the tracer joins the `text` fields for snippets.
 */

export const TextBlock = z.object({
  type: z.string(),
  text: z.string().optional(),
});

export const ContentBlocks = z.array(TextBlock);

/** A message body carried on message_* / turn_* lines: role + text content
 * blocks (both optional — machinery lines omit them). */
export const RawMessage = z.object({
  id: z.string().optional(),
  role: z.string().optional(),
  content: ContentBlocks.optional(),
});

export const RawAgentStart = z.object({
  type: z.literal("agent_start"),
  /** the pi session id — the key that maps a block to an agent_sessions row
   * (phase + visit); segments the per-run jsonl into per-phase blocks. */
  sessionId: z.string().optional(),
  model: z.string().optional(),
});

/** agent_end with willRetry=true means a low-level run will retry (not done yet). */
export const RawAgentEnd = z.object({
  type: z.literal("agent_end"),
  willRetry: z.boolean().optional(),
});

/** The authoritative "done" signal - fires when no retry/compaction/continuation remains. */
export const RawAgentSettled = z.object({
  type: z.literal("agent_settled"),
});

export const RawTurnStart = z.object({ type: z.literal("turn_start") });
export const RawTurnEnd = z.object({ type: z.literal("turn_end") });
export const RawMessageStart = z.object({ type: z.literal("message_start"), message: RawMessage.optional() });
export const RawMessageUpdate = z.object({ type: z.literal("message_update"), message: RawMessage.optional() });
export const RawMessageEnd = z.object({ type: z.literal("message_end"), message: RawMessage.optional() });

/** tool_execution_start — open a call keyed by toolCallId. */
export const RawToolExecutionStart = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  args: z.unknown(),
});

/** tool_execution_update — partialResult is the *accumulated* output (REPLACES, not appends). */
export const RawToolExecutionUpdate = z.object({
  type: z.literal("tool_execution_update"),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  args: z.unknown().optional(),
  partialResult: z.object({ content: ContentBlocks }),
});

/** tool_execution_end — close: ok = !isError, snippet from result.content. */
export const RawToolExecutionEnd = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  result: z.object({ content: ContentBlocks }),
  isError: z.boolean(),
});

/**
 * Machinery events: recorded raw, never folded into harness event
 * types. The list is open - the tracer treats any other `type` the same way.
 */
export const MACHINERY_EVENT_TYPES = [
  "compaction_start",
  "compaction_end",
  "compaction_clear",
  "auto_retry",
  "summarization_retry",
  "queue_update",
  "bash_execution_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "extension_error",
  "response",
] as const;
