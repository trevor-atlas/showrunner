import {
  RawToolExecutionEnd,
  RawToolExecutionStart,
  RawToolExecutionUpdate,
} from "@showrunner/core";

/**
 * The tracer (spec §7): folds a raw pi JSONL stream into the three harness
 * event types it owns - tool_call (§7.2), spend (§7.3), and agent_end
 * (agent_settled / stream death). The driver emits the run/phase/agent
 * lifecycle events around it.
 *
 * Rules implemented:
 *  - every raw line is appended to raw_output.jsonl verbatim BEFORE parsing
 *  - tool calls fold start/update/end by toolCallId into exactly one tool_call
 *    row; update REPLACES the accumulated snippet (not appends); the snippet is
 *    capped at `snippetCap` (default 4 KB); duration_ms is the wall clock
 *    between the start and end receipts (pi emits no duration); a missing id
 *    falls back to (toolName, start_ts)
 *  - calls still open when the stream dies are flushed as ok:false, truncated:true
 *  - usage is snapshotted at message_update / message_end / turn_end and
 *    diffed per (phase, visit) into spend deltas; usd comes from pi's reported
 *    cost when present, else null (§11.1)
 *  - agent_end fires once, at stream close, with ok = settled && clean exit
 */

export type FoldedEventType = "tool_call" | "spend" | "agent_end";

export interface FoldedEvent {
  type: FoldedEventType;
  data: unknown;
}

export type TracerSink = (evt: FoldedEvent) => void;

export interface TracerOptions {
  phase: string; // phase name
  visit: number;
  agent: string; // agent name
  piSessionId: string;
  /** snippet cap in characters (default 4096, §7.2) */
  snippetCap?: number;
  /** injectable wall clock (ms epoch) for deterministic tests */
  now?: () => number;
  sink: TracerSink;
  /** append a raw line verbatim, BEFORE parsing (spec §10) */
  rawAppend?: (line: string) => void;
}

export const DEFAULT_SNIPPET_CAP = 4096;

interface PendingCall {
  key: string;
  tool: string;
  toolCallId: string;
  args: unknown;
  snippet: string;
  startTs: number;
}

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number | null;
}

export class Tracer {
  private readonly opts: Required<Pick<TracerOptions, "snippetCap" | "now">> &
    Omit<TracerOptions, "snippetCap" | "now">;
  private readonly calls = new Map<string, PendingCall>();
  private lastUsage: UsageSnapshot | null = null;
  private settled = false;

  constructor(opts: TracerOptions) {
    this.opts = {
      phase: opts.phase,
      visit: opts.visit,
      agent: opts.agent,
      piSessionId: opts.piSessionId,
      snippetCap: opts.snippetCap ?? DEFAULT_SNIPPET_CAP,
      now: opts.now ?? (() => Date.now()),
      sink: opts.sink,
      rawAppend: opts.rawAppend,
    };
  }

  get hasSettled(): boolean {
    return this.settled;
  }

  /** Number of tool calls still open (test visibility). */
  get openCallCount(): number {
    return this.calls.size;
  }

