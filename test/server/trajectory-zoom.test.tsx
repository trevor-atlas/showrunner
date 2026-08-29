/**
 * #87: the Trajectory tab's ZOOM / BRUSH WINDOW, at its agreed seams. Two
 * layers:
 *
 *   - the PURE model (`computeTrajectoryLayout` + `entriesInZoom`): a zoom
 *     window includes only the in-window entries, re-normalizes their ordinal
 *     fractions over the windowed set, and keeps per-lane counts consistent;
 *     without a window the layout is identical to pre-#87;
 *   - the DOM (<TrajectorySwimlane> brush + <TrajectoryPanel>): a drag across
 *     the track fires onBrush with a [start,end] window and renders a visible
 *     overlay; the panel restricts BOTH the lanes (point count) AND the feed
 *     (row count) to the same in-window set; clearing restores the full range;
 *     the window survives a simulated SSE view refetch (a re-render with a new
 *     view prop keeps it).
 *
 * Structure mirrors trajectory-swimlane.test.tsx / trajectory-detail.test.tsx.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { ensureDom, teardownDom } from "./dom-harness.ts";

ensureDom();
afterAll(teardownDom);

import { render, type RenderResult } from "remix/ui/test";

import type { TrajectoryEntry, TrajectoryView } from "../../src/server/contract.ts";
import {
  computeTrajectoryLayout,
  entriesInZoom,
  type TrajectoryZoomWindow,
} from "../../src/server/ui/public/trajectory/trajectory-model.ts";
import { TrajectoryPanel } from "../../src/server/ui/public/trajectory/trajectory-panel.tsx";
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

/** five entries at seq 1..5 → global ordinal fractions 0, .25, .5, .75, 1:
 * input(1) · model(2) · tools(3) · model(4) · tools(5). */
const five = (): TrajectoryEntry[] => [
  msg(1, "user"),
  msg(2, "assistant"),
  tool(3),
  msg(4, "assistant"),
  tool(5),
];

const laneOf = (layout: ReturnType<typeof computeTrajectoryLayout>, lane: string) =>
  layout.lanes.find((l) => l.lane === lane)!;

// ── pure model ───────────────────────────────────────────────────────────────

describe("computeTrajectoryLayout (#87) — zoom windowing", () => {
  it("without a zoom window is identical to the un-windowed layout", () => {
    const v = view(five());
    expect(computeTrajectoryLayout(v, { zoom: null })).toEqual(computeTrajectoryLayout(v));
  });

  it("includes only in-window entries and re-normalizes their fractions", () => {
    // window [0.25, 0.75] keeps the entries at global fractions .25/.5/.75 →
    // seq 2 (model) · 3 (tools) · 4 (model); their windowed fractions become
    // 0, 0.5, 1 (independent literals, not recomputed the code's way).
    const layout = computeTrajectoryLayout(view(five()), { zoom: { start: 0.25, end: 0.75 } });
    expect(layout.total).toBe(3);
    const all = layout.lanes.flatMap((l) => l.points).sort((a, b) => a.seq - b.seq);
    expect(all.map((p) => p.seq)).toEqual([2, 3, 4]);
    expect(all.map((p) => p.fraction)).toEqual([0, 0.5, 1]);
  });

  it("keeps per-lane counts consistent for the windowed set", () => {
    const layout = computeTrajectoryLayout(view(five()), { zoom: { start: 0.25, end: 0.75 } });
    expect(laneOf(layout, "input").count).toBe(0);
    expect(laneOf(layout, "model").count).toBe(2); // seq 2 & 4
    expect(laneOf(layout, "tools").count).toBe(1); // seq 3
  });

  it("normalizes a reversed window (end < start)", () => {
    const forward = computeTrajectoryLayout(view(five()), { zoom: { start: 0.25, end: 0.75 } });
    const reversed = computeTrajectoryLayout(view(five()), { zoom: { start: 0.75, end: 0.25 } });
    expect(reversed).toEqual(forward);
  });

  it("a window that admits one entry places it at fraction 0", () => {
    const layout = computeTrajectoryLayout(view(five()), { zoom: { start: 0.5, end: 0.5 } });
    expect(layout.total).toBe(1);
    expect(laneOf(layout, "tools").points).toEqual([{ seq: 3, lane: "tools", fraction: 0 }]);
  });

  it("a full window [0,1] is identical to the un-windowed layout", () => {
    const v = view(five());
    expect(computeTrajectoryLayout(v, { zoom: { start: 0, end: 1 } })).toEqual(computeTrajectoryLayout(v));
  });
});

