import { test, expect } from "bun:test";

import { DEFAULT_SNIPPET_CAP, Tracer, extractUsage } from "../src/index.ts";
import type { FoldedEvent } from "../src/index.ts";
import { messageEnd, messageUpdate, toolEnd, toolStart, toolUpdate } from "./helpers.ts";

function runStream(lines: string[], opts: { exitCode?: number; now?: () => number; snippetCap?: number } = {}) {
  const events: FoldedEvent[] = [];
  const raw: string[] = [];
  const tracer = new Tracer({
    phase: "build",
    visit: 1,
    agent: "builder",
    piSessionId: "s1",
    snippetCap: opts.snippetCap,
    now: opts.now,
    sink: (e) => events.push(e),
    rawAppend: (l) => raw.push(l),
  });
  for (const line of lines) tracer.onLine(line);
  tracer.onEnd({ exitCode: opts.exitCode ?? 0 });
  return { events, raw };
}

const ofType = (events: FoldedEvent[], type: string) => events.filter((e) => e.type === type);
const asTool = (e: FoldedEvent) => e.data as { tool: string; tool_call_id: string; args: unknown; ok: boolean; result_snippet: string; duration_ms: number; truncated?: boolean };
const asSpend = (e: FoldedEvent) => e.data as { phase: string; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number; usd: number | null };

// ── §7.1 raw capture ─────────────────────────────────────────────────────────

test("every raw line is appended verbatim BEFORE parsing, even non-JSON junk", () => {
  const { raw } = runStream(["this is not json", toolStart("c1", "bash", "ls"), "42"]);
  expect(raw).toEqual(["this is not json", toolStart("c1", "bash", "ls"), "42"]);
});

// ── §7.2 tool-call folding ───────────────────────────────────────────────────

test("start/end fold into exactly one tool_call with duration from receipt wall clock", () => {
  let now = 1_000;
  const { events } = runStream(
    [toolStart("c1", "bash", "ls -la"), toolEnd("c1", "bash", "src/\n")],
    { now: () => now },
  );
  const calls = ofType(events, "tool_call");
  expect(calls).toHaveLength(1);
  const c = asTool(calls[0]!);
  expect(c.tool).toBe("bash");
  expect(c.tool_call_id).toBe("c1");
  expect(c.args).toBe("ls -la");
  expect(c.result_snippet).toBe("src/\n");
  expect(c.ok).toBe(true);
  expect(c.truncated).toBeUndefined();
  expect(c.duration_ms).toBe(0);
});

test("duration_ms is the wall clock between start and end receipts", () => {
  let clock = 1_000;
  const events: FoldedEvent[] = [];
  const tracer = new Tracer({
    phase: "p", visit: 1, agent: "a", piSessionId: "s",
    now: () => clock, sink: (e) => events.push(e),
  });
  tracer.onLine(toolStart("c1", "bash", "x"));
  clock = 1_250;
  tracer.onLine(toolEnd("c1", "bash", "y"));
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.duration_ms).toBe(250);
});

test("update REPLACES the accumulated snippet (never appends)", () => {
  const { events } = runStream([
    toolStart("c1", "bash", "x"),
    toolUpdate("c1", "bash", "first"),
    toolUpdate("c1", "bash", "second"),
    toolEnd("c1", "bash", "second"),
  ]);
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.result_snippet).toBe("second"); // not "firstsecond"
});

test("end without updates falls back to the last partialResult as the snippet", () => {
  const { events } = runStream([toolStart("c1", "bash", "x"), toolUpdate("c1", "bash", "streamed output")]);
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.result_snippet).toBe("streamed output");
});

test("snippet is capped at the configured cap", () => {
  const big = "x".repeat(DEFAULT_SNIPPET_CAP + 100);
  const { events } = runStream([toolStart("c1", "bash", "x"), toolEnd("c1", "bash", big)]);
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.result_snippet.length).toBe(DEFAULT_SNIPPET_CAP);
});

test("isError closes a call with ok=false", () => {
  const { events } = runStream([toolStart("c1", "grep", "x"), toolEnd("c1", "grep", "no matches", true)]);
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.ok).toBe(false);
});

test("multi-block content is joined into one snippet", () => {
  const captured: FoldedEvent[] = [];
  const tracer = new Tracer({
    phase: "p", visit: 1, agent: "a", piSessionId: "s", sink: (e) => captured.push(e),
  });
  tracer.onLine(toolStart("c1", "bash", "x"));
  tracer.onLine(
    '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"a\\n"},{"type":"text","text":"b"}]},"isError":false}',
  );
  tracer.onEnd({ exitCode: 0 });
  const c = asTool(ofType(captured, "tool_call")[0]!);
  expect(c.result_snippet).toBe("a\n\nb");
});

test("a missing toolCallId falls back to a (toolName, start_ts) key", () => {
  let now = 5_000;
  const { events } = runStream(
    ['{"type":"tool_execution_start","toolName":"bash","args":"x"}', '{"type":"tool_execution_end","toolName":"bash","result":{"content":[{"type":"text","text":"y"}]},"isError":false}'],
    { now: () => now },
  );
  const c = asTool(ofType(events, "tool_call")[0]!);
  expect(c.tool_call_id).toBe("bash:5000");
});

test("mid-stream death flushes open calls as ok=false, truncated=true", () => {
  const { events } = runStream([toolStart("c1", "bash", "x"), toolUpdate("c1", "bash", "half")], {
    exitCode: 1,
  });
  const calls = ofType(events, "tool_call");
  expect(calls).toHaveLength(1);
  const c = asTool(calls[0]!);
  expect(c.ok).toBe(false);
  expect(c.truncated).toBe(true);
  expect(c.result_snippet).toBe("half");
});