  /** Handle one raw JSONL line (already split on `\n`, no trailing newline). */
  onLine(raw: string): void {
    this.opts.rawAppend?.(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // non-JSON line: recorded verbatim, skipped for folding
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const evt = parsed as Record<string, unknown>;
    switch (evt.type) {
      case "tool_execution_start":
        this.onToolStart(evt);
        break;
      case "tool_execution_update":
        this.onToolUpdate(evt);
        break;
      case "tool_execution_end":
        this.onToolEnd(evt);
        break;
      case "agent_settled":
        // §7.4: agent_end with willRetry is not done; agent_settled is.
        this.settled = true;
        break;
      case "message_update":
      case "message_end":
      case "turn_end":
        this.snapshotUsage(evt);
        break;
      default:
        break; // machinery and other events: recorded raw only (§7.4)
    }
  }

  /**
   * The stream ended (process closed). Flush any open tool calls (mid-tool-call
   * death) and emit agent_end with the real exit code.
   */
  onEnd(info: { exitCode: number | null }): void {
    const nowTs = this.opts.now();
    for (const call of this.calls.values()) {
      this.emitToolCall(call, { ok: false, truncated: true, resultSnippet: call.snippet, endTs: nowTs });
    }
    this.calls.clear();
    const ok = this.settled && info.exitCode === 0;
    this.emit("agent_end", {
      agent: this.opts.agent,
      pi_session_id: this.opts.piSessionId,
      exit: info.exitCode,
      ok,
    });
  }

  // ── tool-call folding (§7.2) ───────────────────────────────────────────────

  /**
   * Resolve the pending-call key. pi always emits toolCallId; the fallback
   * (spec §7.2) handles a missing id: start keys on (toolName, start_ts), and
   * update/end resolve by toolName when exactly one call is open for it.
   */
  private resolveKey(toolCallId: string | undefined, toolName: string): string | undefined {
    if (toolCallId !== undefined && toolCallId !== "") return toolCallId;
    const matches = [...this.calls.values()].filter((c) => c.tool === toolName);
    return matches.length === 1 ? matches[0]!.key : undefined;
  }

  private onToolStart(evt: Record<string, unknown>): void {
    const r = RawToolExecutionStart.safeParse(evt);
    if (!r.success) return;
    const { toolCallId, toolName, args } = r.data;
    const key = this.resolveKey(toolCallId, toolName) ?? `${toolName}:${this.opts.now()}`;
    // a stray duplicate start overwrites the pending call rather than orphaning it
    this.calls.set(key, {
      key,
      tool: toolName,
      toolCallId: toolCallId !== undefined && toolCallId !== "" ? toolCallId : key,
      args,
      snippet: "",
      startTs: this.opts.now(),
    });
  }

  private onToolUpdate(evt: Record<string, unknown>): void {
    const r = RawToolExecutionUpdate.safeParse(evt);
    if (!r.success) return;
    const key = this.resolveKey(r.data.toolCallId, r.data.toolName);
    const call = key !== undefined ? this.calls.get(key) : undefined;
    if (!call) return;
    // §7.2: partialResult is the *accumulated* output - REPLACES, not appends
    call.snippet = capText(joinTextBlocks(r.data.partialResult.content), this.opts.snippetCap);
  }

  private onToolEnd(evt: Record<string, unknown>): void {
    const r = RawToolExecutionEnd.safeParse(evt);
    if (!r.success) return;
    const key = this.resolveKey(r.data.toolCallId, r.data.toolName);
    const call = key !== undefined ? this.calls.get(key) : undefined;
    if (!call) return;
    this.calls.delete(key!);
    const resultSnippet = capText(joinTextBlocks(r.data.result.content), this.opts.snippetCap) || call.snippet;
    this.emitToolCall(call, {
      ok: !r.data.isError,
      truncated: false,
      resultSnippet,
      endTs: this.opts.now(),
    });
  }

  private emitToolCall(
    call: PendingCall,
    info: { ok: boolean; truncated: boolean; resultSnippet: string; endTs: number },
  ): void {
    this.emit("tool_call", {
      tool: call.tool,
      tool_call_id: call.toolCallId,
      args: call.args,
      result_snippet: info.resultSnippet,
      ok: info.ok,
      truncated: info.truncated ? true : undefined,
      duration_ms: Math.max(0, info.endTs - call.startTs),
      agent: this.opts.agent,
    });
  }

  // ── usage folding (§7.3) ───────────────────────────────────────────────────

  private snapshotUsage(evt: Record<string, unknown>): void {
    const usage = extractUsage(evt);
    if (!usage) return;
    const zeroTokens = usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0;
    if (zeroTokens && usage.costTotal === null) return; // provider reports nothing yet
    const prev = this.lastUsage;
    const delta = {
      tokens_in: prev ? Math.max(0, usage.input - prev.input) : usage.input,
      tokens_out: prev ? Math.max(0, usage.output - prev.output) : usage.output,
      cache_read: prev ? Math.max(0, usage.cacheRead - prev.cacheRead) : usage.cacheRead,
      cache_write: prev ? Math.max(0, usage.cacheWrite - prev.cacheWrite) : usage.cacheWrite,
      usd:
        usage.costTotal === null
          ? null
          : prev !== null && prev.costTotal !== null
            ? Math.max(0, usage.costTotal - prev.costTotal)
            : usage.costTotal,
    };
    this.lastUsage = usage;
    if (
      delta.tokens_in === 0 &&
      delta.tokens_out === 0 &&
      delta.cache_read === 0 &&
      delta.cache_write === 0 &&
      (delta.usd === null || delta.usd === 0)
    ) {
      return;
    }
    this.emit("spend", { phase: this.opts.phase, ...delta });
  }

  private emit(type: FoldedEventType, data: unknown): void {
    this.opts.sink({ type, data });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** §7.2: content blocks are {type:"text",text}[] - join the text fields. */
export function joinTextBlocks(blocks: { type: string; text?: string }[]): string {
  return blocks.map((b) => b.text ?? "").join("\n");
}

function capText(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * Extract the cumulative usage from a message/turn event (§7.3): the field
 * lives on `evt.usage` (message_update) or `evt.message.usage`
 * (message_end / turn_end). Version-tolerant: any field that is missing or
 * not a finite number reads as 0.
 */
export function extractUsage(evt: Record<string, unknown>): UsageSnapshot | null {
  const raw = (evt.usage ?? (evt.message as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cost = (raw.cost as Record<string, unknown> | undefined)?.total;
  return {
    input: num(raw.input),
    output: num(raw.output),
    cacheRead: num(raw.cacheRead),
    cacheWrite: num(raw.cacheWrite),
    costTotal: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
  };
}