describe("entriesInZoom (#87) — the single shared filter", () => {
  it("returns the full seq-ordered set for a null window", () => {
    expect(entriesInZoom(five(), null).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("restricts to the in-window entries by ordinal fraction", () => {
    expect(entriesInZoom(five(), { start: 0.25, end: 0.75 }).map((e) => e.seq)).toEqual([2, 3, 4]);
  });
});

// ── DOM: the swimlane brush seam ─────────────────────────────────────────────

let active: RenderResult | null = null;
function mount(node: Parameters<typeof render>[0]): RenderResult {
  active = render(node);
  return active;
}
afterEach(() => {
  active?.cleanup();
  active = null;
});

const points = (r: RenderResult): number => r.$$("[data-testid='trajectory-point']").length;
const rowSeqs = (r: RenderResult): number[] =>
  [...r.$$("[data-testid='trajectory-row']")].map((n) => Number(n.getAttribute("data-seq")));

/** Drive a brush drag across the swimlane's brush layer. clientX values map to
 * fractions through a mocked 0..100 layer rect — deterministic, no real pixel
 * math (the panel/swimlane compute the window; the test just supplies known
 * endpoints). */
const brushDrag = async (r: RenderResult, fromX: number, toX: number): Promise<void> => {
  const layer = r.$("[data-testid='trajectory-brush-layer']") as HTMLElement;
  layer.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 10, width: 100, height: 10, x: 0, y: 0, toJSON() {} }) as DOMRect;
  await r.act(() => {
    layer.dispatchEvent(new PointerEvent("pointerdown", { clientX: fromX, bubbles: true }));
    layer.dispatchEvent(new PointerEvent("pointerup", { clientX: toX, bubbles: true }));
  });
};

describe("TrajectorySwimlane (#87) — brush interaction seam", () => {
  it("has no brush affordance without an onBrush handler (pre-#87 behavior)", () => {
    const r = mount(<TrajectorySwimlane view={view(five())} />);
    expect(r.$("[data-testid='trajectory-brush-layer']")).toBeNull();
    expect(points(r)).toBe(5);
  });

  it("renders a visible overlay + clear control for an active zoom", () => {
    const r = mount(
      <TrajectorySwimlane view={view(five())} zoom={{ start: 0.25, end: 0.75 }} onBrush={() => {}} />,
    );
    expect(r.$("[data-testid='trajectory-brush']")).not.toBeNull();
    expect(r.$("[data-testid='trajectory-brush-clear']")).not.toBeNull();
    expect(points(r)).toBe(3); // lanes already restricted to the window
  });

  it("a drag across the track fires onBrush with the [start,end] window", async () => {
    let got: TrajectoryZoomWindow | null | undefined;
    const r = mount(<TrajectorySwimlane view={view(five())} onBrush={(w) => (got = w)} />);
    await brushDrag(r, 20, 60);
    expect(got).toEqual({ start: 0.2, end: 0.6 });
  });

  it("a click (no drag) fires onBrush(null) — clearing the window", async () => {
    let got: TrajectoryZoomWindow | null | undefined = { start: 0.1, end: 0.9 };
    const r = mount(<TrajectorySwimlane view={view(five())} onBrush={(w) => (got = w)} />);
    await brushDrag(r, 40, 40);
    expect(got).toBeNull();
  });

  it("the clear control fires onBrush(null)", async () => {
    let got: TrajectoryZoomWindow | null | undefined = { start: 0.1, end: 0.9 };
    const r = mount(
      <TrajectorySwimlane view={view(five())} zoom={{ start: 0.1, end: 0.9 }} onBrush={(w) => (got = w)} />,
    );
    await r.act(() => (r.$("[data-testid='trajectory-brush-clear']") as HTMLElement).click());
    expect(got).toBeNull();
  });
});

// ── DOM: the panel wiring lanes + feed to one window ─────────────────────────

describe("TrajectoryPanel (#87) — brushing scopes lanes AND feed together", () => {
  it("starts at the full range: five lanes points, five feed rows", () => {
    const r = mount(<TrajectoryPanel view={view(five())} loading={false} error={null} />);
    expect(points(r)).toBe(5);
    expect(rowSeqs(r)).toEqual([1, 2, 3, 4, 5]);
  });

  it("brushing restricts BOTH the lanes and the feed to the in-window set", async () => {
    const r = mount(<TrajectoryPanel view={view(five())} loading={false} error={null} />);
    // window [0.2, 0.8] → entries at fractions .25/.5/.75 → seq 2, 3, 4
    await brushDrag(r, 20, 80);
    expect(points(r)).toBe(3);
    expect(rowSeqs(r)).toEqual([2, 3, 4]);
  });

  it("clearing restores the full lanes and feed", async () => {
    const r = mount(<TrajectoryPanel view={view(five())} loading={false} error={null} />);
    await brushDrag(r, 20, 80);
    expect(rowSeqs(r)).toEqual([2, 3, 4]);
    await r.act(() => (r.$("[data-testid='trajectory-brush-clear']") as HTMLElement).click());
    expect(points(r)).toBe(5);
    expect(rowSeqs(r)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the zoom window across a simulated SSE view refetch", async () => {
    const r = mount(<TrajectoryPanel view={view(five())} loading={false} error={null} />);
    await brushDrag(r, 20, 80);
    expect(rowSeqs(r)).toEqual([2, 3, 4]);
    // an SSE-driven refetch re-renders the panel with a FRESH (but equal) view;
    // the panel does not remount, so its client-held window survives.
    await r.act(() => {
      r.root.render(<TrajectoryPanel view={view(five())} loading={false} error={null} />);
    });
    expect(points(r)).toBe(3);
    expect(rowSeqs(r)).toEqual([2, 3, 4]);
  });
});
