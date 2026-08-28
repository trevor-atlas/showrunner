/**
 * Unit tests for the #85 trajectory swimlane layout — pure, no DOM. Pins the
 * ordinal placement (fraction per entry along the shared reading axis), the
 * per-lane grouping + counts, the fixed three-lane shape (empty lanes still
 * present), and that points follow seq order. Expected fractions are
 * independent literals, not recomputed the way the code computes them.
 */
import { describe, expect, it } from "bun:test";

import type { TrajectoryEntry, TrajectoryView } from "../../src/server/contract.ts";
import { computeTrajectoryLayout, TRAJECTORY_LANES } from "../../src/server/ui/public/trajectory/trajectory-model.ts";

function msg(seq: number, role: "user" | "assistant", text = "x"): TrajectoryEntry {
  return { seq, lane: role === "user" ? "input" : "model", turn: 0, step: seq, role, text };
}

function tool(seq: number, name = "bash"): TrajectoryEntry {
  return {
    seq,
    lane: "tools",
    turn: 0,
    step: seq,
    tool: name,
    tool_call_id: null,
    args: {},
    result: "ok",
    ok: true,
    ts: null,
    duration_ms: null,
  };
}

function view(entries: TrajectoryEntry[], over: Partial<TrajectoryView> = {}): TrajectoryView {
  return { run_id: "r1", phase: "alpha", phase_id: "p-alpha", entries, truncated: false, ...over };
}

const laneOf = (layout: ReturnType<typeof computeTrajectoryLayout>, lane: string) =>
  layout.lanes.find((l) => l.lane === lane)!;

describe("computeTrajectoryLayout (#85) — ordinal swimlane placement", () => {
  it("places each entry at its ordinal fraction along the shared reading axis", () => {
    // five entries at seq 1..5 → fractions 0, 0.25, 0.5, 0.75, 1
    const layout = computeTrajectoryLayout(
      view([msg(1, "user"), msg(2, "assistant"), tool(3), msg(4, "assistant"), tool(5)]),
    );
    const all = layout.lanes.flatMap((l) => l.points).sort((a, b) => a.seq - b.seq);
    expect(all.map((p) => p.fraction)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("groups points by lane with per-lane counts", () => {
    const layout = computeTrajectoryLayout(
      view([msg(1, "user"), msg(2, "assistant"), tool(3), msg(4, "assistant"), tool(5)]),
    );
    expect(laneOf(layout, "input").count).toBe(1);
    expect(laneOf(layout, "model").count).toBe(2);
    expect(laneOf(layout, "tools").count).toBe(2);
    expect(layout.total).toBe(5);
    // input holds seq 1; model holds seq 2 & 4; tools holds seq 3 & 5
    expect(laneOf(layout, "input").points.map((p) => p.seq)).toEqual([1]);
    expect(laneOf(layout, "model").points.map((p) => p.seq)).toEqual([2, 4]);
    expect(laneOf(layout, "tools").points.map((p) => p.seq)).toEqual([3, 5]);
  });

  it("always returns exactly three lanes in input→model→tools order", () => {
    const layout = computeTrajectoryLayout(view([msg(1, "user")]));
    expect(layout.lanes.map((l) => l.lane)).toEqual([...TRAJECTORY_LANES]);
    expect(layout.lanes.map((l) => l.lane)).toEqual(["input", "model", "tools"]);
  });

  it("keeps empty lanes present with a 0 count and no points", () => {
    // only tool calls → input and model lanes are empty but still there
    const layout = computeTrajectoryLayout(view([tool(1), tool(2)]));
    expect(laneOf(layout, "input").count).toBe(0);
    expect(laneOf(layout, "input").points).toEqual([]);
    expect(laneOf(layout, "model").count).toBe(0);
    expect(laneOf(layout, "tools").count).toBe(2);
  });

  it("places a lone point at 0 (no divide-by-zero)", () => {
    const layout = computeTrajectoryLayout(view([tool(7)]));
    expect(laneOf(layout, "tools").points).toEqual([{ seq: 7, lane: "tools", fraction: 0 }]);
    expect(layout.total).toBe(1);
  });

  it("renders three empty lanes for a view with no entries", () => {
    const layout = computeTrajectoryLayout(view([]));
    expect(layout.total).toBe(0);
    expect(layout.lanes.map((l) => l.count)).toEqual([0, 0, 0]);
  });

  it("orders points by seq even when entries arrive out of order", () => {
    const layout = computeTrajectoryLayout(view([tool(3), msg(1, "user"), msg(2, "assistant")]));
    // seq 1 (input) → 0, seq 2 (model) → 0.5, seq 3 (tools) → 1
    expect(laneOf(layout, "input").points[0]?.fraction).toBe(0);
    expect(laneOf(layout, "model").points[0]?.fraction).toBe(0.5);
    expect(laneOf(layout, "tools").points[0]?.fraction).toBe(1);
  });
});
