/**
 * Unit tests for the run-detail pure logic: the gantt model (fill fractions,
 * now cursor, paused fill edge — §16.7/§16.5), the tool-call naming rule
 * (§6), and blueprint-order phase reordering (§16.7).
 */
import { describe, expect, it } from "bun:test";

import { orderPhases } from "../app/actions/runs/phase-order.ts";
import { describeToolCall } from "../app/ui/public/event-feed.tsx";
import { computeGantt } from "../app/ui/public/gantt-model.ts";
import type { GanttPhaseInput } from "../app/ui/public/gantt-model.ts";

const START = new Date("2026-01-02T10:00:00.000Z").getTime();

const phase = (overrides: Partial<GanttPhaseInput> = {}): GanttPhaseInput => ({
  name: "build",
  agent: "builder",
  status: "in_progress",
  corrections: 0,
  visits: 1,
  spend_usd: 0,
  started_at: null,
  ended_at: null,
  ...overrides,
});

const run = (overrides: { status?: string; ended_at?: string | null } = {}) => ({
  started_at: new Date(START).toISOString(),
  ended_at: overrides.ended_at ?? null,
  status: overrides.status ?? "running",
});

const phaseStart = (name: string, offsetMs: number) => ({
  type: "phase_start",
  ts: new Date(START + offsetMs).toISOString(),
  data: { phase: name, agent: "builder", visit: 1, budget: 3 },
});

const phaseEnd = (name: string, offsetMs: number) => ({
  type: "phase_end",
  ts: new Date(START + offsetMs).toISOString(),
  data: { phase: name, status: "success", visits: 1, corrections: 0, spend_usd: 0 },
});

const runStatusPaused = (offsetMs: number) => ({
  type: "run_status",
  ts: new Date(START + offsetMs).toISOString(),
  data: { from: "running", to: "paused" },
});

describe("computeGantt (§16.7 fill math)", () => {
  it("fills a completed phase across its real window on the run timeline", () => {
    const model = computeGantt(
      [phase({ name: "plan", status: "success", started_at: new Date(START + 10_000).toISOString(), ended_at: new Date(START + 60_000).toISOString() })],
      run(),
      [phaseStart("plan", 10_000), phaseEnd("plan", 60_000)],
      START + 120_000, // now = 2 min in
    );
    const bar = model.phases[0]!;
    expect(bar.filled).toBe(true);
    // 10s..60s over a 120s window → [0.083, 0.5]
    expect(bar.startF).toBeCloseTo(10_000 / 120_000, 5);
    expect(bar.endF).toBeCloseTo(60_000 / 120_000, 5);
    expect(bar.durationMs).toBe(50_000);
    expect(bar.barStatus).toBe("success");
  });

  it("fills an in-flight phase live to NOW while the run is running", () => {
    const model = computeGantt(
      [phase({ started_at: new Date(START + 10_000).toISOString() })],
      run(),
      [phaseStart("build", 10_000)],
      START + 90_000,
    );
    const bar = model.phases[0]!;
    expect(bar.filled).toBe(true);
    expect(bar.endF).toBeCloseTo(90_000 / 90_000, 5); // timeline end == now
    expect(bar.durationMs).toBe(80_000);
    // the now cursor tracks the same point
    expect(model.showCursor).toBe(true);
    expect(model.nowF).toBeCloseTo(1, 5);
  });

  it("a paused run stops the in-flight fill at the pause moment (amber edge), not now", () => {
    const model = computeGantt(
      [phase({ status: "in_progress", started_at: new Date(START + 10_000).toISOString() })],
      run({ status: "paused" }),
      [phaseStart("build", 10_000), runStatusPaused(60_000)],
      START + 300_000, // 4 min after the pause
    );
    const bar = model.phases[0]!;
    expect(bar.paused).toBe(true);
    expect(bar.filled).toBe(true);
    expect(bar.endF).toBeCloseTo(60_000 / 300_000, 5); // pause ts, not now
    expect(bar.durationMs).toBe(50_000);
    // the cursor marks the pause moment too
    expect(model.nowF).toBeCloseTo(60_000 / 300_000, 5);
  });

  it("a pending phase is empty and dimmed — no fill, no duration", () => {
    const model = computeGantt(
      [phase({ name: "ship", status: "pending", started_at: null, ended_at: null })],
      run(),
      [],
      START + 60_000,
    );
    const bar = model.phases[0]!;
    expect(bar.filled).toBe(false);
    expect(bar.durationMs).toBeNull();
    expect(bar.barStatus).toBe("pending");
  });

  it("shows the now cursor only for running/paused runs, never a terminal one", () => {
    expect(computeGantt([phase({ started_at: new Date(START + 1000).toISOString() })], run(), [], START + 60_000).showCursor).toBe(true);
    expect(
      computeGantt([phase({ started_at: new Date(START + 1000).toISOString() })], run({ status: "paused" }), [], START + 60_000).showCursor,
    ).toBe(true);
    expect(
      computeGantt(
        [phase({ status: "success", started_at: new Date(START + 1000).toISOString(), ended_at: new Date(START + 5000).toISOString() })],
        run({ status: "success", ended_at: new Date(START + 5000).toISOString() }),
        [],
        START + 60_000,
      ).showCursor,
    ).toBe(false);
  });

  it("uses the phase_end EVENT when the phase row has no ended_at, and passes corr/vis/spend through", () => {
    const model = computeGantt(
      [phase({ name: "plan", status: "success", started_at: new Date(START + 10_000).toISOString(), ended_at: null, corrections: 2, visits: 3, spend_usd: 0.42 })],
      run(),
      [phaseStart("plan", 10_000), phaseEnd("plan", 70_000)],
      START + 140_000,
    );
    const bar = model.phases[0]!;
    expect(bar.endF).toBeCloseTo(70_000 / 140_000, 5);
    expect(bar.corrections).toBe(2);
    expect(bar.visits).toBe(3);
    expect(bar.spendUsd).toBeCloseTo(0.42, 5);
  });
});

