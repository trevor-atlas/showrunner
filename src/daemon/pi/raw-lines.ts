import { MACHINERY_EVENT_TYPES } from "../../core/index.ts";

/**
 * The raw pi JSONL line classifier — the single place the stream's
 * `type` vocabulary is recognized. Type-string classification ONLY (no
 * zod-payload validation): payload validation stays in the tracer handlers,
 * so the classifier's acceptance can't drift from the tracer's. Every
 * consumer (tracer, pi-session, fake-session-driver, runner) derives its
 * recognition from this module, so the two settle latches keep their
 * semantics by construction.
 */

// The literal "agent_settled" appears exactly once in this file: here. The
// table and isSettledLine reference this constant, never the string.
export const SETTLED_KIND = "agent_settled" as const;

export type RawLineKind =
  | "agent_start"
  | "agent_end"
  | typeof SETTLED_KIND
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "response"
  | "machinery"
  | "unknown";

export interface ClassifiedLine {
  kind: RawLineKind;
  /** the parsed event object (present whenever the line was a JSON object) */
  evt?: Record<string, unknown>;
}

// The vocabulary table — kinds whose type string IS the kind name.
const RAW_KIND_TYPES = [
  "agent_start",
  "agent_end",
  SETTLED_KIND,
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "response",
] as const;

const RAW_KIND_SET: ReadonlySet<string> = new Set(RAW_KIND_TYPES);
const MACHINERY_KIND_SET: ReadonlySet<string> = new Set(MACHINERY_EVENT_TYPES);

/**
 * Classify one raw JSONL line. Never throws: non-JSON lines, non-object
 * values, and unrecognized types classify as "unknown".
 */
export function classifyLine(line: string): ClassifiedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "unknown" }; // non-JSON line: recorded verbatim, skipped
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "unknown" };
  const evt = parsed as Record<string, unknown>;
  const type = typeof evt.type === "string" ? evt.type : "";
  if (RAW_KIND_SET.has(type)) return { kind: type as RawLineKind, evt };
  if (MACHINERY_KIND_SET.has(type)) return { kind: "machinery", evt };
  return { kind: "unknown", evt };
}

/** Whether the line is an agent_settled event (agent_end is not done). */
export function isSettledLine(line: string): boolean {
  return classifyLine(line).kind === SETTLED_KIND;
}
