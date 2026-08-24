import type { EventRow } from "../core/index.ts";

/**
 * Renders a folded event row as a human-readable line (naming rule:
 * tool calls read aloud, e.g. "bash: ls -la src").
 */

const MAX_INLINE = 80;

function truncate(s: string, n = MAX_INLINE): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderArgs(args: unknown): string {
  if (typeof args === "string") return truncate(args);
  if (args === null || args === undefined) return "";
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return truncate(String(args));
  }
}

function usd(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}

export function formatEvent(e: EventRow): string {
  const d = e.data as Record<string, unknown>;
  const ts = e.ts.replace("T", " ").replace("Z", "");
  switch (e.type) {
    case "run_submitted":
      return `${ts} [run] submitted blueprint=${String(d.blueprint)} cwd=${String(d.cwd)}`;
    case "run_status": {
      const reason = d.reason ? ` (${String(d.reason)})` : "";
      return `${ts} [run] ${String(d.from)} → ${String(d.to)}${reason}`;
    }
    case "phase_start":
      return `${ts} [phase] start ${String(d.phase)} agent=${String(d.agent)} visit=${String(d.visit)} budget=${String(d.budget)}`;
    case "phase_end":
      return `${ts} [phase] end ${String(d.phase)} status=${String(d.status)} visits=${String(d.visits)} corrections=${String(d.corrections)} spend=${usd(d.spend_usd as number)}`;
    case "agent_start":
      return `${ts} [agent] start ${String(d.agent)} model=${String(d.model)} pid=${String(d.pid)} session=${String(d.pi_session_id)}`;
    case "agent_end":
      return `${ts} [agent] end ${String(d.agent)} ok=${String(d.ok)} exit=${d.exit === null ? "null" : String(d.exit)}`;
    case "tool_call": {
      const label = `${String(d.tool)}: ${renderArgs(d.args)}`;
      const flags = [];
      if (d.ok === false) flags.push("error");
      if (d.truncated) flags.push("truncated");
      flags.push(`${Number(d.duration_ms)}ms`);
      const snippet = d.result_snippet ? `\n    └ ${truncate(String(d.result_snippet), 120).split("\n").join("\n      ")}` : "";
      return `${ts} [tool] ${truncate(label, 72)} (${flags.join(", ")}) id=${String(d.tool_call_id)}${snippet}`;
    }
    case "spend": {
      const est = d.estimated === true ? " (estimated)" : "";
      return `${ts} [spend] ${String(d.phase)} in=${String(d.tokens_in)} out=${String(d.tokens_out)} cache_read=${String(d.cache_read)} cache_write=${String(d.cache_write)} usd=${usd(d.usd as number | null)}${est}`;
    }
    case "envelope":
      return `${ts} [envelope] ${String(d.phase)} visit=${String(d.visit)} attempt=${String(d.attempt)} valid=${String(d.valid)}`;
    case "gate_result":
      return `${ts} [gate] ${String(d.gate)} ${d.pass ? "pass" : `fail: ${(d.violations as string[]).join(", ")}`}`;
    case "correction":
      return `${ts} [correction] ${String(d.phase)} visit=${String(d.visit)} reason=${truncate(String(d.reason))}`;
    case "human_action":
      return `${ts} [human] ${String(d.action)}${d.by ? ` by ${String(d.by)}` : ""}: ${truncate(String(d.detail))}`;
    default:
      return `${ts} [${e.type}] ${JSON.stringify(d)}`;
  }
}