describe("describeToolCall (§6 naming rule — read it aloud)", () => {
  it("uses string args as-is", () => {
    expect(describeToolCall("bash", "ls -la src")).toBe("bash: ls -la src");
  });
  it("names object args from the most name-like field", () => {
    expect(
      describeToolCall("edit", { filePath: "packages/daemon/src/db.ts", oldString: "a", newString: "b" }),
    ).toBe("edit: packages/daemon/src/db.ts");
    expect(describeToolCall("bash", { command: "bun test" })).toBe("bash: bun test");
  });
  it("falls back to compact JSON for shapeless args", () => {
    expect(describeToolCall("bash", { a: 1, b: [1, 2, 3] })).toBe("bash: {\"a\":1,\"b\":[1,2,3]}");
  });
  it("handles empty args", () => {
    expect(describeToolCall("bash", "")).toBe("bash: (no args)");
    expect(describeToolCall("bash", undefined)).toBe("bash: (no args)");
  });
});

describe("orderPhases (§16.7 blueprint order)", () => {
  const phases = [
    { name: "plan", started_at: new Date(START + 5000).toISOString() },
    { name: "build", started_at: new Date(START + 65_000).toISOString() },
    { name: "ship", started_at: null }, // pending — the daemon's NULL-first sort
  ];
  it("prefers the §13.3 snapshot's blueprint order", () => {
    const ordered = orderPhases(phases, [], ["plan", "build", "ship"]);
    expect(ordered.map((p) => p.name)).toEqual(["plan", "build", "ship"]);
  });
  it("appends detail phases the snapshot does not mention, in array order", () => {
    const ordered = orderPhases(phases, [], ["ship", "plan"]);
    expect(ordered.map((p) => p.name)).toEqual(["ship", "plan", "build"]);
  });
  it("falls back to phase_start event order (started phases first, then never-started in array order)", () => {
    // daemon order: pending NULLs first → [ship, plan, build]
    const daemonOrder = [phases[2]!, phases[0]!, phases[1]!];
    const ordered = orderPhases(daemonOrder, [phaseStart("plan", 5000), phaseStart("build", 65_000)], null);
    expect(ordered.map((p) => p.name)).toEqual(["plan", "build", "ship"]);
  });
});
