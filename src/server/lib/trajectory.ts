/**
 * The trajectory parser (issue #83) — a pure function that turns a run's raw
 * raw_output.jsonl text into a per-phase {@link TrajectoryView}. NO db / fs /
 * DOM: the caller (services/runs.ts → apiTrajectory) reads the file, the
 * agent_sessions rows, and the tool_call timings and hands them in.
 *
 * The raw jsonl is per-RUN and phases run sequentially, so the file is
 * segmented on `agent_start` (whose `sessionId` maps to an agent_sessions row →
 * phase + visit). Only the target phase's blocks are kept — all visits, since
 * an on_fail re-drive produces several sessions for one phase.
 *
 * Lane mapping (issue #83): `message_end role:"user"` → input, `message_end
 * role:"assistant"` → model, `tool_execution_start` + `tool_execution_end` →
 * tools. Messages fold on `message_end` (canonical over `message_start` /
 * `message_update`). Rows carry a monotonic `seq` across the whole phase and a
 * `turn` (from `turn_start`) / `step` (within the turn) index.
 */

import {
  ContentBlocks,
  RawAgentStart,
  RawMessageEnd,
  RawToolExecutionEnd,
  RawToolExecutionStart,
} from "../../core/rawevents.ts";
import type { TrajectoryEntry, TrajectoryView } from "../contract.ts";

/** The per-phase session rows the parser filters blocks by (a subset of
 * AgentSessionRow plus the phase name, so the view carries identity without
 * the parser importing db row types). */
export interface TrajectorySession {
  run_id: string;
  phase: string;
  phase_id: string;
  pi_session_id: string;
  visit: number;
}

/** A DB tool_call event's timing, keyed by tool_call_id. */
export interface ToolTiming {
  ts: string;
  duration_ms: number;
}

/** Join a content-block array's `text` fields; "" when the shape does not match. */
function joinText(content: unknown): string {
  const parsed = ContentBlocks.safeParse(content);
  if (!parsed.success) return "";
  return parsed.data.map((b) => b.text ?? "").join("");
}

export function buildTrajectory(
  rawText: string,
  sessionsForPhase: readonly TrajectorySession[],
  toolTimings: Readonly<Record<string, ToolTiming>> = {},
): TrajectoryView {
  const allowed = new Set(sessionsForPhase.map((s) => s.pi_session_id));
  const first = sessionsForPhase[0];
  const entries: TrajectoryEntry[] = [];

  // block state: `active` is true while the current agent_start block belongs
  // to the target phase; seq/turn/step run across the phase's kept blocks.
  let active = false;
  let seq = 0;
  let turn = 0;
  let step = 0;
  const pendingTools = new Map<string, { tool: string; args: unknown }>();

  for (const line of rawText.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const type = (obj as { type?: unknown }).type;

    if (type === "agent_start") {
      const r = RawAgentStart.safeParse(obj);
      const sid = r.success ? r.data.sessionId : undefined;
      active = sid !== undefined && allowed.has(sid);
      pendingTools.clear();
      continue;
    }
    if (!active) continue;

    if (type === "turn_start") {
      turn += 1;
      step = 0;
      continue;
    }

    if (type === "message_end") {
      const r = RawMessageEnd.safeParse(obj);
      if (!r.success) continue;
      const role = r.data.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      entries.push({
        seq: seq++,
        lane: role === "user" ? "input" : "model",
        turn,
        step: step++,
        role,
        text: joinText(r.data.message?.content),
      });
      continue;
    }

    if (type === "tool_execution_start") {
      const r = RawToolExecutionStart.safeParse(obj);
      if (!r.success || r.data.toolCallId === undefined) continue;
      pendingTools.set(r.data.toolCallId, { tool: r.data.toolName, args: r.data.args });
      continue;
    }

    if (type === "tool_execution_end") {
      const r = RawToolExecutionEnd.safeParse(obj);
      if (!r.success) continue;
      const id = r.data.toolCallId;
      const pending = id !== undefined ? pendingTools.get(id) : undefined;
      if (id !== undefined) pendingTools.delete(id);
      const timing = id !== undefined ? toolTimings[id] : undefined;
      entries.push({
        seq: seq++,
        lane: "tools",
        turn,
        step: step++,
        tool: r.data.toolName,
        tool_call_id: id ?? null,
        args: pending?.args ?? null,
        result: joinText(r.data.result.content),
        ok: !r.data.isError,
        ts: timing?.ts ?? null,
        duration_ms: timing?.duration_ms ?? null,
      });
      continue;
    }
  }

  return {
    run_id: first?.run_id ?? "",
    phase: first?.phase ?? "",
    phase_id: first?.phase_id ?? "",
    entries,
    truncated: false,
  };
}
