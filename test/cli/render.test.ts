import { test, expect } from "bun:test";
import type { EventRow } from "../../src/core/index.ts";

import { formatEvent } from "../../src/cli/render.ts";

/**
 * The CLI feed renderer (spec §6) — unit-pinned so the human-readable lines
 * the watcher prints never drift from the §6 naming rule. T13 #6: the spend
 * line must visibly mark the §11.1 estimate path ("(estimated)") so a viewer
 * can tell pi-reported cost from roster-estimated cost.
 */

function row(partial: Partial<EventRow> & { type: EventRow["type"]; data: unknown }): EventRow {
  return {
    id: 1,
    run_id: "r",
    phase_id: null,
    agent_session_id: null,
    ts: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("a spend line marks the §11.1 estimate path with an (estimated) suffix (T13 #6)", () => {
  const estimated = formatEvent(
    row({
      type: "spend",
      data: { phase: "build", tokens_in: 1000, tokens_out: 200, cache_read: 0, cache_write: 0, usd: 0.006, estimated: true },
    }),
  );
  expect(estimated).toContain("[spend] build in=1000 out=200");
  expect(estimated).toContain("usd=$0.0060");
  expect(estimated).toContain("(estimated)");

  // pi-reported cost (estimated absent/false) is NOT marked
  const reported = formatEvent(
    row({
      type: "spend",
      data: { phase: "build", tokens_in: 1000, tokens_out: 200, cache_read: 0, cache_write: 0, usd: 0.0042 },
    }),
  );
  expect(reported).toContain("usd=$0.0042");
  expect(reported).not.toContain("(estimated)");

  // a null usd (no report, no roster entry, §11.1) renders n/a and is not marked
  const nullUsd = formatEvent(
    row({
      type: "spend",
      data: { phase: "build", tokens_in: 100, tokens_out: 10, cache_read: 0, cache_write: 0, usd: null },
    }),
  );
  expect(nullUsd).toContain("usd=n/a");
  expect(nullUsd).not.toContain("(estimated)");
});

test("the feed reads aloud per §6: tool calls, gates, corrections, human actions", () => {
  const tool = formatEvent(
    row({
      type: "tool_call",
      data: { tool: "bash", tool_call_id: "c1", args: "git status", result_snippet: "ok", ok: true, duration_ms: 12 },
    }),
  );
  expect(tool).toContain("[tool] bash: git status");
  expect(tool).toContain("12ms");
  expect(tool).toContain("id=c1");

  const gate = formatEvent(
    row({
      type: "gate_result",
      data: { gate: "testsPass", pass: false, violations: ["tests failed (exit 1)"] },
    }),
  );
  expect(gate).toContain("[gate] testsPass fail: tests failed (exit 1)");

  const human = formatEvent(
    row({
      type: "human_action",
      data: { action: "override_gate", by: "reviewer", detail: "gate testsPass overridden" },
    }),
  );
  expect(human).toContain("[human] override_gate by reviewer: gate testsPass overridden");
});
