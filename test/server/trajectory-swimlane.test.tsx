/**
 * #85: the Trajectory swimlanes, rendered through their PUBLIC seam under
 * happy-dom. Pins: three labelled lanes (Input / Model / Tools) always render,
 * each with a per-lane count header and one point per entry positioned by
 * ordinal fraction; empty lanes still render a header + track; points follow
 * seq order. Structure mirrors phase-cards.test.tsx (the house DOM style).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { TrajectoryEntry, TrajectoryView } from "../../src/server/contract.ts";
import { TrajectorySwimlane } from "../../src/server/ui/public/trajectory/trajectory-swimlane.tsx";

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

let active: RenderResult | null = null;
function mount(node: Parameters<typeof render>[0]): RenderResult {
  active = render(node);
  return active;
}
afterEach(() => {
  active?.cleanup();
  active = null;
});

const lane = (r: RenderResult, name: string): Element | null =>
  r.$(`[data-testid='trajectory-lane'][data-lane='${name}']`);

const pointSeqs = (el: Element | null): number[] =>
  [...(el?.querySelectorAll("[data-testid='trajectory-point']") ?? [])].map((n) =>
    Number(n.getAttribute("data-seq")),
  );

describe("TrajectorySwimlane (#85) — three labelled lanes with ordinal points", () => {
  it("renders exactly three lanes labelled Input / Model / Tools", () => {
    const r = mount(<TrajectorySwimlane view={view([msg(1, "user"), msg(2, "assistant"), tool(3)])} />);
    const lanes = [...r.$$("[data-testid='trajectory-lane']")];
    expect(lanes.length).toBe(3);
    expect(lanes.map((l) => l.getAttribute("data-lane"))).toEqual(["input", "model", "tools"]);
    expect(r.container.textContent).toContain("Input");
    expect(r.container.textContent).toContain("Model");
    expect(r.container.textContent).toContain("Tools");
  });

  it("places one point per entry on the right lane, in seq order", () => {
    const r = mount(
      <TrajectorySwimlane view={view([msg(1, "user"), msg(2, "assistant"), tool(3), tool(4)])} />,
    );
    expect(r.$$("[data-testid='trajectory-point']").length).toBe(4);
    expect(pointSeqs(lane(r, "input"))).toEqual([1]);
    expect(pointSeqs(lane(r, "model"))).toEqual([2]);
    expect(pointSeqs(lane(r, "tools"))).toEqual([3, 4]);
  });

  it("shows per-lane counts in the lane headers", () => {
    const r = mount(
      <TrajectorySwimlane view={view([msg(1, "user"), tool(2), tool(3)])} />,
    );
    expect(lane(r, "input")?.getAttribute("data-count")).toBe("1");
    expect(lane(r, "model")?.getAttribute("data-count")).toBe("0");
    expect(lane(r, "tools")?.getAttribute("data-count")).toBe("2");
    expect(lane(r, "tools")?.querySelector("[data-lane-count]")?.textContent).toBe("2");
  });

  it("renders an empty lane cleanly — header + track, no points", () => {
    const r = mount(<TrajectorySwimlane view={view([tool(1)])} />);
    const input = lane(r, "input");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("data-count")).toBe("0");
    expect(input?.querySelector("[data-lane-track]")).not.toBeNull();
    expect(pointSeqs(input)).toEqual([]);
  });

  it("still renders three lanes for a view with no entries", () => {
    const r = mount(<TrajectorySwimlane view={view([])} />);
    expect(r.$$("[data-testid='trajectory-lane']").length).toBe(3);
    expect(r.$$("[data-testid='trajectory-point']").length).toBe(0);
  });
});