test("a call that completes while another dies mid-way: only the open one is truncated", () => {
  const { events } = runStream([toolStart("c1", "bash", "a"), toolEnd("c1", "bash", "done"), toolStart("c2", "edit", "b")], {
    exitCode: 1,
  });
  const calls = ofType(events, "tool_call");
  expect(calls).toHaveLength(2);
  expect(asTool(calls[0]!).ok).toBe(true);
  expect(asTool(calls[0]!).truncated).toBeUndefined();
  expect(asTool(calls[1]!).ok).toBe(false);
  expect(asTool(calls[1]!).truncated).toBe(true);
});

// ── §7.4 agent_end / settle ──────────────────────────────────────────────────

test("agent_end fires at stream close with ok=settled && clean exit", () => {
  const settled = runStream(['{"type":"agent_settled"}'], { exitCode: 0 });
  const a = settled.events.find((e) => e.type === "agent_end")!.data as { ok: boolean; exit: number | null };
  expect(a.ok).toBe(true);
  expect(a.exit).toBe(0);
});

test("agent_end with willRetry is NOT terminal; agent_settled is", () => {
  const { events } = runStream([
    '{"type":"agent_end","willRetry":true}',
    '{"type":"agent_end","willRetry":false}',
    '{"type":"agent_settled"}',
  ]);
  const ends = ofType(events, "agent_end");
  expect(ends).toHaveLength(1); // folded exactly once, at close
  expect((ends[0]!.data as { ok: boolean }).ok).toBe(true);
});

test("a stream that dies before agent_settled folds agent_end ok=false with the real exit code", () => {
  const { events } = runStream([], { exitCode: 143 });
  const a = events.find((e) => e.type === "agent_end")!.data as { ok: boolean; exit: number };
  expect(a.ok).toBe(false);
  expect(a.exit).toBe(143);
});

// ── §7.3 usage folding ───────────────────────────────────────────────────────

test("usage diffs cumulative snapshots into spend deltas per (phase, visit)", () => {
  const { events } = runStream([
    messageUpdate(500, 42, { cost: 0.00102 }),
    messageEnd(500, 42, { cost: 0.00102 }), // zero delta -> skipped
    messageUpdate(900, 260, { cacheRead: 100, cost: 0.00291 }),
    messageEnd(900, 260, { cacheRead: 100, cost: 0.00291 }),
    messageUpdate(1400, 380, { cacheRead: 100, cacheWrite: 50, cost: 0.00463 }),
    messageEnd(1400, 380, { cacheRead: 100, cacheWrite: 50, cost: 0.00463 }),
  ]);
  const spends = ofType(events, "spend").map(asSpend);
  expect(spends).toHaveLength(3);
  expect(spends[0]).toEqual({ phase: "build", tokens_in: 500, tokens_out: 42, cache_read: 0, cache_write: 0, usd: 0.00102 });
  expect(spends[1]!.tokens_in).toBe(400);
  expect(spends[1]!.tokens_out).toBe(218);
  expect(spends[1]!.cache_read).toBe(100);
  expect(spends[1]!.cache_write).toBe(0);
  expect(spends[1]!.usd).toBeCloseTo(0.00189);
  expect(spends[2]!.tokens_in).toBe(500);
  expect(spends[2]!.tokens_out).toBe(120);
  expect(spends[2]!.cache_read).toBe(0);
  expect(spends[2]!.cache_write).toBe(50);
  expect(spends[2]!.usd).toBeCloseTo(0.00172);
});

test("usage deltas never go negative even when a snapshot regresses", () => {
  const { events } = runStream([
    messageUpdate(1000, 100, { cost: 0.01 }),
    messageUpdate(800, 200, { cost: 0.008 }), // input and cost regressed; output grew
  ]);
  const spends = ofType(events, "spend").map(asSpend);
  expect(spends).toHaveLength(2);
  const delta = spends[1]!;
  expect(delta.tokens_in).toBe(0); // clamped, never negative
  expect(delta.tokens_out).toBe(100);
  expect(delta.usd).toBe(0);
  for (const s of spends) {
    expect(s.tokens_in).toBeGreaterThanOrEqual(0);
    expect(s.tokens_out).toBeGreaterThanOrEqual(0);
    expect(s.cache_read).toBeGreaterThanOrEqual(0);
    expect(s.cache_write).toBeGreaterThanOrEqual(0);
  }
});

test("usd is null when pi reports no cost (roster fallback, §11.1)", () => {
  const { events } = runStream([messageUpdate(100, 10)]);
  const s = asSpend(ofType(events, "spend")[0]!);
  expect(s.usd).toBeNull();
});

test("machinery events are recorded raw but never folded (§7.4)", () => {
  const { events } = runStream(['{"type":"queue_update","queued":1}', '{"type":"compaction_start"}', toolStart("c1", "bash", "x"), toolEnd("c1", "bash", "y")]);
  expect(ofType(events, "tool_call")).toHaveLength(1);
  expect(events.some((e) => e.type === "spend")).toBe(false);
});

test("extractUsage reads evt.usage (message_update) and evt.message.usage (message_end)", () => {
  const u1 = extractUsage({ type: "message_update", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5 } } });
  expect(u1).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costTotal: 5 });
  const u2 = extractUsage({ type: "message_end", message: { usage: { input: 7 } } });
  expect(u2?.input).toBe(7);
  expect(u2?.costTotal).toBeNull();
  expect(extractUsage({ type: "message_end", message: {} })).toBeNull();
});
